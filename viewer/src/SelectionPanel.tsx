import type { ChangeEvent, ReactNode } from 'react';
import { useRef as useReactRef, useState } from 'react';
import type { Page, Side, IcMap } from '@kronikarz/shared';
import { parsePage, resolveIcKey, serializePage } from '@kronikarz/shared';
import { lockReason, pageFilePath, parsePackageFilePath, parsePageFilePath, updateDataFile, useDocStore } from './store.ts';
import { STEP_META, editStepFor, fieldEditable, panelEditable, type ElementKind } from './stepView.ts';
import { passivePins } from './AddGateDialog.tsx';
import {
  assignEndpointNet,
  disconnectEndpoint,
  getEndpointNet,
  mergeDropsCross,
  netEndpoints,
  netExists,
  normalizeNetName,
  renameNeedsConfirm,
  renameNet,
  uniqueNetName,
  type EndpointRef,
} from './netOps.ts';

const ROTATIONS: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];
const SIDES: Side[] = ['left', 'right', 'top', 'bottom'];

// "kopiuj do wszystkich stron pakietu": each page through updateDataFile
// (flush auto-save, GET, PUT with If-Match — a page changed meanwhile is
// reported, not overwritten). `add` mutates the page, false = already there.
// The page open in this tab at that moment is skipped (checked per page and
// again right before the PUT): its in-memory copy would not have the item and
// its next auto-save would conflict. "Open" = its file is the one the page
// in the store was loaded from (pagePath), whatever its YAML `page:` says.
// Target files are in the dir of the loaded package.yaml (pkgPath), whatever
// its `package.id` says.
async function copyToPages(pageIds: string[], add: (pg: Page) => boolean): Promise<void> {
  const pkgPath = useDocStore.getState().pkgPath;
  const pkgId = pkgPath ? parsePackageFilePath(pkgPath) : null;
  if (!pkgId) return;
  const isOpen = (id: string) => useDocStore.getState().pagePath === pageFilePath(pkgId, id);
  let ok = 0;
  let same = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const id of pageIds) {
    if (isOpen(id)) {
      skipped++;
      continue;
    }
    const path = pageFilePath(pkgId, id);
    const seen = { openNow: false };
    const res = await updateDataFile(path, (txt) => {
      if (isOpen(id)) {
        seen.openNow = true;
        return null;
      }
      const pg = parsePage(txt, path);
      return add(pg) ? serializePage(pg) : null;
    });
    if (res.status === 'ok') ok++;
    else if (res.status === 'unchanged') {
      if (seen.openNow) skipped++;
      else same++;
    } else if (res.status === 'not-started') {
      alert(`Kopiowanie przerwane: ${res.error}\nSkopiowano do ${ok} z ${pageIds.length} stron.`);
      return;
    } else errors.push(res.error);
  }
  const summary = `Skopiowano do ${ok} z ${pageIds.length} stron` +
    (same ? `, już było na ${same}` : '') +
    (skipped ? `, pominięto otwartą stronę: ${skipped}` : '') +
    `, błędy: ${errors.length}.`;
  alert(errors.length ? `${summary}\n\n${errors.join('\n')}` : summary);
}

// File stem of the open page (package.pages[].id), not its YAML `page:`.
function openPageId(): string | undefined {
  const p = useDocStore.getState().pagePath;
  return p ? parsePageFilePath(p)?.pageId : undefined;
}

export function SelectionPanel(): JSX.Element | null {
  const page = useDocStore((s) => s.page);
  const icMap = useDocStore((s) => s.icMap);
  const pkg = useDocStore((s) => s.pkg);
  const selection = useDocStore((s) => s.selection);
  const tool = useDocStore((s) => s.tool);
  const editPage = useDocStore((s) => s.editPage);
  const editPackage = useDocStore((s) => s.editPackage);
  const issues = useDocStore((s) => s.issues);
  const editing = tool === 'edit';
  // Bieżący krok: panel elementu spoza kroku (albo strona zablokowana przez
  // trwający krok) jest tylko do odczytu — <fieldset disabled> wyłącza pola i przyciski.
  const currentStep = useDocStore((s) => s.currentStep);
  const setCurrentStep = useDocStore((s) => s.setCurrentStep);
  const lockMsg = useDocStore(lockReason);
  const lock = lockMsg !== null ? { reason: lockMsg } : null;

  if (!page) return null;
  const selKind = selection?.kind ?? null;
  const outOfStep = selKind !== null && !panelEditable(currentStep, selKind);
  const readOnly = !!lock || outOfStep;
  const editAt = selKind !== null ? editStepFor(selKind) : null;
  // Pole panelu spoza aspektu bieżącego kroku → wyłączone (stepView.fieldEditable).
  const off = (kind: ElementKind, field: string): boolean => !!lock || !fieldEditable(currentStep, kind, field);
  const gate =
    selection?.kind === 'gate' && selection.idx >= 0 && selection.idx < page.gates.length
      ? page.gates[selection.idx]!
      : null;
  const gateIdx = selection?.kind === 'gate' ? selection.idx : null;
  const net = selection?.kind === 'net' ? page.nets[selection.name] : null;
  const netName = selection?.kind === 'net' ? selection.name : null;
  const comp = gate && pkg ? pkg.components[gate.ref] : null;
  const compIcKey = comp && comp.ic && icMap ? resolveIcKey(comp.ic, icMap) : null;
  const icDef = compIcKey && icMap ? icMap[compIcKey] : null;

  const updateGate = (mutator: (g: NonNullable<typeof gate>) => void) => {
    if (gateIdx === null) return;
    editPage((p) => {
      const g = p.gates[gateIdx];
      if (g) mutator(g);
    });
  };

  return (
    <aside className="min-h-0 flex-1 overflow-y-auto bg-bg-panel p-2 text-xs">
      {lock && <div className="mb-2 border border-warning/60 px-2 py-1 text-warning">⏳ {lock.reason}</div>}
      {!lock && outOfStep && (
        <div className="mb-2 border border-warning/60 px-2 py-1 text-warning" data-testid="read-only">
          element kroku {editAt ? `${STEP_META[editAt].glyph} ${STEP_META[editAt].name}` : '„wszystko”'} — przełącz krok, aby edytować{' '}
          <button onClick={() => setCurrentStep(editAt)} className="ml-1 border border-warning/60 px-1.5 text-text-main hover:bg-warning/20">
            przełącz
          </button>
        </div>
      )}
      <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
      {!gate && netName === null && selection?.kind !== 'segment' && selection?.kind !== 'port' && selection?.kind !== 'cross_ref' && selection?.kind !== 'power' && selection?.kind !== 'annotation' && selection?.kind !== 'decoration' && (
        <div className="text-text-dim">brak zaznaczenia</div>
      )}

      {selection?.kind === 'power' && (() => {
        const idx = selection.idx;
        const ps = page.power?.[idx];
        if (!ps) return null;
        const psCtx = netCtx({ kind: 'power', idx }, ps.net);
        return (
          <div className="space-y-2">
            <h2 className="font-bold text-phosphor">{ps.type}</h2>
            {editing ? (
              <>
                <Asp off={off('power', 'type')}>
                <Field
                  label="type"
                  value={ps.type}
                  onChange={(v) => editPage((p) => { const t = p.power[idx]; if (t) t.type = v; })}
                />
                </Asp>
                <Asp off={off('power', 'net')}>
                <NetField label="net" value={ps.net} onCommit={(v) => commitAssign(psCtx, v)} />
                </Asp>
                <Asp off={off('power', 'rotation')}>
                <div className="flex items-center gap-2">
                  <label className="w-16 text-text-dim">rotation</label>
                  <select
                    className="flex-1 bg-bg-accent px-1 py-0.5"
                    value={ps.rotation ?? 0}
                    onChange={(e) => {
                      const r = Number(e.target.value) as 0 | 90 | 180 | 270;
                      editPage((p) => { const t = p.power[idx]; if (t) t.rotation = r; });
                    }}
                  >
                    {ROTATIONS.map((r) => <option key={r} value={r}>{r}°</option>)}
                  </select>
                </div>
                <button
                  className="w-full bg-error/40 px-2 py-0.5 text-left text-error hover:bg-error/60"
                  onClick={() => { if (!confirm('Usunąć?')) return; editPage((p) => { p.power.splice(idx, 1); }); useDocStore.getState().setSelection(null); }}
                >usuń</button>
                </Asp>
              </>
            ) : (
              <div className="text-text-dim">x={ps.x} y={ps.y} rot={ps.rotation ?? 0}</div>
            )}
          </div>
        );
      })()}

      {netName !== null && (() => {
        // A net may exist only through endpoint references (no nets entry).
        const eps = netEndpoints(page, netName);
        const exists = netExists(page, netName);
        const nCtx = netCtx(undefined, netName);
        return (
        <div className="space-y-2">
          <h2 className="font-bold text-net-active">{netName}</h2>
          {!net && <div className="text-text-dim">bez wpisu w nets (tylko referencje końcówek)</div>}
          {!exists && <div className="text-warning">net już nie istnieje na tej stronie</div>}
          {editing && exists && (
            <button
              className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-main hover:bg-phosphor-dim"
              title="wszystkie końcówki tego netu na stronie + jego geometria; istniejąca nazwa = scalenie (z potwierdzeniem)"
              onClick={() => {
                const r = promptRenameNet(nCtx);
                if (r.done && r.name) useDocStore.getState().setSelection({ kind: 'net', name: r.name });
              }}
            >
              zmień nazwę netu
            </button>
          )}
          <hr className="border-bg-accent" />
          <div>
            <h3 className="text-text-dim">KOŃCÓWKI ({eps.length})</h3>
            <ul>
              {eps.map((ep, i) => (
                <li key={i} className="text-phosphor">
                  {endpointLabel(page, ep)}
                </li>
              ))}
            </ul>
          </div>
          {net && (
            <div className="text-text-dim">
              segmenty: {net.segments?.length ?? 'null'} · junctions:{' '}
              {net.junctions?.length ?? 'null'}
            </div>
          )}
          {net?.cross && (
            <div className="text-warning">
              cross → {net.cross.page} ({net.cross.label})
            </div>
          )}
          {editing && (
            <div className="space-y-1 border-t border-bg-accent pt-2">
              {net && (
                <>
                  <button
                    className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-main hover:bg-phosphor-dim"
                    onClick={() =>
                      editPage((p) => {
                        const n = p.nets[netName];
                        if (!n) return;
                        // Junction at the average of this net's gate pins
                        // (pin.net = source of truth, not legacy net.pins[]).
                        const pts = netEndpoints(p, netName).flatMap((ep) => {
                          if (ep.kind !== 'pin') return [];
                          const pin = p.gates[ep.gateIdx]?.pins[ep.pinIdx];
                          return pin ? [{ x: pin.px, y: pin.py }] : [];
                        });
                        if (pts.length) {
                          const cx = Math.round(pts.reduce((a, b) => a + b.x, 0) / pts.length);
                          const cy = Math.round(pts.reduce((a, b) => a + b.y, 0) / pts.length);
                          n.junctions = [...(n.junctions ?? []), [cx, cy]];
                        }
                      })
                    }
                  >
                    + junction (środek netu)
                  </button>
                  <button
                    className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-main hover:bg-phosphor-dim"
                    onClick={() =>
                      editPage((p) => {
                        const n = p.nets[netName];
                        if (n) n.segments = null;
                      })
                    }
                  >
                    wyczyść segmenty (→ dashed)
                  </button>
                </>
              )}
              {exists && (
                <button
                  className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-main hover:bg-phosphor-dim"
                  onClick={() => {
                    const rand = uniqueNetName(page, `${netName}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`);
                    const r = commitRename(nCtx, rand, 'enter');
                    if (r.done && r.name) useDocStore.getState().setSelection({ kind: 'net', name: r.name });
                  }}
                  title="losowa nazwa — szybki fix konfliktu nazw"
                >
                  🎲 randomize name
                </button>
              )}
            </div>
          )}
        </div>
        );
      })()}

      {selection?.kind === 'segment' && (
        <SegmentPanel
          netName={selection.netName}
          segmentIdx={selection.segmentIdx}
        />
      )}

      {selection?.kind === 'port' && (() => {
        const port = page.ports?.[selection.idx];
        if (!port) return null;
        const idx = selection.idx;
        const portCtx = netCtx({ kind: 'port', idx }, port.net);
        return (
          <div className="space-y-2">
            <h2 className="font-bold text-phosphor">PORT {port.connector}{port.pin}</h2>
            <hr className="border-bg-accent" />
            <Asp off={off('port', 'label')}>
            <Field label="connector" value={port.connector} onChange={(v) => editPage((p) => { const x = p.ports?.[idx]; if (x) x.connector = v.trim().toUpperCase(); })} />
            <Field label="pin" value={String(port.pin)} onChange={(v) => editPage((p) => { const x = p.ports?.[idx]; if (x) { const n = parseInt(v, 10); if (Number.isFinite(n)) x.pin = n; } })} />
            <FieldUni label="label" value={port.label} onChange={(v) => editPage((p) => { const x = p.ports?.[idx]; if (x) x.label = v; })} />
            </Asp>
            <Asp off={off('port', 'net')}>
            <NetField label="net" value={port.net} uni title={SIGNAL_NET_TITLE} onCommit={(v, mode) => commitRename(portCtx, v, mode)}>
              <DisconnectButton ctx={portCtx} />
            </NetField>
            </Asp>
            <Asp off={off('port', 'side')}>
            <div className="flex items-center gap-2">
              <label className="w-16 text-text-dim">side</label>
              <select value={port.side} onChange={(e) => editPage((p) => { const x = p.ports?.[idx]; if (x) x.side = e.target.value as Side; })} className="flex-1 bg-bg-accent px-1 py-0.5">
                {SIDES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="text-text-dim">x={port.x} y={port.y}</div>
            <button
              className="w-full bg-error/40 px-2 py-0.5 text-left text-error hover:bg-error/60"
              onClick={() => { if (!confirm('Usunąć port?')) return; editPage((p) => { p.ports?.splice(idx, 1); }); useDocStore.getState().setSelection(null); }}
            >
              usuń port
            </button>
            </Asp>
          </div>
        );
      })()}

      {selection?.kind === 'cross_ref' && (() => {
        const cr = page.cross_refs?.[selection.idx];
        if (!cr) return null;
        const idx = selection.idx;
        const crCtx = netCtx({ kind: 'cross_ref', idx }, cr.net);
        return (
          <div className="space-y-2">
            <h2 className="font-bold text-phosphor">CROSS-REF {cr.label}</h2>
            <hr className="border-bg-accent" />
            <Asp off={off('cross_ref', 'label')}>
            <FieldUni label="label" value={cr.label} onChange={(v) => editPage((p) => { const x = p.cross_refs?.[idx]; if (x) x.label = v; })} />
            </Asp>
            <Asp off={off('cross_ref', 'net')}>
            <NetField label="net" value={cr.net} uni title={SIGNAL_NET_TITLE} onCommit={(v, mode) => commitRename(crCtx, v, mode)}>
              <DisconnectButton ctx={crCtx} />
            </NetField>
            </Asp>
            <Asp off={off('cross_ref', 'pages')}>
            <div className="space-y-1">
              <div className="text-text-dim">arkusze (sheets):</div>
              <div className="grid grid-cols-6 gap-1">
                {pkg?.package.pages.map((pp) => {
                  const sheetStr = pp.sheet !== undefined ? String(pp.sheet) : pp.id;
                  const checked = cr.pages.includes(sheetStr);
                  const isCurrent = pp.id === page?.page;
                  return (
                    <label
                      key={pp.id}
                      className={`flex cursor-pointer items-center gap-1 border px-1 py-0.5 text-[11px] ${
                        checked ? 'border-phosphor bg-phosphor-dim text-bg-main' : 'border-bg-accent text-text-dim hover:bg-bg-accent'
                      } ${isCurrent ? 'italic' : ''}`}
                      title={`${pp.id} (sheet ${sheetStr})`}
                    >
                      <input
                        type="checkbox"
                        className="hidden"
                        checked={checked}
                        onChange={(e) => editPage((p) => {
                          const x = p.cross_refs?.[idx];
                          if (!x) return;
                          if (e.target.checked) {
                            if (!x.pages.includes(sheetStr)) x.pages = [...x.pages, sheetStr];
                          } else {
                            x.pages = x.pages.filter((s) => s !== sheetStr);
                          }
                          // sortuj numerycznie
                          x.pages.sort((a, b) => Number(a) - Number(b));
                        })}
                      />
                      {sheetStr}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="w-16 text-text-dim">side</label>
              <select value={cr.side} onChange={(e) => editPage((p) => { const x = p.cross_refs?.[idx]; if (x) x.side = e.target.value as Side; })} className="flex-1 bg-bg-accent px-1 py-0.5">
                {SIDES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="text-text-dim">x={cr.x} y={cr.y}</div>
            <div className="text-text-dim text-[10px]">Ctrl+klik na canvas → nawiguj do pierwszej strony</div>
            <button
              className="w-full bg-error/40 px-2 py-0.5 text-left text-error hover:bg-error/60"
              onClick={() => { if (!confirm('Usunąć cross-ref?')) return; editPage((p) => { p.cross_refs?.splice(idx, 1); }); useDocStore.getState().setSelection(null); }}
            >
              usuń cross-ref
            </button>
            </Asp>
          </div>
        );
      })()}

      {selection?.kind === 'annotation' && (() => {
        const ann = page.annotations?.[selection.idx];
        if (!ann) return null;
        const idx = selection.idx;
        return (
          <div className="space-y-2">
            <h2 className="font-bold text-phosphor">TEKST</h2>
            <hr className="border-bg-accent" />
            <div className="space-y-1">
              <label className="text-text-dim">text</label>
              <textarea
                value={ann.text}
                onChange={(e) => editPage((p) => { const a = p.annotations?.[idx]; if (a) a.text = e.target.value; })}
                rows={3}
                className="w-full bg-bg-accent px-1 py-0.5 font-mono"
              />
            </div>
            <Field
              label="fontSize"
              value={String(ann.fontSize ?? 20)}
              onChange={(v) => editPage((p) => { const a = p.annotations?.[idx]; if (a) { const n = parseInt(v, 10); if (Number.isFinite(n)) a.fontSize = n; } })}
            />
            <div className="flex items-center gap-2">
              <label className="w-16 text-text-dim">rotation</label>
              <select
                value={String(ann.rotation ?? 0)}
                onChange={(e) => editPage((p) => { const a = p.annotations?.[idx]; if (a) a.rotation = Number(e.target.value); })}
                className="flex-1 bg-bg-accent px-1 py-0.5"
              >
                <option value="0">0° (poziomo)</option>
                <option value="90">90° (pionowo, w dół)</option>
                <option value="180">180° (do góry nogami)</option>
                <option value="270">270° (pionowo, w górę)</option>
              </select>
            </div>
            <div className="text-text-dim">x={ann.x} y={ann.y}</div>
            <button
              className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-dim hover:bg-phosphor-dim hover:text-bg-main"
              onClick={async () => {
                if (!pkg || !page) return;
                const targets = pkg.package.pages.filter((p) => p.id !== openPageId());
                if (!confirm(`Skopiować ten tekst do ${targets.length} pozostałych stron pakietu?`)) return;
                await copyToPages(targets.map((t) => t.id), (pg) => {
                  pg.annotations ??= [];
                  // Skip jezeli juz istnieje identyczny tekst w identycznej pozycji
                  if (pg.annotations.some((a) => a.text === ann.text && a.x === ann.x && a.y === ann.y)) return false;
                  pg.annotations.push({ text: ann.text, x: ann.x, y: ann.y, fontSize: ann.fontSize });
                  return true;
                });
              }}
            >
              📋 kopiuj do wszystkich stron pakietu
            </button>
            <button
              className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-dim hover:bg-phosphor-dim hover:text-bg-main"
              onClick={() => {
                localStorage.setItem('kronikarz:clip', JSON.stringify({ kind: 'annotation', data: ann }));
              }}
              title="Ctrl+C — skopiuj do schowka"
            >
              ✂ kopiuj (Ctrl+C)
            </button>
            <button
              className="w-full bg-error/40 px-2 py-0.5 text-left text-error hover:bg-error/60"
              onClick={() => { if (!confirm('Usunąć tekst?')) return; editPage((p) => { p.annotations?.splice(idx, 1); }); useDocStore.getState().setSelection(null); }}
            >
              usuń tekst
            </button>
          </div>
        );
      })()}

      {selection?.kind === 'decoration' && (() => {
        const d = page.decorations?.[selection.idx];
        if (!d) return null;
        const idx = selection.idx;
        return (
          <div className="space-y-2">
            <h2 className="font-bold text-phosphor">{d.kind.toUpperCase()}</h2>
            <hr className="border-bg-accent" />
            <Field label="thickness" value={String(d.thickness ?? 2)} onChange={(v) => editPage((p) => { const x = p.decorations?.[idx]; if (x) { const n = parseInt(v, 10); if (Number.isFinite(n)) x.thickness = n; } })} />
            <Field label="color" value={d.color ?? ''} onChange={(v) => editPage((p) => { const x = p.decorations?.[idx]; if (x) x.color = v || undefined; })} />
            {d.kind === 'line' && (
              <div className="text-text-dim">({d.x1},{d.y1}) → ({d.x2},{d.y2})</div>
            )}
            {d.kind === 'rect' && (
              <div className="text-text-dim">x={d.x} y={d.y} w={d.w} h={d.h}</div>
            )}
            {d.kind === 'ellipse' && (
              <div className="text-text-dim">cx={d.x} cy={d.y} rx={d.rx} ry={d.ry}</div>
            )}
            <button
              className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-dim hover:bg-phosphor-dim hover:text-bg-main"
              onClick={async () => {
                if (!pkg || !page) return;
                const targets = pkg.package.pages.filter((p) => p.id !== openPageId());
                if (!confirm(`Skopiować do ${targets.length} pozostałych stron pakietu?`)) return;
                const sig = JSON.stringify(d);
                await copyToPages(targets.map((t) => t.id), (pg) => {
                  pg.decorations ??= [];
                  // Dedup by identyczne pola
                  if (pg.decorations.some((dd) => JSON.stringify(dd) === sig)) return false;
                  pg.decorations.push({ ...d });
                  return true;
                });
              }}
            >
              📋 kopiuj do wszystkich stron pakietu
            </button>
            <button
              className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-dim hover:bg-phosphor-dim hover:text-bg-main"
              onClick={() => {
                localStorage.setItem('kronikarz:clip', JSON.stringify({ kind: 'decoration', data: d }));
              }}
              title="Ctrl+C — skopiuj do schowka"
            >
              ✂ kopiuj (Ctrl+C)
            </button>
            <button
              className="w-full bg-error/40 px-2 py-0.5 text-left text-error hover:bg-error/60"
              onClick={() => { if (!confirm('Usunąć?')) return; editPage((p) => { p.decorations?.splice(idx, 1); }); useDocStore.getState().setSelection(null); }}
            >
              usuń
            </button>
          </div>
        );
      })()}

      {gate && (
        <div className="space-y-2">
          <h2 className="font-bold text-phosphor">
            {gate.ref}
            {gate.gate ? ` — gate ${gate.gate}` : ''}
          </h2>
          {icDef && (
            <div className="text-text-dim">
              {icDef.name ?? '?'} — {icDef.desc ?? ''}
            </div>
          )}
          {gate && icMap && comp?.ic !== null && (
            <Asp off={off('gate', 'ic')}>
            <IcPicker
              gate={gate}
              gateIdx={gateIdx!}
              icMap={icMap}
              currentIc={compIcKey}
              applyPinout={(ic, letter) => applyPinout(editPage, editPackage, gateIdx!, ic, letter, icMap, page, pkg)}
              setIc={(ic) => {
                if (!pkg) return;
                editPackage((p) => {
                  const c = p.components[gate.ref];
                  if (!c) {
                    p.components[gate.ref] = { ic, gates: { [gate.gate ?? 'A']: { page: page.page } } };
                  } else if ('ic' in c) {
                    (c as { ic: string }).ic = ic;
                  }
                });
              }}
            />
            </Asp>
          )}
          {gate && comp?.ic === null && editing && (
            <Asp off={off('gate', 'value')}>
            <div className="space-y-1 border border-bg-accent p-1">
              <div className="text-text-dim">
                {comp.type === 'resistor' ? 'Rezystor' : comp.type === 'capacitor' ? 'Kondensator' : 'Jumper'}
              </div>
              {(comp.type === 'resistor' || comp.type === 'capacitor') && (
                <Field
                  label="wartość"
                  value={gate.value ?? ''}
                  onChange={(v) => {
                    updateGate((g) => { g.value = v || undefined; });
                    editPackage((p) => {
                      const c = p.components[gate.ref];
                      if (c && c.ic === null && (c.type === 'resistor' || c.type === 'capacitor')) c.value = v;
                    });
                  }}
                />
              )}
              {comp.type === 'capacitor' && (
                <div className="flex items-center gap-2">
                  <label className="w-16 text-text-dim">polar</label>
                  <input
                    type="checkbox"
                    checked={!!comp.polarized}
                    onChange={(e) => {
                      const val = e.target.checked;
                      editPackage((p) => {
                        const c = p.components[gate.ref];
                        if (c && c.ic === null && c.type === 'capacitor') {
                          if (val) c.polarized = true;
                          else delete c.polarized;
                        }
                      });
                    }}
                  />
                </div>
              )}
              {comp.type === 'jumper' && (
                <>
                  <Field
                    label="pozycje"
                    value={comp.positions.join(',')}
                    onChange={(v) => {
                      const list = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
                      editPackage((p) => {
                        const c = p.components[gate.ref];
                        if (c && c.ic === null && c.type === 'jumper') c.positions = list;
                      });
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <label className="w-16 text-text-dim">selected</label>
                    <select
                      className="flex-1 bg-bg-accent px-1 py-0.5"
                      value={comp.selected ?? ''}
                      onChange={(e) => {
                        const val = e.target.value || null;
                        editPackage((p) => {
                          const c = p.components[gate.ref];
                          if (c && c.ic === null && c.type === 'jumper') c.selected = val;
                        });
                      }}
                    >
                      <option value="">— none —</option>
                      {comp.positions.map((pos) => (
                        <option key={pos} value={pos}>{pos}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
            </Asp>
          )}
          {(() => {
            const gateKey = `${gate.ref}${gate.gate ? `.${gate.gate}` : ''}`;
            const gateIssues = issues.filter((it) => it.ref === gateKey || it.ref === gate.ref);
            if (!gateIssues.length) return null;
            return (
              <div className="border border-red-700 bg-red-900/30 p-1 text-[11px]">
                {gateIssues.map((it, idx) => (
                  <div key={idx} className={it.level === 'err' ? 'text-red-300' : 'text-yellow-300'}>
                    {it.level}: {it.message}
                  </div>
                ))}
              </div>
            );
          })()}
          <hr className="border-bg-accent" />
          {editing ? (
            <div className="space-y-1">
              <Asp off={off('gate', 'ref')}>
              <Field
                label="ref"
                value={gate.ref}
                onChange={(v) => {
                  const newRef = v.trim();
                  const oldRef = gate.ref;
                  if (!newRef || newRef === oldRef) return;
                  updateGate((g) => (g.ref = newRef));
                  // Rename in package.components too (preserves passive/IC metadata)
                  editPackage((p) => {
                    if (!p.components[oldRef]) return;
                    if (p.components[newRef]) return; // collision: leave alone
                    p.components[newRef] = p.components[oldRef]!;
                    delete p.components[oldRef];
                  });
                }}
              />
              {comp?.ic !== null && (
                <Field
                  label="gate"
                  value={gate.gate ?? ''}
                  onChange={(v) => updateGate((g) => (g.gate = v || null))}
                />
              )}
              </Asp>
              <Asp off={off('gate', 'rotation')}>
              <div className="flex items-center gap-2">
                <label className="w-16 text-text-dim">rotation</label>
                <select
                  className="flex-1 bg-bg-accent px-1 py-0.5"
                  value={gate.rotation}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    const r = Number(e.target.value) as 0 | 90 | 180 | 270;
                    updateGate((g) => {
                      g.rotation = r;
                      // Passive: recompute the 2 pin positions to follow rotation
                      if (comp?.ic === null && g.pins.length === 2) {
                        const fresh = passivePins(g.x, g.y, r);
                        g.pins[0]!.px = fresh[0]!.px; g.pins[0]!.py = fresh[0]!.py; g.pins[0]!.side = fresh[0]!.side;
                        g.pins[1]!.px = fresh[1]!.px; g.pins[1]!.py = fresh[1]!.py; g.pins[1]!.side = fresh[1]!.side;
                      }
                    });
                  }}
                >
                  {ROTATIONS.map((r) => (
                    <option key={r} value={r}>
                      {r}°
                    </option>
                  ))}
                </select>
              </div>
              </Asp>
              <div className="flex items-center gap-2 text-text-dim">
                <span className="w-16">x</span>
                <span>{gate.x}</span>
                <span className="w-8">y</span>
                <span>{gate.y}</span>
              </div>
            </div>
          ) : (
            <div className="text-text-dim">
              x={gate.x} y={gate.y} rot={gate.rotation}
            </div>
          )}
          <hr className="border-bg-accent" />
          <div>
            <h3 className="text-text-dim">PINY</h3>
            <ul className="space-y-0.5">
              {gate.pins.map((p, pi) => (
                <li key={p.num} className={`flex items-center gap-1 ${p.disconnected ? 'opacity-50' : ''}`}>
                  <span className="w-4 text-phosphor">{p.num}</span>
                  <span className="w-8 text-text-dim">{p.side}</span>
                  {editing && gateIdx !== null ? (
                    (() => {
                      const pinCtx = netCtx({ kind: 'pin', gateIdx, pinIdx: pi }, p.net);
                      return (
                        <Asp off={off('gate', 'pinNet')}>
                        <NetField
                          value={p.net}
                          disabled={p.disconnected}
                          title="net tylko tego pinu (✎ = nazwa całego netu)"
                          onCommit={(v) => commitAssign(pinCtx, v)}
                        >
                          {!p.disconnected && <RenameNetButton page={page} ctx={pinCtx} />}
                          {!p.disconnected && <DisconnectButton ctx={pinCtx} />}
                        </NetField>
                        </Asp>
                      );
                    })()
                  ) : (
                    <span className="flex-1">{p.disconnected ? 'NC' : p.net}</span>
                  )}
                  {editing && (
                    <Asp off={off('gate', 'nc')}>
                    <label className="flex items-center gap-0.5 text-text-dim" title="NC — not connected (ukryj pin, skip walidacji)">
                      <input
                        type="checkbox"
                        checked={!!p.disconnected}
                        onChange={(e) => {
                          const val = e.target.checked;
                          updateGate((g) => {
                            const pin = g.pins[pi];
                            if (!pin) return;
                            if (val) pin.disconnected = true;
                            else delete pin.disconnected;
                          });
                        }}
                      />
                      <span>NC</span>
                    </label>
                    </Asp>
                  )}
                  {p.cross && (
                    <span className="text-warning">→{p.cross.page}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <hr className="border-bg-accent" />
          <div>
            verified:{' '}
            <button
              className={gate.verified ? 'text-verified' : 'text-warning'}
              onClick={() => updateGate((g) => (g.verified = !g.verified))}
              title="K — toggle"
            >
              {gate.verified ? 'tak' : 'nie'}
            </button>
          </div>
          {editing && (
            <Field
              label="note"
              value={gate.note ?? ''}
              onChange={(v) => updateGate((g) => (g.note = v || null))}
            />
          )}
          {!editing && gate.note && <div>note: {gate.note}</div>}
        </div>
      )}

      </fieldset>
    </aside>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 text-text-dim">{label}</label>
      <input
        className="flex-1 bg-bg-accent px-1 py-0.5"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// Field z guziczkami quick-insert unicode (DTR: ↑ ↓ Ø).
// Wstawia znak w pozycji kursora lub dokleja na końcu jak focus utracony.
function FieldUni({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const inputRef = useReactRef<HTMLInputElement>(null);
  const insert = (ch: string) => {
    const el = inputRef.current;
    if (el) {
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + ch + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + ch.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      onChange(value + ch);
    }
  };
  return (
    <div className="flex items-center gap-1">
      <label className="w-16 text-text-dim">{label}</label>
      <input
        ref={inputRef}
        className="flex-1 bg-bg-accent px-1 py-0.5"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" tabIndex={-1} className="bg-bg-accent px-1 hover:bg-phosphor-dim hover:text-bg-main" title="↑" onClick={() => insert('↑')}>↑</button>
      <button type="button" tabIndex={-1} className="bg-bg-accent px-1 hover:bg-phosphor-dim hover:text-bg-main" title="↓" onClick={() => insert('↓')}>↓</button>
      <button type="button" tabIndex={-1} className="bg-bg-accent px-1 hover:bg-phosphor-dim hover:text-bg-main" title="Ø (przekreślone 0)" onClick={() => insert('Ø')}>Ø</button>
    </div>
  );
}

function endpointLabel(p: Page, ep: EndpointRef): string {
  switch (ep.kind) {
    case 'pin': {
      const g = p.gates[ep.gateIdx];
      const pin = g?.pins[ep.pinIdx];
      return g && pin ? `${g.ref}${g.gate ? `.${g.gate}` : ''}.${pin.num}` : '?';
    }
    case 'port': {
      const x = p.ports?.[ep.idx];
      return x ? `port ${x.connector}${x.pin}` : '?';
    }
    case 'cross_ref': return `xref ${p.cross_refs?.[ep.idx]?.label ?? '?'}`;
    case 'power': return `zasilanie ${p.power?.[ep.idx]?.type ?? '?'}`;
  }
}

const SIGNAL_NET_TITLE =
  'nazwa sygnału = nazwa całego netu (wszystkie końcówki na stronie); istniejący net → Enter + potwierdzenie';
const EMPTY_HINT = 'pusta nazwa netu — odrzucona';

type CommitMode = 'blur' | 'enter';
interface CommitOutcome { done: boolean; hint?: string; name?: string; merged?: boolean }

// What a net field / button was rendered for. Captured at render, checked at
// commit: another page, another selection or an endpoint whose net changed
// meanwhile → the commit does nothing.
interface NetCtx { pagePath: string | null; sel: string; ep?: EndpointRef; oldNet: string }

function netCtx(ep: EndpointRef | undefined, oldNet: string): NetCtx {
  const st = useDocStore.getState();
  return { pagePath: st.pagePath, sel: JSON.stringify(st.selection), ep, oldNet };
}

function ctxPage(ctx: NetCtx): Page | null {
  const st = useDocStore.getState();
  if (!st.page || st.pagePath !== ctx.pagePath || JSON.stringify(st.selection) !== ctx.sel) return null;
  if (ctx.ep && getEndpointNet(st.page, ctx.ep) !== ctx.oldNet) return null;
  return st.page;
}

// Assign only this endpoint (pin / power). Empty name → hint, field reverts.
// Unchanged name → no edit, no undo step.
function commitAssign(ctx: NetCtx, raw: string): CommitOutcome {
  const page = ctxPage(ctx);
  const ep = ctx.ep;
  if (!page || !ep) return { done: false };
  const v = normalizeNetName(raw);
  if (!v) return { done: false, hint: EMPTY_HINT };
  if (v === ctx.oldNet) return { done: false };
  useDocStore.getState().editPage((p) => { assignEndpointNet(p, ep, v); });
  return { done: true, name: v };
}

function mergeConfirmText(page: Page, from: string, into: string): string {
  const dropped = mergeDropsCross(page, from, into);
  return `Net „${into}” już istnieje na tej stronie.\n` +
    `Scalić „${from}” z „${into}”? Wszystkie końcówki i segmenty „${from}” przejdą do „${into}”.` +
    (dropped ? `\nUwaga: oba nety mają cross — zostaje cross „${into}”, cross „${from}” (→ ${dropped.page} ${dropped.label}) zostanie usunięty.` : '');
}

// Rename the whole net `ctx.oldNet` (port / cross_ref / segment / buttons).
// Endpoint with no net yet → just assign it. Renaming onto a live net is a
// merge: on blur only a hint (no modal), on Enter/button a confirm.
function commitRename(ctx: NetCtx, raw: string, mode: CommitMode): CommitOutcome {
  const page = ctxPage(ctx);
  if (!page) return { done: false };
  const v = normalizeNetName(raw);
  if (!v) return { done: false, hint: EMPTY_HINT };
  if (v === ctx.oldNet) return { done: false };
  if (!normalizeNetName(ctx.oldNet)) return ctx.ep ? commitAssign(ctx, v) : { done: false };
  if (!netExists(page, ctx.oldNet)) return { done: false };
  if (renameNeedsConfirm(page, ctx.oldNet, v)) {
    if (mode === 'blur') return { done: false, hint: `Enter, aby scalić z istniejącym netem „${v}”` };
    if (!window.confirm(mergeConfirmText(page, ctx.oldNet, v))) return { done: false };
  }
  const merged = netExists(page, v);
  const old = ctx.oldNet;
  useDocStore.getState().editPage((p) => { renameNet(p, old, v); });
  return { done: true, name: v, merged };
}

// Button: prompt for the new name (modal is fine here — not inside a blur).
function promptRenameNet(ctx: NetCtx): CommitOutcome {
  const input = window.prompt(
    `Nowa nazwa netu „${ctx.oldNet}” (zmienia wszystkie końcówki i geometrię na tej stronie):`,
    ctx.oldNet,
  );
  if (input === null) return { done: false };
  const r = commitRename(ctx, input, 'enter');
  if (r.hint) alert(r.hint);
  return r;
}

// Commit-on-blur/Enter net field: typing edits only the input; Esc reverts.
// A refused commit reverts the field and shows `hint` inline (no modal in
// blur). `uni` adds ↑ ↓ Ø quick-insert buttons (insert without committing);
// `children` = extra buttons on the same row.
function NetField({
  label,
  value,
  onCommit,
  uni = false,
  disabled = false,
  title,
  children,
}: {
  label?: string;
  value: string;
  onCommit: (v: string, mode: CommitMode) => CommitOutcome;
  uni?: boolean;
  disabled?: boolean;
  title?: string;
  children?: React.ReactNode;
}): JSX.Element {
  const inputRef = useReactRef<HTMLInputElement>(null);
  // Blur events fired while an Enter commit runs (confirm dialog) or by the
  // blur() right after it must not commit a second time.
  const ignoreBlur = useReactRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const run = (el: HTMLInputElement, mode: CommitMode) => {
    if (el.value === value) { setHint(null); return; }
    const r = onCommit(el.value, mode);
    if (!r.done) el.value = value;
    setHint(r.done ? null : r.hint ?? null);
  };
  const insert = (ch: string) => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    el.focus();
    const pos = start + ch.length;
    el.setSelectionRange(pos, pos);
  };
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        {label && <label className="w-16 text-text-dim">{label}</label>}
        <input
          ref={inputRef}
          key={value}
          className="min-w-0 flex-1 bg-bg-accent px-1 py-0.5"
          defaultValue={value}
          disabled={disabled}
          title={title}
          onInput={() => setHint(null)}
          onKeyDown={(e) => {
            const el = e.currentTarget;
            if (e.key === 'Enter') {
              ignoreBlur.current = true;
              try { run(el, 'enter'); el.blur(); } finally { ignoreBlur.current = false; }
            } else if (e.key === 'Escape') {
              el.value = value;
              setHint(null);
              ignoreBlur.current = true;
              try { el.blur(); } finally { ignoreBlur.current = false; }
            }
          }}
          onBlur={(e) => {
            if (ignoreBlur.current) return;
            run(e.currentTarget, 'blur');
          }}
        />
        {uni && ['↑', '↓', 'Ø'].map((ch) => (
          <button
            key={ch}
            type="button"
            tabIndex={-1}
            className="bg-bg-accent px-1 hover:bg-phosphor-dim hover:text-bg-main"
            title={ch === 'Ø' ? 'Ø (przekreślone 0)' : ch}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(ch)}
          >{ch}</button>
        ))}
        {children}
      </div>
      {hint && <div className="text-[10px] text-error">{hint}</div>}
    </div>
  );
}

// ✎ — rename the whole net of this endpoint. Hidden when there is no net.
function RenameNetButton({ page, ctx }: { page: Page; ctx: NetCtx }): JSX.Element | null {
  if (!normalizeNetName(ctx.oldNet) || !netExists(page, ctx.oldNet)) return null;
  return (
    <button
      type="button"
      tabIndex={-1}
      className="bg-bg-accent px-1 text-text-dim hover:bg-phosphor-dim hover:text-bg-main"
      title={`zmień nazwę netu „${ctx.oldNet}” — wszystkie końcówki na stronie`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { promptRenameNet(ctx); }}
    >✎</button>
  );
}

// × — take this endpoint off its net (net = ''), one undo step.
function DisconnectButton({ ctx }: { ctx: NetCtx }): JSX.Element | null {
  if (!ctx.oldNet || !ctx.ep) return null;
  const ep = ctx.ep;
  return (
    <button
      type="button"
      tabIndex={-1}
      className="bg-bg-accent px-1 text-text-dim hover:bg-error/60 hover:text-bg-main"
      title={`odłącz od netu „${ctx.oldNet}” (tylko ta końcówka)`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!ctxPage(ctx)) return;
        useDocStore.getState().editPage((p) => { disconnectEndpoint(p, ep); });
      }}
    >×</button>
  );
}

// Side inference per ic_map gate_pins category name.
function sideForCategory(key: string): Side {
  const k = key.toLowerCase();
  if (['in', 'd', 'ds', 'j', 'k', 'ser', 'a', 'b', 'sel', 'wa', 'we', 'ra', 're'].includes(k)) return 'left';
  if (['out', 'q', 'nq', 'nout', 'sum', 'cout', 'carry', 'borrow', 'rco', 'nq3'].includes(k)) return 'right';
  return 'top'; // clk, clr, pre, oe, load, en, ent, enp, sh_ld, dir, etc.
}

function IcPicker({
  gate, gateIdx, icMap, currentIc, applyPinout, setIc,
}: {
  gate: { ref: string; gate: string | null };
  gateIdx: number;
  icMap: IcMap;
  currentIc: string | null;
  applyPinout: (ic: string, letter: string) => void;
  setIc: (ic: string) => void;
}): JSX.Element {
  const icOptions = Object.keys(icMap).filter((k) => icMap[k]!.gate_pins);
  const letters = currentIc && icMap[currentIc]?.gate_pins ? Object.keys(icMap[currentIc]!.gate_pins!) : [];
  return (
    <div className="space-y-1 border border-bg-accent p-1">
      <div className="flex items-center gap-1">
        <label className="w-10 text-text-dim">ic</label>
        <select
          value={currentIc ?? ''}
          onChange={(e) => setIc(e.target.value)}
          className="flex-1 bg-bg-accent px-1"
        >
          <option value="">—</option>
          {icOptions.map((k) => (
            <option key={k} value={k}>74{k} — {icMap[k]!.desc?.slice(0, 30) ?? '?'}</option>
          ))}
        </select>
      </div>
      {currentIc && letters.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] text-text-dim">apply pinout (zachowuje nety gdy pin num pasuje):</div>
          {letters.map((L) => {
            const spec = icMap[currentIc]!.gate_pins![L]!;
            const allPins: number[] = [];
            for (const arr of Object.values(spec)) if (Array.isArray(arr)) allPins.push(...arr);
            const summary = Object.entries(spec)
              .map(([k, v]) => Array.isArray(v) ? `${k}:${v.join(',')}` : '')
              .filter(Boolean)
              .join(' · ');
            const isCurrent = gate.gate === L;
            return (
              <button
                key={L}
                className={`w-full px-2 py-0.5 text-left text-[11px] ${isCurrent ? 'bg-phosphor-dim text-bg-main' : 'bg-bg-accent hover:bg-phosphor-dim'}`}
                onClick={() => applyPinout(currentIc, L)}
                title={summary}
              >
                <span className="font-bold">⟳ {L}</span>{' '}
                <span className="text-text-dim">[{allPins.join(',')}]</span>{' '}
                <span className="text-[10px]">{summary}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="text-[10px] text-text-dim">gateIdx {gateIdx}</div>
    </div>
  );
}

function applyPinout(
  editPage: (m: (p: Page) => void) => void,
  editPackage: ((m: (p: import('@kronikarz/shared').Package) => void) => void),
  gateIdx: number,
  ic: string,
  letter: string,
  icMap: IcMap,
  page: Page,
  pkg: import('@kronikarz/shared').Package | null,
): void {
  const spec = icMap[ic]?.gate_pins?.[letter] as Record<string, number[]> | undefined;
  if (!spec) return;
  const g = page.gates[gateIdx];
  if (!g) return;

  // Compute target pin list with side from category
  type Target = { num: number; side: Side };
  const targets: Target[] = [];
  for (const [cat, arr] of Object.entries(spec)) {
    const side = sideForCategory(cat);
    for (const num of arr) targets.push({ num, side });
  }

  // Existing pins by num (preserve net + px/py if num matches)
  const existing = new Map(g.pins.map((p) => [p.num, p]));

  // Default placement: distribute along each side
  const halfW = (g.w ?? 80) / 2;
  const halfH = (g.h ?? 110) / 2;
  const groups = { left: [] as Target[], right: [] as Target[], top: [] as Target[], bottom: [] as Target[] };
  for (const t of targets) groups[t.side].push(t);
  for (const side of Object.keys(groups) as Side[]) groups[side].sort((a, b) => a.num - b.num);

  function place(side: Side, idx: number, total: number): { lx: number; ly: number } {
    const f = total === 1 ? 0.5 : idx / (total - 1);
    if (side === 'left') return { lx: -halfW, ly: -halfH + f * 2 * halfH };
    if (side === 'right') return { lx: halfW, ly: -halfH + f * 2 * halfH };
    if (side === 'top') return { lx: -halfW + f * 2 * halfW, ly: -halfH };
    return { lx: -halfW + f * 2 * halfW, ly: halfH };
  }

  const rad = (g.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  editPage((p) => {
    const tg = p.gates[gateIdx];
    if (!tg) return;
    tg.gate = letter;
    const newPins: typeof tg.pins = [];
    for (const side of ['left', 'right', 'top', 'bottom'] as Side[]) {
      const list = groups[side];
      list.forEach((t, i) => {
        const ex = existing.get(t.num);
        const { lx, ly } = place(side, i, list.length);
        const npx = ex?.px ?? Math.round(tg.x + lx * cos - ly * sin);
        const npy = ex?.py ?? Math.round(tg.y + lx * sin + ly * cos);
        newPins.push({
          num: t.num,
          side: t.side,
          net: ex?.net ?? '',
          px: npx,
          py: npy,
          ...(ex?.cross ? { cross: ex.cross } : {}),
        });
      });
    }
    tg.pins = newPins;
  });

  // Sync package.components[ref].gates — add new letter if missing.
  if (pkg) {
    const g = page.gates[gateIdx];
    if (g) {
      editPackage((p) => {
        const comp = p.components[g.ref];
        if (!comp) return;
        if (comp.ic === null) return;
        const gates = comp.gates as Record<string, { page: string } | null>;
        if (!(letter in gates)) gates[letter] = { page: page.page };
      });
    }
  }
}

function SegmentPanel({ netName, segmentIdx }: { netName: string; segmentIdx: number }): JSX.Element {
  const page = useDocStore((s) => s.page);
  const editPage = useDocStore((s) => s.editPage);
  const setSelection = useDocStore((s) => s.setSelection);
  if (!page) return <></>;
  const seg = page.nets[netName]?.segments?.[segmentIdx];
  if (!seg) return <></>;
  const segCtx = netCtx(undefined, netName);
  return (
    <div className="space-y-2">
      <h2 className="font-bold text-selected">SEGMENT #{segmentIdx}</h2>
      <NetField
        label="net"
        value={netName}
        title="zmienia nazwę całego netu (wszystkie końcówki); istniejący net → Enter + potwierdzenie"
        onCommit={(v, mode) => {
          const r = commitRename(segCtx, v, mode);
          // Merge appends this net's segments after the target's, so the
          // segment index is no longer valid — select the whole net then.
          if (r.done && r.name) setSelection(r.merged ? { kind: 'net', name: r.name } : { kind: 'segment', netName: r.name, segmentIdx });
          return r;
        }}
      />
      <div className="text-text-dim">
        ({seg[0]},{seg[1]}) → ({seg[2]},{seg[3]})
      </div>
      <div className="space-y-1">
        <button
          className="w-full bg-bg-accent px-2 py-0.5 text-left hover:bg-phosphor-dim"
          onClick={() => {
            editPage((p) => {
              const segs = p.nets[netName]?.segments;
              if (!segs) return;
              const s = segs[segmentIdx];
              if (!s) return;
              const mx = Math.round((s[0] + s[2]) / 2);
              const my = Math.round((s[1] + s[3]) / 2);
              // Replace segment with two halves
              segs.splice(segmentIdx, 1, [s[0], s[1], mx, my], [mx, my, s[2], s[3]]);
            });
          }}
        >
          + węzeł na środku (rozdziel)
        </button>
        <button
          className="w-full bg-bg-accent px-2 py-0.5 text-left hover:bg-phosphor-dim"
          onClick={() => splitNetCluster(editPage, netName, segmentIdx, setSelection)}
          title="wydziel ten klaster (połączone segmenty) do nowego netu z losową nazwą"
        >
          ⤴ split off → nowy net (losowa nazwa)
        </button>
        <button
          className="w-full bg-error/40 px-2 py-0.5 text-left text-error hover:bg-error/60"
          onClick={() => {
            editPage((p) => {
              const segs = p.nets[netName]?.segments;
              if (!segs) return;
              segs.splice(segmentIdx, 1);
            });
            setSelection({ kind: 'net', name: netName });
          }}
        >
          usuń segment
        </button>
      </div>
    </div>
  );
}

// BFS through segments connected at endpoints (tol=2). All elements (pins,
// ports, cross_refs, segments, junctions) at reachable points get reassigned
// to a fresh randomized net name. Useful when two disconnected wires share
// the same net name and the validator flags NET_DISCONNECTED — splitting
// one cluster off resolves it.
function splitNetCluster(
  editPage: (m: (p: Page) => void) => void,
  netName: string,
  segmentIdx: number,
  setSelection: ReturnType<typeof useDocStore.getState>['setSelection'],
): void {
  const TOL = 2;
  const newName = `${netName}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  editPage((p) => {
    const net = p.nets[netName];
    if (!net || !net.segments) return;
    const seedSeg = net.segments[segmentIdx];
    if (!seedSeg) return;

    const matchPt = (ax: number, ay: number, bx: number, by: number): boolean =>
      Math.abs(ax - bx) <= TOL && Math.abs(ay - by) <= TOL;

    // BFS reachable points
    const reachable: Array<{ x: number; y: number }> = [];
    const queue: Array<{ x: number; y: number }> = [
      { x: seedSeg[0], y: seedSeg[1] },
      { x: seedSeg[2], y: seedSeg[3] },
    ];
    const visited = (x: number, y: number): boolean => reachable.some((r) => matchPt(r.x, r.y, x, y));
    while (queue.length) {
      const cur = queue.shift()!;
      if (visited(cur.x, cur.y)) continue;
      reachable.push(cur);
      for (const s of net.segments) {
        if (matchPt(s[0], s[1], cur.x, cur.y)) queue.push({ x: s[2], y: s[3] });
        if (matchPt(s[2], s[3], cur.x, cur.y)) queue.push({ x: s[0], y: s[1] });
      }
    }

    const isReachable = (x: number, y: number): boolean => reachable.some((r) => matchPt(r.x, r.y, x, y));

    // Move segments
    const movedSegs: typeof net.segments = [];
    const keptSegs: typeof net.segments = [];
    for (const s of net.segments) {
      if (isReachable(s[0], s[1]) || isReachable(s[2], s[3])) movedSegs.push(s);
      else keptSegs.push(s);
    }
    net.segments = keptSegs;

    // Move junctions
    let movedJunctions: Array<[number, number]> = [];
    if (net.junctions) {
      movedJunctions = net.junctions.filter((j) => isReachable(j[0], j[1]));
      net.junctions = net.junctions.filter((j) => !isReachable(j[0], j[1]));
      if (net.junctions.length === 0) net.junctions = null;
    }

    p.nets[newName] = {
      pins: [],
      segments: movedSegs,
      junctions: movedJunctions.length ? movedJunctions : null,
    };

    // Reassign pins/ports/cross_refs whose coords match reachable points
    for (const g of p.gates) {
      for (const pin of g.pins) {
        if (pin.net === netName && isReachable(pin.px, pin.py)) pin.net = newName;
      }
    }
    for (const port of p.ports ?? []) {
      const labelWidth = Math.max(60, `${port.connector}${port.pin}`.length * 16 + 12);
      const bw = labelWidth + 16;
      const rot = port.side === 'left' ? 0 : port.side === 'right' ? 180 : port.side === 'top' ? 90 : 270;
      const rad = (rot * Math.PI) / 180;
      const ex = Math.round(port.x + bw * Math.cos(rad));
      const ey = Math.round(port.y + bw * Math.sin(rad));
      if (port.net === netName && isReachable(ex, ey)) port.net = newName;
    }
    for (const cr of p.cross_refs ?? []) {
      if (cr.net === netName && isReachable(cr.x, cr.y)) cr.net = newName;
    }
  });
  setSelection({ kind: 'net', name: newName });
}


/** Grupa pól jednego aspektu: wyłączona, gdy aspekt nie należy do bieżącego kroku. */
function Asp({ off, children }: { off: boolean; children: ReactNode }): JSX.Element {
  return (
    <fieldset disabled={off} className="contents">
      {children}
    </fieldset>
  );
}
