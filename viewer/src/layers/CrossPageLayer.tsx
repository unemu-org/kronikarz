import { Layer, Line, Text, Group, Rect } from 'react-konva';
import type { Page } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import { useStepView } from './stepLook.ts';
import { navigate } from '../router.ts';

interface Props {
  page: Page;
  zoom: number;
}

// Cross-page arrows at pins with a `cross` reference.
// Triangle pointing away from gate + label. Click → navigate if target
// page exists in current package.
export function CrossPageLayer({ page, zoom }: Props): JSX.Element {
  const pkg = useDocStore((s) => s.pkg);
  const w = 1.5 / zoom;
  const sv = useStepView();
  const look = sv.look('pinCross');
  return (
    <Layer visible={look.visible} opacity={look.opacity} listening={look.listening}>
      {page.gates.flatMap((g, gi) =>
        g.pins
          .filter((p) => p.cross)
          .map((p) => {
            const dir = p.side === 'right' ? 1 : p.side === 'left' ? -1 : 0;
            const dy = p.side === 'top' ? -1 : p.side === 'bottom' ? 1 : 0;
            const size = 8;
            const tx = p.px + dir * size * 2;
            const ty = p.py + dy * size * 2;
            const cross = p.cross!;
            const targetPage = pkg?.package.pages.find((pg) => pg.id === cross.page);
            const clickable = !!targetPage;
            const onClick = () => {
              if (targetPage && pkg) {
                navigate({ mode: 'page', pkg: pkg.package.id, page: targetPage.id });
              }
            };
            return (
              <Group
                key={`${gi}-${p.num}`}
                onClick={(e) => {
                  if (clickable) {
                    e.cancelBubble = true;
                    onClick();
                  }
                }}
                onTap={() => clickable && onClick()}
              >
                <Line
                  points={[p.px, p.py, tx, ty]}
                  stroke="#FFC107"
                  strokeWidth={w}
                  listening={false}
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
                  fill={clickable ? '#FFC10788' : '#FFC10733'}
                  strokeWidth={w}
                />
                <Text
                  x={tx + dir * 4 - (dir === -1 ? 30 : 0)}
                  y={ty - 5}
                  text={`<${cross.page}>`}
                  fontSize={10}
                  fontFamily="IBM Plex Mono"
                  fill={clickable ? '#39ff14' : '#FFC107'}
                  listening={false}
                />
                {/* Bigger hit area */}
                <Rect
                  x={Math.min(tx, tx - dir * size) - 4}
                  y={ty - 10}
                  width={Math.abs(size) + 40}
                  height={20}
                  fill="transparent"
                />
              </Group>
            );
          }),
      )}
    </Layer>
  );
}
