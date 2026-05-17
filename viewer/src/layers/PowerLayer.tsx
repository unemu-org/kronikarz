import { Layer, Line, Text, Group } from 'react-konva';
import type { PowerSymbol } from '@kronikarz/shared';

interface Props {
  power: PowerSymbol[];
  zoom: number;
}

export function PowerLayer({ power, zoom }: Props): JSX.Element {
  const w = 1.5 / zoom;
  return (
    <Layer listening={false}>
      {power.map((p, i) => (
        <Group key={i} x={p.x} y={p.y}>
          {p.type === 'VCC' ? (
            <>
              {/* arrow up */}
              <Line points={[0, 0, 0, -12]} stroke="#39ff14" strokeWidth={w} />
              <Line points={[-4, -8, 0, -12, 4, -8]} stroke="#39ff14" strokeWidth={w} />
              <Text x={-10} y={-26} text="VCC" fontSize={9} fontFamily="IBM Plex Mono" fill="#39ff14" />
            </>
          ) : p.type === 'GND' ? (
            <>
              {/* three descending lines */}
              <Line points={[-8, 0, 8, 0]} stroke="#39ff14" strokeWidth={w} />
              <Line points={[-5, 4, 5, 4]} stroke="#39ff14" strokeWidth={w} />
              <Line points={[-2, 8, 2, 8]} stroke="#39ff14" strokeWidth={w} />
              <Text x={-8} y={12} text="GND" fontSize={9} fontFamily="IBM Plex Mono" fill="#39ff14" />
            </>
          ) : (
            <Text text={p.type} fontSize={10} fontFamily="IBM Plex Mono" fill="#39ff14" />
          )}
        </Group>
      ))}
    </Layer>
  );
}
