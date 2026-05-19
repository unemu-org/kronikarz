import { useRef, useState } from 'react';
import { Layer, Rect, Group, Text, Line } from 'react-konva';
import type Konva from 'konva';
import type { Gate } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import type { Selection } from '../store.ts';
import { gateShape, type Shape } from './shapes.ts';
import { gateBox } from './box.ts';

const MIN_W = 30;
const MIN_HH = 30;
const HANDLE = 12;

function selectedGate(sel: Selection): number | null {
  return sel?.kind === 'gate' ? sel.idx : null;
}

interface Props {
  gates: Gate[];
}

export function GateLayer({ gates }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const selectedId = selectedGate(selection);
  return (
    <Layer>
      {gates.map((g, i) => (
        <GateNode key={i} gate={g} idx={i} selected={selectedId === i} />
      ))}
    </Layer>
  );
}

function GateNode({ gate: g, idx: i, selected }: { gate: Gate; idx: number; selected: boolean }): JSX.Element {
  const setSelection = useDocStore((s) => s.setSelection);
  const pkg = useDocStore((s) => s.pkg);
  const icMap = useDocStore((s) => s.icMap);
  const tool = useDocStore((s) => s.tool);
  const editPage = useDocStore((s) => s.editPage);
  const multi = useDocStore((s) => s.multi);
  const toggleMulti = useDocStore((s) => s.toggleMulti);
  const issues = useDocStore((s) => s.issues);
  const gateKey = `${g.ref}${g.gate ? `.${g.gate}` : ''}`;
  const gateIdxKey = `${g.ref}#${i}`;
  const hasError = issues.some((it) => it.level === 'err' && (it.ref === gateKey || it.ref === g.ref || it.ref === gateIdxKey));
  const hasWarn = !hasError && issues.some((it) => it.level === 'warn' && (it.ref === gateKey || it.ref === g.ref || it.ref === gateIdxKey));
  const editing = tool === 'edit';
  const shape = gateShape(g, pkg, icMap);
  const comp = pkg?.components[g.ref];
  const icSuffix = comp && comp.ic ? comp.ic : undefined;
  const isMulti = multi?.kind === 'gate' && multi.indices.includes(i);
  const color =
    (selected || isMulti) ? '#2196F3' :
    hasError ? '#ff3838' :
    hasWarn ? '#ff9800' :
    g.verified ? '#4CAF50' :
    '#FFC107';
  const onSelect = () => setSelection({ kind: 'gate', idx: i });

  const base = gateBox(g);
  const [override, setOverride] = useState<{ w: number; h: number; lox: number; loy: number } | null>(null);
  const box = override ?? { ...base, lox: 0, loy: 0 };

  return (
    <Group
      x={g.x}
      y={g.y}
      rotation={g.rotation}
      draggable={editing}
      onClick={(e) => {
        e.cancelBubble = true;
        if (e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey) {
          toggleMulti('gate', i);
          return;
        }
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
        // Jezeli ta bramka jest w multi-select, przesun caly multi.
        const multiIdx = multi?.kind === 'gate' && multi.indices.includes(i)
          ? multi.indices
          : [i];
        editPage((page) => {
          for (const gi of multiIdx) {
            const target = page.gates[gi];
            if (!target) continue;
            const oldPositions = target.pins.map((p) => ({ px: p.px, py: p.py }));
            target.x += dx;
            target.y += dy;
            target.pins.forEach((p) => { p.px += dx; p.py += dy; });
            for (const net of Object.values(page.nets)) {
              if (!net.segments) continue;
              for (const seg of net.segments) {
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
                    if (j[0] === old.px && j[1] === old.py) { j[0] += dx; j[1] += dy; }
                  }
                }
              }
            }
          }
        });
      }}
    >
      <ShapeBody gate={g} shape={shape} color={color} icSuffix={icSuffix} boxOverride={override} />
      {selected && editing && shape === 'rect' && (
        <ResizeHandles
          w={box.w}
          h={box.h}
          lox={box.lox}
          loy={box.loy}
          onDrag={(w, h, lox, loy) => setOverride({ w, h, lox, loy })}
          onCommit={(w, h, lox, loy) => {
            setOverride(null);
            const rad = (g.rotation * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const sdx = lox * cos - loy * sin;
            const sdy = lox * sin + loy * cos;
            const oldBox = gateBox(g);
            const newCx = Math.round(g.x + sdx);
            const newCy = Math.round(g.y + sdy);
            // Remap each pin to its new edge position (preserving fraction
            // along its side, in unrotated local frame).
            const pinUpdates = g.pins.map((p) => {
              const dxw = p.px - g.x;
              const dyw = p.py - g.y;
              // Inverse-rotate into local frame
              const lx = dxw * cos + dyw * sin;
              const ly = -dxw * sin + dyw * cos;
              let nlx = lx;
              let nly = ly;
              if (p.side === 'left') {
                const f = oldBox.h > 0 ? (ly + oldBox.h / 2) / oldBox.h : 0.5;
                nlx = -w / 2;
                nly = -h / 2 + f * h;
              } else if (p.side === 'right') {
                const f = oldBox.h > 0 ? (ly + oldBox.h / 2) / oldBox.h : 0.5;
                nlx = w / 2;
                nly = -h / 2 + f * h;
              } else if (p.side === 'top') {
                const f = oldBox.w > 0 ? (lx + oldBox.w / 2) / oldBox.w : 0.5;
                nlx = -w / 2 + f * w;
                nly = -h / 2;
              } else if (p.side === 'bottom') {
                const f = oldBox.w > 0 ? (lx + oldBox.w / 2) / oldBox.w : 0.5;
                nlx = -w / 2 + f * w;
                nly = h / 2;
              }
              const npx = Math.round(newCx + nlx * cos - nly * sin);
              const npy = Math.round(newCy + nlx * sin + nly * cos);
              return { oldPx: p.px, oldPy: p.py, npx, npy };
            });
            editPage((page) => {
              const t = page.gates[i];
              if (!t) return;
              t.w = w;
              t.h = h;
              t.x = newCx;
              t.y = newCy;
              t.pins.forEach((p, pi) => {
                const u = pinUpdates[pi];
                if (!u) return;
                p.px = u.npx;
                p.py = u.npy;
              });
              // Translate matching net segment endpoints + junctions
              for (const net of Object.values(page.nets)) {
                if (net.segments) {
                  for (const seg of net.segments) {
                    for (let endi = 0; endi < 2; endi++) {
                      const ex = seg[endi * 2]!;
                      const ey = seg[endi * 2 + 1]!;
                      for (const u of pinUpdates) {
                        if (ex === u.oldPx && ey === u.oldPy) {
                          seg[endi * 2] = u.npx;
                          seg[endi * 2 + 1] = u.npy;
                        }
                      }
                    }
                  }
                }
                if (net.junctions) {
                  for (const j of net.junctions) {
                    for (const u of pinUpdates) {
                      if (j[0] === u.oldPx && j[1] === u.oldPy) {
                        j[0] = u.npx;
                        j[1] = u.npy;
                      }
                    }
                  }
                }
              }
            });
          }}
        />
      )}
    </Group>
  );
}

function ResizeHandles({
  w, h, lox, loy, onDrag, onCommit,
}: {
  w: number; h: number; lox: number; loy: number;
  onDrag: (w: number, h: number, lox: number, loy: number) => void;
  onCommit: (w: number, h: number, lox: number, loy: number) => void;
}): JSX.Element {
  const anchorRef = useRef<{ ax: number | null; ay: number | null } | null>(null);

  type Dir = 'br' | 'r' | 'b' | 'tr' | 't' | 'tl' | 'l' | 'bl';
  const handles: Array<{ x: number; y: number; dir: Dir }> = [
    { x: lox + w / 2, y: loy + h / 2, dir: 'br' },
    { x: lox + w / 2, y: loy, dir: 'r' },
    { x: lox, y: loy + h / 2, dir: 'b' },
    { x: lox + w / 2, y: loy - h / 2, dir: 'tr' },
    { x: lox, y: loy - h / 2, dir: 't' },
    { x: lox - w / 2, y: loy - h / 2, dir: 'tl' },
    { x: lox - w / 2, y: loy, dir: 'l' },
    { x: lox - w / 2, y: loy + h / 2, dir: 'bl' },
  ];

  function captureAnchor(dir: Dir): void {
    // anchor = opposite edge in local coords. null = axis unchanged
    let ax: number | null = null;
    let ay: number | null = null;
    if (dir.includes('r')) ax = lox - w / 2;
    else if (dir.includes('l')) ax = lox + w / 2;
    if (dir.includes('b')) ay = loy - h / 2;
    else if (dir.includes('t')) ay = loy + h / 2;
    anchorRef.current = { ax, ay };
  }

  function compute(hx: number, hy: number): { w: number; h: number; lox: number; loy: number } {
    const a = anchorRef.current;
    let nw = w;
    let nh = h;
    let nlox = lox;
    let nloy = loy;
    if (a?.ax !== null && a?.ax !== undefined) {
      const left = Math.min(a.ax, hx);
      const right = Math.max(a.ax, hx);
      nw = Math.max(MIN_W, right - left);
      // recompute respecting min: clamp far edge near anchor
      if (right - left < MIN_W) {
        if (hx < a.ax) nlox = a.ax - MIN_W / 2;
        else nlox = a.ax + MIN_W / 2;
      } else {
        nlox = (left + right) / 2;
      }
    }
    if (a?.ay !== null && a?.ay !== undefined) {
      const top = Math.min(a.ay, hy);
      const bot = Math.max(a.ay, hy);
      nh = Math.max(MIN_HH, bot - top);
      if (bot - top < MIN_HH) {
        if (hy < a.ay) nloy = a.ay - MIN_HH / 2;
        else nloy = a.ay + MIN_HH / 2;
      } else {
        nloy = (top + bot) / 2;
      }
    }
    return { w: Math.round(nw), h: Math.round(nh), lox: Math.round(nlox), loy: Math.round(nloy) };
  }

  return (
    <>
      {handles.map((hd) => (
        <Rect
          key={hd.dir}
          x={hd.x - HANDLE / 2}
          y={hd.y - HANDLE / 2}
          width={HANDLE}
          height={HANDLE}
          fill="#2196F3"
          stroke="#fff"
          strokeWidth={1}
          draggable
          onMouseDown={(e) => { e.cancelBubble = true; }}
          onDragStart={(e) => {
            e.cancelBubble = true;
            captureAnchor(hd.dir);
          }}
          onDragMove={(e: Konva.KonvaEventObject<DragEvent>) => {
            e.cancelBubble = true;
            const node = e.target;
            const hx = node.x() + HANDLE / 2;
            const hy = node.y() + HANDLE / 2;
            const r = compute(hx, hy);
            onDrag(r.w, r.h, r.lox, r.loy);
          }}
          onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => {
            e.cancelBubble = true;
            const node = e.target;
            const hx = node.x() + HANDLE / 2;
            const hy = node.y() + HANDLE / 2;
            const r = compute(hx, hy);
            anchorRef.current = null;
            onCommit(r.w, r.h, r.lox, r.loy);
          }}
        />
      ))}
    </>
  );
}

interface BodyProps {
  gate: Gate;
  shape: Shape;
  color: string;
  icSuffix?: string | number;
  boxOverride?: { w: number; h: number; lox: number; loy: number } | null;
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

function ShapeBody({ gate, shape, color, icSuffix, boxOverride }: BodyProps): JSX.Element {
  const { w, h } = boxOverride ?? gateBox(gate);
  const lox = boxOverride?.lox ?? 0;
  const loy = boxOverride?.loy ?? 0;
  let body: JSX.Element;
  switch (shape) {
    case 'resistor':
      body = <ResistorShape color={color} value={gate.value} />;
      break;
    case 'capacitor':
      body = <CapacitorShape color={color} polarized={false} value={gate.value} />;
      break;
    case 'capacitor_polarized':
      body = <CapacitorShape color={color} polarized value={gate.value} />;
      break;
    case 'triangle':
      body = <TriangleShape gate={gate} color={color} w={w} h={h} icSuffix={icSuffix} />;
      break;
    case 'flipflop':
      body = <FlipFlopShape gate={gate} color={color} w={w + 20} h={h} />;
      break;
    case 'rect':
    default:
      body = <RectShape gate={gate} color={color} w={w} h={h} icSuffix={icSuffix} />;
  }
  return <Group x={lox} y={loy}>{body}</Group>;
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
