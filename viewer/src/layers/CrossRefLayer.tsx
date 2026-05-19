import { Layer, Text, Group, Line, Rect, Circle } from 'react-konva';
import type { CrossRef } from '@kronikarz/shared';
import { parsePage, serializePage } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import { navigate } from '../router.ts';
import { activeNets } from './selection.ts';

// Pobierz YAML strony, dorzuc cross_ref i zapisz spowrotem.
async function autoAddCrossRefOn(
  targetPageId: string,
  net: string,
  label: string,
  sourceSheet: number | undefined,
): Promise<void> {
  const pkgId = useDocStore.getState().pkg?.package.id;
  if (!pkgId) return;
  const path = `MJC-400/${pkgId}/pages/${targetPageId}.sch.yaml`;
  const r = await fetch(`/files/${path}`);
  if (!r.ok) return;
  const txt = await r.text();
  const pg = parsePage(txt, path);
  pg.cross_refs ??= [];
  // Skip if already present
  if (pg.cross_refs.some((c) => c.net === net)) return;
  // Default position: lewy gorny rog skanu
  const newCr: CrossRef = {
    net,
    label,
    pages: sourceSheet !== undefined ? [String(sourceSheet)] : [],
    x: 100,
    y: 100 + pg.cross_refs.length * 40,
    side: 'left',
  };
  pg.cross_refs.push(newCr);
  // Upewnij sie ze net istnieje w pg.nets
  if (!pg.nets[net]) {
    pg.nets[net] = { pins: [], segments: null, junctions: null };
  }
  await fetch(`/files/${path}`, { method: 'PUT', body: serializePage(pg) });
  // Update store cache too
  const allPages = new Map(useDocStore.getState().allPages);
  allPages.set(targetPageId, pg);
  useDocStore.getState().setAllPages(allPages);
}

interface Props {
  refs: CrossRef[];
  zoom: number;
}

const COLOR = '#8b949e';
const ACTIVE = '#FF9800';
const CLICKABLE = '#39ff14';

export function CrossRefLayer({ refs, zoom }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const pkg = useDocStore((s) => s.pkg);
  const editPage = useDocStore((s) => s.editPage);
  const tool = useDocStore((s) => s.tool);
  const multi = useDocStore((s) => s.multi);
  const toggleMulti = useDocStore((s) => s.toggleMulti);
  const allPages = useDocStore((s) => s.allPages);
  const stroke = 1 / zoom;
  const editing = tool === 'edit';
  const page = useDocStore((s) => s.page);
  const active = activeNets(page, selection);

  // Mapa sheet (jako string) → pageId i pageId → Set<net> z cross_refs
  const sheetToPageId = new Map<string, string>();
  if (pkg) {
    for (const p of pkg.package.pages) {
      if (p.sheet !== undefined && p.sheet !== null) sheetToPageId.set(String(p.sheet), p.id);
      sheetToPageId.set(p.id, p.id);
    }
  }
  const crossNetsByPage = new Map<string, Set<string>>();
  for (const [pid, pg] of allPages) {
    const s = new Set<string>();
    for (const cr of pg.cross_refs ?? []) if (cr.net && cr.net.trim()) s.add(cr.net);
    crossNetsByPage.set(pid, s);
  }
  // Live override aktualnej strony
  if (page) {
    const s = new Set<string>();
    for (const cr of page.cross_refs ?? []) if (cr.net && cr.net.trim()) s.add(cr.net);
    crossNetsByPage.set(page.page, s);
  }
  const pageHasReturn = (sheet: string, net: string): boolean => {
    const targetPid = sheetToPageId.get(String(sheet));
    if (!targetPid) return false;
    if (page && targetPid === page.page) return true; // bezsensowne self-ref ale akceptujemy
    return crossNetsByPage.get(targetPid)?.has(net) ?? false;
  };

  return (
    <Layer>
      {refs.map((r, i) => {
        const isActive = active.has(r.net);
        const isMulti = multi?.kind === 'cross_ref' && multi.indices.includes(i);
        const isSelected = (selection?.kind === 'cross_ref' && selection.idx === i) || isMulti;
        const canNavigate = pkg && r.pages.length > 0;
        const color = isActive ? ACTIVE : canNavigate ? CLICKABLE : COLOR;

        // Render: label nad wirem (jak w oryginale), pages obok wire
        const label = r.label ?? '';
        const CHAR_W = 11;
        const labelW = label.length * CHAR_W;
        const sep = ',';
        // Pages tokens (kazdy w swoim kolorze gdy missing)
        type Tok = { text: string; color: string; faulty: boolean };
        const pageTokens: Tok[] = [];
        for (let pi = 0; pi < r.pages.length; pi++) {
          const sheet = r.pages[pi]!;
          const ok = pageHasReturn(sheet, r.net);
          pageTokens.push({
            text: sheet,
            color: ok ? color : '#ff3838',
            faulty: !ok,
          });
          if (pi < r.pages.length - 1) pageTokens.push({ text: sep, color, faulty: false });
        }
        let pagesW = 0;
        for (const t of pageTokens) pagesW += t.text.length * CHAR_W;

        // dir for short horizontal line stub
        const dx = r.side === 'right' ? 1 : r.side === 'left' ? -1 : 0;
        const dy = r.side === 'bottom' ? 1 : r.side === 'top' ? -1 : 0;
        const stubLen = 30;
        const x2 = r.x + dx * stubLen;
        const y2 = r.y + dy * stubLen;

        const onClick = (alt: boolean) => {
          if (tool === 'wire') {
            window.dispatchEvent(new CustomEvent('kronikarz:wire-endpoint-click', {
              detail: { x: r.x, y: r.y, netName: r.net, autoNet: r.net || `NET_${r.label}` },
            }));
            return;
          }
          if (canNavigate && pkg && alt) {
            navigate({ mode: 'page', pkg: pkg.package.id, page: r.pages[0]! });
            return;
          }
          setSelection({ kind: 'cross_ref', idx: i });
        };

        return (
          <Group
            key={i}
            draggable={editing}
            x={0}
            y={0}
            onClick={(e) => {
              e.cancelBubble = true;
              if (tool !== 'wire' && (e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey)) {
                toggleMulti('cross_ref', i);
                return;
              }
              onClick(e.evt.altKey);
            }}
            onTap={() => onClick(false)}
            onDragEnd={(e) => {
              const ndx = Math.round(e.target.x());
              const ndy = Math.round(e.target.y());
              if (ndx === 0 && ndy === 0) return;
              const multiIdx = multi?.kind === 'cross_ref' && multi.indices.includes(i)
                ? multi.indices
                : [i];
              editPage((p) => {
                for (const ci of multiIdx) {
                  const cr = p.cross_refs?.[ci];
                  if (cr) {
                    cr.x += ndx;
                    cr.y += ndy;
                  }
                }
              });
              e.target.x(0);
              e.target.y(0);
            }}
          >
            <Line points={[r.x, r.y, x2, y2]} stroke={color} strokeWidth={stroke * 2} listening={false} />
            <Circle
              x={r.x}
              y={r.y}
              radius={isSelected ? 9 : isActive ? 8 : 6}
              fill={isSelected ? '#2196F3' : isActive ? ACTIVE : '#39ff14'}
              stroke={isSelected || isActive ? '#39ff14' : undefined}
              strokeWidth={isSelected ? 2 : isActive ? 1.5 : 0}
              listening={false}
            />
            {/* Hit area: pokrywa stub + label nad + pages obok */}
            {(() => {
              const stubMidX = (r.x + x2) / 2;
              const labelX = stubMidX - labelW / 2;
              const pagesX = r.side === 'right' ? x2 + 6 : x2 - pagesW - 6;
              const minX = Math.min(r.x, x2, labelX, pagesX) - 6;
              const maxX = Math.max(r.x, x2, labelX + labelW, pagesX + pagesW) + 6;
              return (
                <Rect
                  x={minX}
                  y={r.y - 32}
                  width={maxX - minX}
                  height={48}
                  fill="transparent"
                />
              );
            })()}
            {(() => {
              // Label NAD wirem stub (jak na schemacie), wycentrowany horyzontalnie
              // wzgledem stuba. Pages tuz za koncem stuba na poziomie wire'a.
              const stubMidX = (r.x + x2) / 2;
              const labelX = stubMidX - labelW / 2;
              const labelY = r.y - 24;
              const pagesX = r.side === 'right' ? x2 + 6 : x2 - pagesW - 6;
              const pagesY = r.y - 10;
              const nodes: JSX.Element[] = [];
              if (label) {
                nodes.push(
                  <Text
                    key="label"
                    x={labelX}
                    y={labelY}
                    text={label}
                    fontSize={18}
                    fontFamily="IBM Plex Mono"
                    fill={color}
                    fontStyle="bold"
                    listening={false}
                  />,
                );
              }
              let cursor = pagesX;
              for (let ti = 0; ti < pageTokens.length; ti++) {
                const t = pageTokens[ti]!;
                const w = t.text.length * CHAR_W;
                const tx = cursor;
                cursor += w;
                // Separator (comma) — nieklikalna
                if (t.text === ',') {
                  nodes.push(
                    <Text
                      key={`tok-${ti}`}
                      x={tx}
                      y={pagesY}
                      text={t.text}
                      fontSize={18}
                      fontFamily="IBM Plex Mono"
                      fill={t.color}
                      fontStyle="bold"
                      listening={false}
                    />,
                  );
                  continue;
                }
                const targetPid = pkg ? sheetToPageId.get(String(t.text)) : undefined;
                nodes.push(
                  <Text
                    key={`tok-${ti}`}
                    x={tx}
                    y={pagesY}
                    text={t.text}
                    fontSize={18}
                    fontFamily="IBM Plex Mono"
                    fill={t.color}
                    fontStyle="bold"
                    onClick={async (e) => {
                      e.cancelBubble = true;
                      if (!targetPid || !pkg) return;
                      if (t.faulty && page) {
                        const sourceSheet = pkg.package.pages.find((pp) => pp.id === page.page)?.sheet;
                        await autoAddCrossRefOn(targetPid, r.net, r.label ?? r.net, sourceSheet);
                      }
                      navigate({ mode: 'page', pkg: pkg.package.id, page: targetPid });
                    }}
                  />,
                );
              }
              return nodes;
            })()}
          </Group>
        );
      })}
    </Layer>
  );
}
