import { Layer, Line, Text, Group, Circle, Rect } from 'react-konva';
import type { PowerSymbol } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';

interface Props {
  power: PowerSymbol[];
  zoom: number;
}

export function PowerLayer({ power, zoom }: Props): JSX.Element {
  const w = 1.5 / zoom;
  const tool = useDocStore((s) => s.tool);
  const editPage = useDocStore((s) => s.editPage);
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const editing = tool === 'edit';
  return (
    <Layer>
      {power.map((p, i) => {
        const isVcc = p.type === 'VCC' || p.type === '+5V' || p.type === '5V';
        const isGnd = p.type === 'GND' || p.type === '+0V' || p.type === '0V';
        const isSelected = selection?.kind === 'power' && selection.idx === i;
        const stroke = isSelected ? '#2196F3' : '#39ff14';
        const onWireClick = (e: { cancelBubble?: boolean } & object) => {
          (e as { cancelBubble: boolean }).cancelBubble = true;
          if (tool === 'wire') {
            window.dispatchEvent(
              new CustomEvent('kronikarz:wire-endpoint-click', {
                detail: { x: p.x, y: p.y, netName: p.net, autoNet: p.net || p.type },
              }),
            );
            return;
          }
          setSelection({ kind: 'power', idx: i });
        };
        return (
          <Group
            key={i}
            x={p.x}
            y={p.y}
            rotation={p.rotation ?? 0}
            draggable={editing}
            onClick={onWireClick}
            onTap={onWireClick}
            onDragEnd={(e) => {
              const nx = Math.round(e.target.x());
              const ny = Math.round(e.target.y());
              if (nx === p.x && ny === p.y) return;
              const ox = p.x; const oy = p.y;
              editPage((pg) => {
                const ps = pg.power[i];
                if (ps) { ps.x = nx; ps.y = ny; }
                // Translate matching segment endpoints + junctions
                for (const net of Object.values(pg.nets)) {
                  if (net.segments) {
                    for (const seg of net.segments) {
                      for (let endi = 0; endi < 2; endi++) {
                        if (seg[endi * 2] === ox && seg[endi * 2 + 1] === oy) {
                          seg[endi * 2] = nx;
                          seg[endi * 2 + 1] = ny;
                        }
                      }
                    }
                  }
                  if (net.junctions) {
                    for (const j of net.junctions) {
                      if (j[0] === ox && j[1] === oy) { j[0] = nx; j[1] = ny; }
                    }
                  }
                }
              });
            }}
          >
            <Circle x={0} y={0} radius={14} fill="transparent" />
            {isVcc ? (
              <>
                <Line points={[0, 0, 0, -12]} stroke={stroke} strokeWidth={w} listening={false} />
                <Line points={[-4, -8, 0, -12, 4, -8]} stroke={stroke} strokeWidth={w} listening={false} />
                <Text x={-14} y={-28} text={p.type} fontSize={12} fontFamily="IBM Plex Mono" fill={stroke} fontStyle="bold" listening={false} />
              </>
            ) : isGnd ? (
              <>
                {/* Rect tangent to wire endpoint: wire enters left edge, body extends down */}
                <Rect x={-12} y={-4} width={24} height={8} fill={stroke} listening={false} />
              </>
            ) : (
              <Text text={p.type} fontSize={10} fontFamily="IBM Plex Mono" fill={stroke} listening={false} />
            )}
          </Group>
        );
      })}
    </Layer>
  );
}
