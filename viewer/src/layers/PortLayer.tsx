import { Layer, Line, Text, Group, Rect, Circle } from 'react-konva';
import type { Port } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import { activeNets } from './selection.ts';

interface Props {
  ports: Port[];
  zoom: number;
}

const COLOR = '#FFC107';
const ACTIVE = '#FF9800';

// Symbol shape (port pointing right — `side: left` means port lives on left
// edge, opens toward the page interior on the right). Geometry centered at
// the tip (port.x, port.y). For other sides we rotate the group.
//
//   ___________      ← signal label above
//   <  CONN >  ──── ← wire continues into page
//
//   bracket geometry around the tip:
//
//        +----+
//       /  X  \ <- X is the connector text
//   tip<        >    wire continues from right tip
//       \     /
//        +---+
//
// Width is dynamic to fit the connector text.

function rotationForSide(side: Port['side']): number {
  if (side === 'left') return 0;
  if (side === 'right') return 180;
  if (side === 'top') return 90;
  return 270; // bottom
}

export function PortLayer({ ports, zoom }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const multi = useDocStore((s) => s.multi);
  const toggleMulti = useDocStore((s) => s.toggleMulti);
  const tool = useDocStore((s) => s.tool);
  const editPage = useDocStore((s) => s.editPage);
  const page = useDocStore((s) => s.page);
  const stroke = 2 / zoom;
  const active = activeNets(page, selection);
  const editing = tool === 'edit';

  return (
    <Layer>
      {ports.map((p, i) => {
        const isActive = active.has(p.net);
        const isMulti = multi?.kind === 'port' && multi.indices.includes(i);
        const isSelected = (selection?.kind === 'port' && selection.idx === i) || isMulti;
        const color = isActive ? ACTIVE : COLOR;
        // Local geometry (port at side=left, tip at 0,0, opens to the right):
        //  - left chevron tip at (0,0)
        //  - body extends right to width ~50 (depending on connector len)
        const pid = `${p.connector}${p.pin}`;
        const labelWidth = Math.max(60, pid.length * 16 + 12);
        const bw = labelWidth + 16;
        // Open-end scan coords: where the wire actually connects (opposite the chevron tip)
        const rad = (rotationForSide(p.side) * Math.PI) / 180;
        const openX = p.x + bw * Math.cos(rad);
        const openY = p.y + bw * Math.sin(rad);
        const bh = 26;
        const shoulder = 20;
        const points = [
          0, 0,
          shoulder, -bh,
          bw - shoulder, -bh,
          bw, 0,
          bw - shoulder, bh,
          shoulder, bh,
          0, 0,
        ];
        return (
          <Group
            key={i}
            x={p.x}
            y={p.y}
            rotation={rotationForSide(p.side)}
            draggable={editing}
            onClick={(e) => {
              e.cancelBubble = true;
              if (tool === 'wire') {
                window.dispatchEvent(new CustomEvent('kronikarz:wire-endpoint-click', {
                  detail: { x: openX, y: openY, netName: p.net, autoNet: p.net || `NET_${pid}` },
                }));
                return;
              }
              if (e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey) {
                toggleMulti('port', i);
                return;
              }
              setSelection({ kind: 'port', idx: i });
            }}
            onTap={() => {
              if (tool === 'wire') {
                window.dispatchEvent(new CustomEvent('kronikarz:wire-endpoint-click', {
                  detail: { x: openX, y: openY, netName: p.net, autoNet: p.net || `NET_${pid}` },
                }));
                return;
              }
              setSelection({ kind: 'port', idx: i });
            }}
            onDragEnd={(e) => {
              const nx = Math.round(e.target.x());
              const ny = Math.round(e.target.y());
              const dx = nx - p.x;
              const dy = ny - p.y;
              if (dx === 0 && dy === 0) return;
              const multiIdx = multi?.kind === 'port' && multi.indices.includes(i)
                ? multi.indices
                : [i];
              editPage((page) => {
                for (const pi of multiIdx) {
                  const port = page.ports?.[pi];
                  if (port) {
                    port.x += dx;
                    port.y += dy;
                  }
                }
              });
            }}
          >
            {/* Big invisible hit area covering bracket + label */}
            <Rect
              x={-6}
              y={-bh - 6}
              width={bw + labelWidth + 20}
              height={bh * 2 + 12}
              fill="transparent"
            />
            <Line points={points} stroke={color} strokeWidth={stroke * 1.5} closed={false} listening={false} />
            <Circle
              x={bw}
              y={0}
              radius={isSelected ? 9 : isActive ? 8 : 6}
              fill={isSelected ? '#2196F3' : isActive ? ACTIVE : '#39ff14'}
              stroke={isSelected || isActive ? '#39ff14' : undefined}
              strokeWidth={isSelected ? 2 : isActive ? 1.5 : 0}
              listening={false}
            />
          </Group>
        );
      })}
      {/* Tekst rysowany OSOBNO, nie w rotated Group, zeby zawsze byl poziomo
          i wycentrowany w/wzgledem chevronu niezaleznie od side. */}
      {ports.map((p, i) => {
        const isActive = active.has(p.net);
        const color = isActive ? ACTIVE : COLOR;
        const pid = `${p.connector}${p.pin}`;
        const pidLabelWidth = Math.max(60, pid.length * 16 + 12);
        const bw = pidLabelWidth + 16;
        const FONT = 20;
        const rad = (rotationForSide(p.side) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const toScan = (lx: number, ly: number) => ({
          x: p.x + lx * cos - ly * sin,
          y: p.y + lx * sin + ly * cos,
        });
        // Srodek chevronu w local = (bw/2, 0)
        const pidCenter = toScan(bw / 2, 0);
        // Tekst label poza chevronem (po stronie open-end), zawsze lekko nad chevronem w WORLD frame
        const labelStr = p.label ?? '';
        const labelTextW = Math.max(40, labelStr.length * 12);
        const lblBase = toScan(bw + 12 + labelTextW / 2, 0);
        const lblCenter = { x: lblBase.x, y: lblBase.y - 18 };
        return (
          <Group key={`txt-${i}`} listening={false}>
            <Text
              x={pidCenter.x - (bw - 12) / 2}
              y={pidCenter.y - FONT / 2}
              width={bw - 12}
              align="center"
              text={pid}
              fontSize={FONT}
              fontFamily="IBM Plex Mono"
              fill={color}
              fontStyle="bold"
            />
            <Text
              x={lblCenter.x - labelTextW / 2}
              y={lblCenter.y - FONT / 2}
              width={labelTextW}
              align="center"
              text={labelStr}
              fontSize={FONT}
              fontFamily="IBM Plex Mono"
              fill={color}
              fontStyle="bold"
            />
          </Group>
        );
      })}
    </Layer>
  );
}
