import { Layer, Line, Circle } from 'react-konva';
import type Konva from 'konva';
import type { Page } from '@kronikarz/shared';
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
  if (selection.kind === 'segment') return new Set([selection.netName]);
  if (selection.kind === 'gate') {
    const gate = page.gates[selection.idx];
    if (!gate) return new Set();
    return new Set(gate.pins.map((p) => p.net));
  }
  return new Set();
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
    /* ignore */
  }
  return null;
}

export function NetLayer({ page, zoom }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const tool = useDocStore((s) => s.tool);
  const editPage = useDocStore((s) => s.editPage);
  const active = highlightedNets(page, selection);
  const w = 1.5 / zoom;
  const wActive = 3 / zoom;
  const editing = tool === 'edit';

  const onSegmentDrag = (
    netName: string,
    segmentIdx: number,
    endIdx: 0 | 1,
    e: Konva.KonvaEventObject<DragEvent>,
  ) => {
    const nx = e.target.x();
    const ny = e.target.y();
    editPage((p) => {
      const seg = p.nets[netName]?.segments?.[segmentIdx];
      if (!seg) return;
      seg[endIdx * 2] = Math.round(nx);
      seg[endIdx * 2 + 1] = Math.round(ny);
    });
  };

  return (
    <Layer>
      {Object.entries(page.nets).map(([name, net]) => {
        const isActive = active.has(name);
        const color = isActive ? COLOR_ACTIVE : COLOR_NET;
        const selectedSegment =
          selection?.kind === 'segment' && selection.netName === name ? selection.segmentIdx : -1;

        const segments = net.segments ?? [];
        const dashed = net.segments === null;

        // Dashed placeholders connecting pins pairwise
        const placeholders: Array<[number, number, number, number]> = [];
        if (dashed && net.pins.length >= 2) {
          const positions = net.pins
            .map((p) => pinPos(page, p))
            .filter((p): p is { x: number; y: number } => !!p);
          for (let i = 0; i + 1 < positions.length; i++) {
            const a = positions[i]!;
            const b = positions[i + 1]!;
            placeholders.push([a.x, a.y, b.x, b.y]);
          }
        }

        return (
          <>
            {segments.map((s, si) => {
              const selected = selectedSegment === si;
              return (
                <Line
                  key={`${name}-s-${si}`}
                  points={[s[0], s[1], s[2], s[3]]}
                  stroke={selected ? '#2196F3' : color}
                  strokeWidth={selected ? wActive : isActive ? wActive : w}
                  hitStrokeWidth={Math.max(8, w * 4)}
                  onClick={(e) => {
                    e.cancelBubble = true;
                    setSelection({ kind: 'segment', netName: name, segmentIdx: si });
                  }}
                />
              );
            })}
            {placeholders.map((s, i) => (
              <Line
                key={`${name}-p-${i}`}
                points={[s[0], s[1], s[2], s[3]]}
                stroke={dashed ? COLOR_DASH : color}
                strokeWidth={w}
                dash={[6, 4]}
                hitStrokeWidth={Math.max(8, w * 4)}
                onClick={(e) => {
                  e.cancelBubble = true;
                  setSelection({ kind: 'net', name });
                }}
              />
            ))}
            {(net.junctions ?? []).map((j, ji) => (
              <Circle
                key={`${name}-j-${ji}`}
                x={j[0]}
                y={j[1]}
                radius={4}
                fill={color}
                onClick={(e) => {
                  if (editing) {
                    e.cancelBubble = true;
                    editPage((p) => {
                      const js = p.nets[name]?.junctions;
                      if (js) js.splice(ji, 1);
                    });
                  } else {
                    e.cancelBubble = true;
                    setSelection({ kind: 'net', name });
                  }
                }}
              />
            ))}
            {/* Endpoint drag handles for segments of selected net (edit mode) */}
            {editing && isActive &&
              segments.map((s, si) =>
                [0, 1].map((endIdx) => (
                  <Circle
                    key={`${name}-h-${si}-${endIdx}`}
                    x={s[endIdx * 2]!}
                    y={s[endIdx * 2 + 1]!}
                    radius={6 / zoom + 2}
                    fill={selectedSegment === si ? '#2196F3' : '#FF9800'}
                    stroke="#39ff14"
                    strokeWidth={1 / zoom}
                    draggable
                    onDragMove={(e) =>
                      onSegmentDrag(name, si, endIdx as 0 | 1, e)
                    }
                    onClick={(e) => {
                      e.cancelBubble = true;
                      setSelection({ kind: 'segment', netName: name, segmentIdx: si });
                    }}
                  />
                )),
              )}
          </>
        );
      })}
    </Layer>
  );
}
