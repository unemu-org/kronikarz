import { Layer, Rect, Group, Text, Line, Circle } from 'react-konva';
import type { Gate } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import type { Selection } from '../store.ts';
import { gateShape, type Shape } from './shapes.ts';

const GATE_W = 60;
const GATE_H_PER_PIN = 16;
const MIN_H = 60;

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
  const selectedId = selectedGate(selection);

  return (
    <Layer>
      {gates.map((g, i) => {
        const shape = gateShape(g, pkg, icMap);
        const selected = selectedId === i;
        const color = selected ? '#2196F3' : g.verified ? '#4CAF50' : '#FFC107';
        const onSelect = () => setSelection({ kind: 'gate', idx: i });
        return (
          <Group
            key={i}
            x={g.x}
            y={g.y}
            rotation={g.rotation}
            onClick={(e) => {
              e.cancelBubble = true;
              onSelect();
            }}
            onTap={onSelect}
          >
            <ShapeBody gate={g} shape={shape} color={color} />
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
}

function ShapeBody({ gate, shape, color }: BodyProps): JSX.Element {
  const { w, h } = gateBox(gate);
  switch (shape) {
    case 'resistor':
      return <ResistorShape color={color} value={gate.value} />;
    case 'capacitor':
      return <CapacitorShape color={color} polarized={false} value={gate.value} />;
    case 'capacitor_polarized':
      return <CapacitorShape color={color} polarized value={gate.value} />;
    case 'triangle':
      return <TriangleShape gate={gate} color={color} w={w} h={h} />;
    case 'flipflop':
      return <FlipFlopShape gate={gate} color={color} w={w + 20} h={h} />;
    case 'rect':
    default:
      return <RectShape gate={gate} color={color} w={w} h={h} />;
  }
}

function RectShape({ gate, color, w, h }: { gate: Gate; color: string; w: number; h: number }) {
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
      <Text
        x={-w / 2}
        y={-h / 2 - 14}
        width={w}
        align="center"
        text={gate.ref}
        fontSize={12}
        fontFamily="IBM Plex Mono"
        fill="#39ff14"
      />
      {gate.gate && (
        <Text
          x={-w / 2}
          y={-6}
          width={w}
          align="center"
          text={gate.gate}
          fontSize={14}
          fontFamily="IBM Plex Mono"
          fill={color}
        />
      )}
      {gate.label_left && (
        <Text x={-w / 2 - 2} y={h / 2 + 2} text={gate.label_left} fontSize={10} fontFamily="IBM Plex Mono" fill="#8b949e" />
      )}
      {gate.label_right && (
        <Text x={w / 2 - 12} y={h / 2 + 2} text={gate.label_right} fontSize={10} fontFamily="IBM Plex Mono" fill="#8b949e" />
      )}
    </>
  );
}

function TriangleShape({ gate, color, w, h }: { gate: Gate; color: string; w: number; h: number }) {
  // Triangle pointing right (rotation handled by Group)
  const pts = [-w / 2, -h / 2, w / 2, 0, -w / 2, h / 2];
  return (
    <>
      <Line points={pts} closed stroke={color} strokeWidth={2} fill="rgba(13,17,23,0.7)" />
      <Text
        x={-w / 2}
        y={-h / 2 - 14}
        width={w}
        align="center"
        text={gate.ref}
        fontSize={11}
        fontFamily="IBM Plex Mono"
        fill="#39ff14"
      />
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
        fontSize={11}
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
        <Text x={-12} y={-18} text="+" fontSize={11} fontFamily="IBM Plex Mono" fill={color} />
      )}
      {value && (
        <Text x={-20} y={12} text={value} fontSize={10} fontFamily="IBM Plex Mono" fill="#39ff14" />
      )}
    </>
  );
}
