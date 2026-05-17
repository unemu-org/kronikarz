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
          <Circle
            key={`${gi}-${p.num}`}
            x={p.px}
            y={p.py}
            radius={3}
            fill="#39ff14"
          />
        )),
      )}
      {gates.flatMap((g, gi) =>
        g.pins.map((p) => (
          <Text
            key={`label-${gi}-${p.num}`}
            x={p.px - 8}
            y={p.py - 14}
            text={String(p.num)}
            fontSize={9}
            fontFamily="IBM Plex Mono"
            fill="#8b949e"
          />
        )),
      )}
    </Layer>
  );
}
