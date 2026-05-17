import { Layer, Line, Circle } from 'react-konva';
import type { Page, Net } from '@kronikarz/shared';
import { parsePinId } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';

const COLOR_NET = '#666666';
const COLOR_ACTIVE = '#FF9800';
const COLOR_DASH = '#39ff1455';

interface Props {
  page: Page;
  zoom: number;
}

function highlightedNets(page: Page, selection: ReturnType<typeof useDocStore.getState>['selection']): Set<string> {
  if (!selection) return new Set();
  if (selection.kind === 'net') return new Set([selection.name]);
  // gate selected → all nets touching any of its pins
  const gate = page.gates[selection.idx];
  if (!gate) return new Set();
  return new Set(gate.pins.map((p) => p.net));
}

function pinPos(page: Page, pinIdStr: string): { x: number; y: number } | null {
  try {
    const { ref, gate, num } = parsePinId(pinIdStr);
    for (const g of page.gates) {
      if (g.ref !== ref) continue;
      if (gate !== null && g.gate !== gate) continue;
      const pin = g.pins.find((p) => p.num === num);
      if (pin) return { x: pin.px, y: pin.py };
    }
  } catch {
    /* ignore malformed */
  }
  return null;
}

export function NetLayer({ page, zoom }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const active = highlightedNets(page, selection);
  const w = 1.5 / zoom;
  const wActive = 3 / zoom;

  return (
    <Layer>
      {Object.entries(page.nets).map(([name, net]) => {
        const isActive = active.has(name);
        const color = isActive ? COLOR_ACTIVE : COLOR_NET;

        // Real segments
        const segments = net.segments ?? [];
        const dashed = net.segments === null;

        // Dashed placeholder lines connecting pins pairwise
        const placeholderLines: Array<[number, number, number, number]> = [];
        if (dashed && net.pins.length >= 2) {
          const positions = net.pins.map((p) => pinPos(page, p)).filter((p): p is { x: number; y: number } => !!p);
          for (let i = 0; i + 1 < positions.length; i++) {
            const a = positions[i]!;
            const b = positions[i + 1]!;
            placeholderLines.push([a.x, a.y, b.x, b.y]);
          }
        }

        return (
          <NetGroup
            key={name}
            name={name}
            segments={segments}
            placeholders={placeholderLines}
            junctions={net.junctions ?? []}
            color={color}
            strokeWidth={isActive ? wActive : w}
            dashed={dashed}
            onSelect={() => setSelection({ kind: 'net', name })}
            isActive={isActive}
          />
        );
      })}
    </Layer>
  );
}

interface NetGroupProps {
  name: string;
  segments: Array<[number, number, number, number]>;
  placeholders: Array<[number, number, number, number]>;
  junctions: Array<[number, number]>;
  color: string;
  strokeWidth: number;
  dashed: boolean;
  onSelect: () => void;
  isActive: boolean;
}

function NetGroup({
  segments,
  placeholders,
  junctions,
  color,
  strokeWidth,
  dashed,
  onSelect,
}: NetGroupProps): JSX.Element {
  const hitWidth = Math.max(8, strokeWidth * 4);
  return (
    <>
      {segments.map((s, i) => (
        <Line
          key={`s-${i}`}
          points={[s[0], s[1], s[2], s[3]]}
          stroke={color}
          strokeWidth={strokeWidth}
          hitStrokeWidth={hitWidth}
          onClick={(e) => {
            e.cancelBubble = true;
            onSelect();
          }}
        />
      ))}
      {placeholders.map((s, i) => (
        <Line
          key={`p-${i}`}
          points={[s[0], s[1], s[2], s[3]]}
          stroke={dashed ? COLOR_DASH : color}
          strokeWidth={strokeWidth}
          dash={[6, 4]}
          hitStrokeWidth={hitWidth}
          onClick={(e) => {
            e.cancelBubble = true;
            onSelect();
          }}
          listening={true}
        />
      ))}
      {junctions.map((j, i) => (
        <Circle key={`j-${i}`} x={j[0]} y={j[1]} radius={3} fill={color} />
      ))}
    </>
  );
}
