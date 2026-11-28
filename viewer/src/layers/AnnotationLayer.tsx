import { Layer, Text, Rect, Group } from 'react-konva';
import type Konva from 'konva';
import type { Annotation } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import { useStepView } from './stepLook.ts';

interface Props {
  annotations: Annotation[];
  zoom: number;
}

const COLOR = '#e0e0e0';
const SELECTED = '#2196F3';

export function AnnotationLayer({ annotations, zoom }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const editPage = useDocStore((s) => s.editPage);
  const tool = useDocStore((s) => s.tool);
  const editing = tool === 'edit';
  const sv = useStepView();
  const look = sv.look('decor');
  return (
    <Layer visible={look.visible} opacity={look.opacity} listening={look.listening}>
      {annotations.map((a, i) => {
        const isSelected = selection?.kind === 'annotation' && selection.idx === i;
        const fontSize = a.fontSize ?? 20;
        const padding = 4;
        const textStr = a.text ?? '';
        const estW = Math.max(40, textStr.length * (fontSize * 0.6));
        const rotation = a.rotation ?? 0;
        // Hit-area bounding box w world coords po rotacji wokol (a.x, a.y)
        // Konva text rotuje wokol (x,y) ktore jest top-left. Dla 0: x..x+estW, y..y+fontSize.
        // 90 cw: x..x+fontSize wzgledem osi staje sie y..y+fontSize? Faktycznie 90 cw text
        // schodzi w dol-lewo. Latwiej: oblicz roboczo 4 narozniki, weź bbox.
        const rad = (rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const corners = [
          { lx: 0, ly: 0 },
          { lx: estW, ly: 0 },
          { lx: estW, ly: fontSize },
          { lx: 0, ly: fontSize },
        ].map(({ lx, ly }) => ({
          x: a.x + lx * cos - ly * sin,
          y: a.y + lx * sin + ly * cos,
        }));
        const minX = Math.min(...corners.map((c) => c.x));
        const maxX = Math.max(...corners.map((c) => c.x));
        const minY = Math.min(...corners.map((c) => c.y));
        const maxY = Math.max(...corners.map((c) => c.y));
        return (
          <Group
            key={i}
            x={0}
            y={0}
            draggable={editing}
            onClick={(e) => {
              e.cancelBubble = true;
              setSelection({ kind: 'annotation', idx: i });
            }}
            onTap={() => setSelection({ kind: 'annotation', idx: i })}
            onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => {
              const ndx = Math.round(e.target.x());
              const ndy = Math.round(e.target.y());
              if (ndx === 0 && ndy === 0) return;
              editPage((p) => {
                const an = p.annotations?.[i];
                if (an) {
                  an.x += ndx;
                  an.y += ndy;
                }
              });
              e.target.x(0);
              e.target.y(0);
            }}
          >
            {isSelected && (
              <Rect
                x={minX - padding}
                y={minY - padding}
                width={(maxX - minX) + padding * 2}
                height={(maxY - minY) + padding * 2}
                stroke={SELECTED}
                strokeWidth={2 / zoom}
                dash={[4 / zoom, 4 / zoom]}
                fill="transparent"
              />
            )}
            <Rect
              x={minX - padding}
              y={minY - padding}
              width={(maxX - minX) + padding * 2}
              height={(maxY - minY) + padding * 2}
              fill="transparent"
            />
            <Text
              x={a.x}
              y={a.y}
              text={textStr}
              rotation={rotation}
              fontSize={fontSize}
              fontFamily="IBM Plex Mono"
              fill={isSelected ? SELECTED : COLOR}
              listening={false}
            />
          </Group>
        );
      })}
    </Layer>
  );
}
