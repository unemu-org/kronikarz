import { Layer, Rect, Group, Text, Line } from 'react-konva';
import type { Gate, Package, IcMap } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import type { Selection } from '../store.ts';
import { gateShape, type Shape } from './shapes.ts';

const GATE_W = 80;
const GATE_H_PER_PIN = 22;
const MIN_H = 90;

function gateBox(g: Gate): { w: number; h: number } {
  const leftPins = g.pins.filter((p) => p.side === 'left').length;
  const rightPins = g.pins.filter((p) => p.side === 'right').length;
  const maxSide = Math.max(leftPins, rightPins, 1);
  return { w: GATE_W, h: Math.max(MIN_H, maxSide * GATE_H_PER_PIN + 20) };
}

function selectedGate(sel: Selection): number | null {
  return sel?.kind === 'gate' ? sel.idx : null;
}

interface Props {
  gates: Gate[];
}

export function GateLayer({ gates }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const pkg = useDocStore((s) => s.pkg);
  const icMap = useDocStore((s) => s.icMap);
  const tool = useDocStore((s) => s.tool);
  const editPage = useDocStore((s) => s.editPage);
  const selectedId = selectedGate(selection);
  const editing = tool === 'edit';

  return (
    <Layer>
      {gates.map((g, i) => {
        const shape = gateShape(g, pkg, icMap);
        const comp = pkg?.components[g.ref];
        const icSuffix = comp && comp.ic ? comp.ic : undefined;
        const selected = selectedId === i;
        const color = selected ? '#2196F3' : g.verified ? '#4CAF50' : '#FFC107';
        const onSelect = () => setSelection({ kind: 'gate', idx: i });
        return (
          <Group
            key={i}
            x={g.x}
            y={g.y}
            rotation={g.rotation}
            draggable={editing}
            onClick={(e) => {
              e.cancelBubble = true;
              onSelect();
            }}
            onTap={onSelect}
            onDragStart={() => onSelect()}
            onDragEnd={(e) => {
              const nx = e.target.x();
              const ny = e.target.y();
              const dx = nx - g.x;
              const dy = ny - g.y;
              if (dx === 0 && dy === 0) return;
              editPage((page) => {
                const target = page.gates[i];
                if (!target) return;
                const oldPositions = target.pins.map((p) => ({ px: p.px, py: p.py }));
                target.x = nx;
                target.y = ny;
                target.pins.forEach((p, pi) => {
                  p.px += dx;
                  p.py += dy;
                });
                // Translate net segment endpoints that exactly matched old pin positions
                for (const net of Object.values(page.nets)) {
                  if (!net.segments) continue;
                  for (let si = 0; si < net.segments.length; si++) {
                    const seg = net.segments[si]!;
                    for (let endi = 0; endi < 2; endi++) {
                      const ex = seg[endi * 2]!;
                      const ey = seg[endi * 2 + 1]!;
                      for (const old of oldPositions) {
                        if (ex === old.px && ey === old.py) {
                          seg[endi * 2] = ex + dx;
                          seg[endi * 2 + 1] = ey + dy;
                        }
                      }
                    }
                  }
                  if (net.junctions) {
                    for (const j of net.junctions) {
                      for (const old of oldPositions) {
                        if (j[0] === old.px && j[1] === old.py) {
                          j[0] += dx;
                          j[1] += dy;
                        }
                      }
                    }
                  }
                }
              });
            }}
          >
            <ShapeBody gate={g} shape={shape} color={color} icSuffix={icSuffix} />
          </Group>
        );
      })}
    </Layer>
  );
}

interface BodyProps {
  gate: Gate;
  shape: Shape;
  color: string;
  icSuffix?: string | number;
}

// Polish DTR symbols inside a gate box (per IEC 60617 used in the era):
//   &   for AND / NAND (NAND has negation circle on output)
//   ≥1  for OR / NOR
//   =1  for XOR
//   1   for inverter / buffer
//   T   for D flip-flop
function gateSymbol(icSuffix?: string | number): string | null {
  if (icSuffix === undefined || icSuffix === null) return null;
  const s = String(icSuffix).replace(/^(SN)?7?4?(LS|HC|HCT|ALS|AS|H|S|F)?/, '').toUpperCase();
  if (['00', '08', '10', '20', '30', '40'].includes(s)) return '&';
  if (['02', '27', '28', '32', '33'].includes(s)) return '≥1';
  if (['86', '266'].includes(s)) return '=1';
  if (['04', '05', '06', '07', '14', '16', '17'].includes(s)) return '1';
  if (['74', '174', '175', '273', '374'].includes(s)) return 'T';
  return null;
}

function ShapeBody({ gate, shape, color, icSuffix }: BodyProps): JSX.Element {
  const { w, h } = gateBox(gate);
  switch (shape) {
    case 'resistor':
      return <ResistorShape color={color} value={gate.value} />;
    case 'capacitor':
      return <CapacitorShape color={color} polarized={false} value={gate.value} />;
    case 'capacitor_polarized':
      return <CapacitorShape color={color} polarized value={gate.value} />;
    case 'triangle':
      return <TriangleShape gate={gate} color={color} w={w} h={h} icSuffix={icSuffix} />;
    case 'flipflop':
      return <FlipFlopShape gate={gate} color={color} w={w + 20} h={h} />;
    case 'rect':
    default:
      return <RectShape gate={gate} color={color} w={w} h={h} icSuffix={icSuffix} />;
  }
}

function RectShape({
  gate,
  color,
  w,
  h,
  icSuffix,
}: {
  gate: Gate;
  color: string;
  w: number;
  h: number;
  icSuffix?: string | number;
}) {
  const symbol = gateSymbol(icSuffix);
  return (
    <>
      <Rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        stroke={color}
        strokeWidth={2}
        fill="rgba(13,17,23,0.7)"
      />
      {/* Top-left stack: gate function symbol over IC suffix */}
      {symbol && (
        <Text
          x={-w / 2 + 6}
          y={-h / 2 + 4}
          text={symbol}
          fontSize={18}
          fontFamily="IBM Plex Mono"
          fill={color}
          fontStyle="bold"
        />
      )}
      {icSuffix && (
        <Text
          x={-w / 2 + 6}
          y={-h / 2 + 26}
          text={String(icSuffix)}
          fontSize={18}
          fontFamily="IBM Plex Mono"
          fill={color}
        />
      )}
      {/* Gate letter (A/B/C…) top-right */}
      {gate.gate && (
        <Text
          x={w / 2 - 16}
          y={-h / 2 + 4}
          text={gate.gate}
          fontSize={18}
          fontFamily="IBM Plex Mono"
          fill={color}
        />
      )}
      {/* ref centered at bottom */}
      <Text
        x={-w / 2}
        y={h / 2 - 22}
        width={w}
        align="center"
        text={gate.ref}
        fontSize={18}
        fontFamily="IBM Plex Mono"
        fill={color}
        fontStyle="bold"
      />
      {gate.label_left && (
        <Text
          x={-w / 2 - 14}
          y={-6}
          text={gate.label_left}
          fontSize={9}
          fontFamily="IBM Plex Mono"
          fill="#8b949e"
        />
      )}
      {gate.label_right && (
        <Text
          x={w / 2 + 4}
          y={-6}
          text={gate.label_right}
          fontSize={9}
          fontFamily="IBM Plex Mono"
          fill="#8b949e"
        />
      )}
    </>
  );
}

function TriangleShape({
  gate,
  color,
  w,
  h,
  icSuffix,
}: {
  gate: Gate;
  color: string;
  w: number;
  h: number;
  icSuffix?: string | number;
}) {
  const pts = [-w / 2, -h / 2, w / 2, 0, -w / 2, h / 2];
  return (
    <>
      <Line points={pts} closed stroke={color} strokeWidth={2} fill="rgba(13,17,23,0.7)" />
      <Text
        x={-w / 2 + 4}
        y={-6}
        text={gate.ref}
        fontSize={10}
        fontFamily="IBM Plex Mono"
        fill="#39ff14"
        fontStyle="bold"
      />
      {icSuffix && (
        <Text
          x={-w / 2 + 4}
          y={5}
          text={String(icSuffix)}
          fontSize={8}
          fontFamily="IBM Plex Mono"
          fill="#8b949e"
        />
      )}
    </>
  );
}

function FlipFlopShape({ gate, color, w, h }: { gate: Gate; color: string; w: number; h: number }) {
  return (
    <>
      <Rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        stroke={color}
        strokeWidth={2}
        fill="rgba(13,17,23,0.7)"
        cornerRadius={4}
      />
      <Text
        x={-w / 2}
        y={-h / 2 - 14}
        width={w}
        align="center"
        text={`${gate.ref}${gate.gate ? `.${gate.gate}` : ''}`}
        fontSize={18}
        fontFamily="IBM Plex Mono"
        fill="#39ff14"
      />
      <Text x={-w / 2 + 4} y={-h / 2 + 4} text="FF" fontSize={9} fontFamily="IBM Plex Mono" fill={color} />
    </>
  );
}

function ResistorShape({ color, value }: { color: string; value?: string }) {
  // Horizontal zig-zag style — width 40, height 16
  const W = 40;
  const H = 8;
  return (
    <>
      <Rect x={-W / 2} y={-H / 2} width={W} height={H} stroke={color} strokeWidth={2} fill="rgba(13,17,23,0.7)" />
      <Line points={[-W, 0, -W / 2, 0]} stroke={color} strokeWidth={1.5} />
      <Line points={[W / 2, 0, W, 0]} stroke={color} strokeWidth={1.5} />
      {value && (
        <Text x={-20} y={H} text={value} fontSize={10} fontFamily="IBM Plex Mono" fill="#39ff14" />
      )}
    </>
  );
}

function CapacitorShape({
  color,
  polarized,
  value,
}: {
  color: string;
  polarized: boolean;
  value?: string;
}) {
  // Two parallel plates, perpendicular to leads. Default horizontal.
  return (
    <>
      <Line points={[-3, -10, -3, 10]} stroke={color} strokeWidth={2.5} />
      {polarized ? (
        <Line
          points={[3, -10, 6, -8, 8, -4, 9, 0, 8, 4, 6, 8, 3, 10]}
          stroke={color}
          strokeWidth={2.5}
          tension={0.4}
        />
      ) : (
        <Line points={[3, -10, 3, 10]} stroke={color} strokeWidth={2.5} />
      )}
      <Line points={[-15, 0, -3, 0]} stroke={color} strokeWidth={1.5} />
      <Line points={[3, 0, 15, 0]} stroke={color} strokeWidth={1.5} />
      {polarized && (
        <Text x={-12} y={-18} text="+" fontSize={18} fontFamily="IBM Plex Mono" fill={color} />
      )}
      {value && (
        <Text x={-20} y={12} text={value} fontSize={10} fontFamily="IBM Plex Mono" fill="#39ff14" />
      )}
    </>
  );
}
