import { Layer, Line, Text, Group } from 'react-konva';
import type { Page } from '@kronikarz/shared';

interface Props {
  page: Page;
  zoom: number;
}

// Cross-page arrows at pins with a `cross` reference.
// Triangle pointing away from gate + label.
export function CrossPageLayer({ page, zoom }: Props): JSX.Element {
  const w = 1.5 / zoom;
  return (
    <Layer listening={false}>
      {page.gates.flatMap((g, gi) =>
        g.pins
          .filter((p) => p.cross)
          .map((p) => {
            const dir = p.side === 'right' ? 1 : p.side === 'left' ? -1 : 0;
            const dy = p.side === 'top' ? -1 : p.side === 'bottom' ? 1 : 0;
            const size = 8;
            const tx = p.px + dir * size * 2;
            const ty = p.py + dy * size * 2;
            return (
              <Group key={`${gi}-${p.num}`}>
                <Line
                  points={[p.px, p.py, tx, ty]}
                  stroke="#FFC107"
                  strokeWidth={w}
                />
                <Line
                  points={[
                    tx,
                    ty,
                    tx - dir * size,
                    ty - dy * size - (dir !== 0 ? size / 2 : 0),
                    tx - dir * size,
                    ty - dy * size + (dir !== 0 ? size / 2 : 0),
                    tx,
                    ty,
                  ]}
                  closed
                  stroke="#FFC107"
                  fill="#FFC10733"
                  strokeWidth={w}
                />
                <Text
                  x={tx + dir * 4 - (dir === -1 ? 30 : 0)}
                  y={ty - 5}
                  text={`<${p.cross!.page}>`}
                  fontSize={10}
                  fontFamily="IBM Plex Mono"
                  fill="#FFC107"
                />
              </Group>
            );
          }),
      )}
    </Layer>
  );
}
