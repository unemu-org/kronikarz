import { Layer, Rect, Group, Text } from 'react-konva';
import type { Gate } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import type { Selection } from '../store.ts';

const GATE_W = 60;
const GATE_H_PER_PIN = 16;
const MIN_H = 60;

function gateBox(g: Gate): { w: number; h: number } {
  const leftPins = g.pins.filter((p) => p.side === 'left').length;
  const rightPins = g.pins.filter((p) => p.side === 'right').length;
  const maxSide = Math.max(leftPins, rightPins, 1);
  return { w: GATE_W, h: Math.max(MIN_H, maxSide * GATE_H_PER_PIN + 20) };
}

interface Props {
  gates: Gate[];
}

function selectedGate(sel: Selection): number | null {
  return sel?.kind === 'gate' ? sel.idx : null;
}

export function GateLayer({ gates }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const selectedId = selectedGate(selection);
  return (
    <Layer>
      {gates.map((g, i) => {
        const { w, h } = gateBox(g);
        const selected = selectedId === i;
        const color = selected
          ? '#2196F3'
          : g.verified
            ? '#4CAF50'
            : '#FFC107';
        return (
          <Group
            key={i}
            x={g.x}
            y={g.y}
            rotation={g.rotation}
            onClick={(e) => {
              e.cancelBubble = true;
              setSelection({ kind: 'gate', idx: i });
            }}
            onTap={() => setSelection({ kind: 'gate', idx: i })}
          >
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
              text={g.ref}
              fontSize={12}
              fontFamily="IBM Plex Mono"
              fill="#39ff14"
            />
            {g.gate && (
              <Text
                x={-w / 2}
                y={-6}
                width={w}
                align="center"
                text={g.gate}
                fontSize={14}
                fontFamily="IBM Plex Mono"
                fill={color}
              />
            )}
            {g.label_left && (
              <Text
                x={-w / 2 - 2}
                y={h / 2 + 2}
                text={g.label_left}
                fontSize={10}
                fontFamily="IBM Plex Mono"
                fill="#8b949e"
              />
            )}
            {g.label_right && (
              <Text
                x={w / 2 - 12}
                y={h / 2 + 2}
                text={g.label_right}
                fontSize={10}
                fontFamily="IBM Plex Mono"
                fill="#8b949e"
              />
            )}
          </Group>
        );
      })}
    </Layer>
  );
}
