import { Layer, Circle, Text } from 'react-konva';
import type { Gate } from '@kronikarz/shared';

interface Props {
  gates: Gate[];
}

export function PinLayer({ gates }: Props): JSX.Element {
  return (
    <Layer listening={false}>
      {gates.flatMap((g, gi) =>
        g.pins.map((p) => (
          <Circle key={`${gi}-${p.num}`} x={p.px} y={p.py} radius={6} fill="#39ff14" />
        )),
      )}
      {gates.flatMap((g, gi) =>
        g.pins.map((p) => {
          // Offset label away from gate body based on which side pin sits on
          let dx = 0;
          let dy = -24;
          if (p.side === 'left') {
            dx = -34;
            dy = -10;
          } else if (p.side === 'right') {
            dx = 10;
            dy = -10;
          } else if (p.side === 'bottom') {
            dy = 8;
          }
          return (
            <Text
              key={`label-${gi}-${p.num}`}
              x={p.px + dx}
              y={p.py + dy}
              text={String(p.num)}
              fontSize={20}
              fontFamily="IBM Plex Mono"
              fill="#FFC107"
              fontStyle="bold"
            />
          );
        }),
      )}
    </Layer>
  );
}
