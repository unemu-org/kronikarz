import { Layer, Line, Rect, Ellipse, Group } from 'react-konva';
import type Konva from 'konva';
import type { Decoration } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';

interface Props {
  decorations: Decoration[];
  zoom: number;
}

const DEFAULT_COLOR = '#e0e0e0';
const SELECTED = '#2196F3';

export function DecorationLayer({ decorations, zoom }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const editPage = useDocStore((s) => s.editPage);
  const tool = useDocStore((s) => s.tool);
  const editing = tool === 'edit';
  return (
    <Layer>
      {decorations.map((d, i) => {
        const isSelected = selection?.kind === 'decoration' && selection.idx === i;
        const stroke = isSelected ? SELECTED : d.color ?? DEFAULT_COLOR;
        const thickness = d.thickness ?? 2;
        const onSelect = (e: Konva.KonvaEventObject<MouseEvent>) => {
          e.cancelBubble = true;
          setSelection({ kind: 'decoration', idx: i });
        };
        const onDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
          const ndx = Math.round(e.target.x());
          const ndy = Math.round(e.target.y());
          if (ndx === 0 && ndy === 0) return;
          editPage((p) => {
            const dec = p.decorations?.[i];
            if (!dec) return;
            if (dec.kind === 'line') {
              dec.x1 += ndx; dec.y1 += ndy;
              dec.x2 += ndx; dec.y2 += ndy;
            } else {
              dec.x += ndx; dec.y += ndy;
            }
          });
          e.target.x(0);
          e.target.y(0);
        };
        if (d.kind === 'line') {
          return (
            <Group key={i} draggable={editing} onClick={onSelect} onTap={() => setSelection({ kind: 'decoration', idx: i })} onDragEnd={onDragEnd}>
              <Line
                points={[d.x1, d.y1, d.x2, d.y2]}
                stroke={stroke}
                strokeWidth={thickness}
                hitStrokeWidth={Math.max(8, thickness * 3)}
              />
            </Group>
          );
        }
        if (d.kind === 'rect') {
          return (
            <Group key={i} draggable={editing} onClick={onSelect} onTap={() => setSelection({ kind: 'decoration', idx: i })} onDragEnd={onDragEnd}>
              <Rect
                x={d.x}
                y={d.y}
                width={d.w}
                height={d.h}
                stroke={stroke}
                strokeWidth={thickness}
                fill="transparent"
              />
            </Group>
          );
        }
        // ellipse
        return (
          <Group key={i} draggable={editing} onClick={onSelect} onTap={() => setSelection({ kind: 'decoration', idx: i })} onDragEnd={onDragEnd}>
            <Ellipse
              x={d.x}
              y={d.y}
              radiusX={d.rx}
              radiusY={d.ry}
              stroke={stroke}
              strokeWidth={thickness}
              fill="transparent"
            />
          </Group>
        );
      })}
    </Layer>
  );
}
