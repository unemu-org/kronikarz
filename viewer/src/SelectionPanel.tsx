import type { ChangeEvent } from 'react';
import { useRef as useReactRef } from 'react';
import type { Page, Side, IcMap } from '@kronikarz/shared';
import { parsePinId, resolveIcKey } from '@kronikarz/shared';
import { useDocStore } from './store.ts';
import { apiWrite } from './api.ts';
import { passivePins } from './AddGateDialog.tsx';

const ROTATIONS: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];
const SIDES: Side[] = ['left', 'right', 'top', 'bottom'];

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

  if (!page) return null;
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
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-bg-accent bg-bg-panel p-2 text-xs">
      {!gate && !net && selection?.kind !== 'segment' && selection?.kind !== 'port' && selection?.kind !== 'cross_ref' && selection?.kind !== 'power' && selection?.kind !== 'annotation' && selection?.kind !== 'decoration' && (
        <div className="text-text-dim">brak zaznaczenia</div>
      )}

      {selection?.kind === 'power' && (() => {
        const idx = selection.idx;
        const ps = page.power?.[idx];
        if (!ps) return null;
        return (
          <div className="space-y-2">
            <h2 className="font-bold text-phosphor">{ps.type}</h2>
            {editing ? (
              <>
                <Field
                  label="type"
                  value={ps.type}
                  onChange={(v) => editPage((p) => { const t = p.power[idx]; if (t) t.type = v; })}
                />
                <Field
                  label="net"
                  value={ps.net}
                  onChange={(v) => editPage((p) => { const t = p.power[idx]; if (t) t.net = v; })}
                />
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
              </>
            ) : (
              <div className="text-text-dim">x={ps.x} y={ps.y} rot={ps.rotation ?? 0}</div>
            )}
          </div>
        );
      })()}

      {net && netName && (
        <div className="space-y-2">
          {editing ? (
            <div className="flex items-center gap-2">
              <span className="text-net-active">net:</span>
              <input
                className="flex-1 bg-bg-accent px-1 py-0.5 font-bold text-net-active"
                defaultValue={netName}
                onBlur={(e) => {
                  const newName = e.target.value.trim();
                  if (!newName || newName === netName) return;
                  renameNet(editPage, netName, newName);
                  useDocStore.getState().setSelection({ kind: 'net', name: newName });
                }}
              />
            </div>
          ) : (
            <h2 className="font-bold text-net-active">{netName}</h2>
          )}
          <hr className="border-bg-accent" />
          <div>
            <h3 className="text-text-dim">PINY ({net.pins.length})</h3>
            <ul>
              {net.pins.map((p) => (
                <li key={p} className="text-phosphor">
                  {p}
                </li>
              ))}
            </ul>
          </div>
          <div className="text-text-dim">
            segmenty: {net.segments?.length ?? 'null'} · junctions:{' '}
            {net.junctions?.length ?? 'null'}
          </div>
          {net.cross && (
            <div className="text-warning">
              cross → {net.cross.page} ({net.cross.label})
            </div>
          )}
          {editing && (
            <div className="space-y-1 border-t border-bg-accent pt-2">
              <button
                className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-main hover:bg-phosphor-dim"
                onClick={() =>
                  editPage((p) => {
                    const n = p.nets[netName];
                    if (!n) return;
                    n.junctions = [...(n.junctions ?? [])];
                    // Add junction at average of all pins of this net
                    const pts = n.pins
                      .map((pid) => findPinPos(p, pid))
                      .filter((q): q is { x: number; y: number } => !!q);
                    if (pts.length) {
                      const cx = Math.round(pts.reduce((a, b) => a + b.x, 0) / pts.length);
                      const cy = Math.round(pts.reduce((a, b) => a + b.y, 0) / pts.length);
                      n.junctions.push([cx, cy]);
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
              <button
                className="w-full bg-bg-accent px-2 py-0.5 text-left text-text-main hover:bg-phosphor-dim"
                onClick={() => {
                  const rand = `${netName}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
                  renameNet(editPage, netName, rand);
                  useDocStore.getState().setSelection({ kind: 'net', name: rand });
                }}
                title="losowa nazwa — szybki fix konfliktu nazw"
              >
                🎲 randomize name
              </button>
            </div>
          )}
        </div>
      )}

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
        return (
          <div className="space-y-2">
            <h2 className="font-bold text-phosphor">PORT {port.connector}{port.pin}</h2>
            <hr className="border-bg-accent" />
            <Field label="connector" value={port.connector} onChange={(v) => editPage((p) => { const x = p.ports?.[idx]; if (x) x.connector = v.trim().toUpperCase(); })} />
            <Field label="pin" value={String(port.pin)} onChange={(v) => editPage((p) => { const x = p.ports?.[idx]; if (x) { const n = parseInt(v, 10); if (Number.isFinite(n)) x.pin = n; } })} />
            <FieldUni label="label" value={port.label} onChange={(v) => editPage((p) => { const x = p.ports?.[idx]; if (x) x.label = v; })} />
            <FieldUni label="net" value={port.net} onChange={(v) => {
              const old = port.net;
              if (!v || v === old) return;
              if (old && old.trim() && page.nets[old]) {
                renameNet(editPage, old, v);
              } else {
                editPage((p) => { const x = p.ports?.[idx]; if (x) x.net = v; });
              }
            }} />
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
          </div>
        );
      })()}

      {selection?.kind === 'cross_ref' && (() => {
        const cr = page.cross_refs?.[selection.idx];
        if (!cr) return null;
        const idx = selection.idx;
        return (
          <div className="space-y-2">
            <h2 className="font-bold text-phosphor">CROSS-REF {cr.label}</h2>
            <hr className="border-bg-accent" />
            <FieldUni label="label" value={cr.label} onChange={(v) => editPage((p) => { const x = p.cross_refs?.[idx]; if (x) x.label = v; })} />
            <FieldUni label="net" value={cr.net} onChange={(v) => {
              const old = cr.net;
              if (!v || v === old) return;
              if (old && old.trim() && page.nets[old]) {
                renameNet(editPage, old, v);
              } else {
                editPage((p) => { const x = p.cross_refs?.[idx]; if (x) x.net = v; });
              }
            }} />
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
                const targets = pkg.package.pages.filter((p) => p.id !== page.page);
                if (!confirm(`Skopiować ten tekst do ${targets.length} pozostałych stron pakietu?`)) return;
                let ok = 0;
                for (const ref of targets) {
                  try {
                    const path = `MJC-400/${pkg.package.id}/pages/${ref.id}.sch.yaml`;
                    const r = await fetch(`/files/${path}`);
                    if (!r.ok) continue;
                    const txt = await r.text();
                    const { parsePage, serializePage } = await import('@kronikarz/shared');
                    const pg = parsePage(txt, path);
                    pg.annotations ??= [];
                    // Skip jezeli juz istnieje identyczny tekst w identycznej pozycji
                    if (pg.annotations.some((a) => a.text === ann.text && a.x === ann.x && a.y === ann.y)) continue;
                    pg.annotations.push({ text: ann.text, x: ann.x, y: ann.y, fontSize: ann.fontSize });
                    await apiWrite(`/files/${path}`, { method: 'PUT', body: serializePage(pg) });
                    ok++;
                  } catch { /* skip */ }
                }
                alert(`Skopiowano do ${ok}/${targets.length} stron.`);
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
                const targets = pkg.package.pages.filter((p) => p.id !== page.page);
                if (!confirm(`Skopiować do ${targets.length} pozostałych stron pakietu?`)) return;
                let ok = 0;
                for (const ref of targets) {
                  try {
                    const path = `MJC-400/${pkg.package.id}/pages/${ref.id}.sch.yaml`;
                    const r = await fetch(`/files/${path}`);
                    if (!r.ok) continue;
                    const txt = await r.text();
                    const { parsePage, serializePage } = await import('@kronikarz/shared');
                    const pg = parsePage(txt, path);
                    pg.decorations ??= [];
                    // Dedup by identyczne pola
                    const sig = JSON.stringify(d);
                    if (pg.decorations.some((dd) => JSON.stringify(dd) === sig)) continue;
                    pg.decorations.push({ ...d });
                    await apiWrite(`/files/${path}`, { method: 'PUT', body: serializePage(pg) });
                    ok++;
                  } catch { /* skip */ }
                }
                alert(`Skopiowano do ${ok}/${targets.length} stron.`);
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
          )}
          {gate && comp?.ic === null && editing && (
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
                  {editing ? (
                    <input
                      className="flex-1 bg-bg-accent px-1"
                      defaultValue={p.net}
                      key={p.net}
                      disabled={p.disconnected}
                      onBlur={(e) => {
                        const v = e.target.value;
                        const old = p.net;
                        if (v === old) return;
                        if (old && old.trim() && page.nets[old]) {
                          renameNet(editPage, old, v);
                        } else {
                          updateGate((g) => {
                            const pin = g.pins[pi];
                            if (pin) pin.net = v;
                          });
                        }
                      }}
                    />
                  ) : (
                    <span className="flex-1">{p.disconnected ? 'NC' : p.net}</span>
                  )}
                  {editing && (
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

function findPinPos(p: Page, pid: string): { x: number; y: number } | null {
  try {
    const { ref, gate, num } = parsePinId(pid);
    for (const g of p.gates) {
      if (g.ref !== ref) continue;
      if (gate !== null && g.gate !== gate) continue;
      const pin = g.pins.find((pp) => pp.num === num);
      if (pin) return { x: pin.px, y: pin.py };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function renameNet(editPage: (m: (p: Page) => void) => void, oldName: string, newName: string) {
  editPage((p) => {
    if (!p.nets[oldName]) return;
    if (p.nets[newName]) {
      // Merge into existing
      const existing = p.nets[newName];
      const src = p.nets[oldName]!;
      existing.pins = Array.from(new Set([...existing.pins, ...src.pins]));
      if (src.segments) {
        existing.segments = [...(existing.segments ?? []), ...src.segments];
      }
      if (src.junctions) {
        existing.junctions = [...(existing.junctions ?? []), ...src.junctions];
      }
      delete p.nets[oldName];
    } else {
      p.nets[newName] = p.nets[oldName]!;
      delete p.nets[oldName];
    }
    for (const g of p.gates) {
      for (const pin of g.pins) {
        if (pin.net === oldName) pin.net = newName;
      }
    }
    for (const ps of p.power) {
      if (ps.net === oldName) ps.net = newName;
    }
    for (const port of p.ports ?? []) {
      if (port.net === oldName) port.net = newName;
    }
    for (const cr of p.cross_refs ?? []) {
      if (cr.net === oldName) cr.net = newName;
    }
  });
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
  return (
    <div className="space-y-2">
      <h2 className="font-bold text-selected">SEGMENT #{segmentIdx}</h2>
      <label className="block">
        <span className="text-text-dim">net:</span>
        <input
          type="text"
          className="ml-2 bg-bg-accent px-2 py-0.5 text-text-main"
          defaultValue={netName}
          key={netName}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v || v === netName) return;
            renameNet(editPage, netName, v);
            setSelection({ kind: 'segment', netName: v, segmentIdx });
          }}
        />
      </label>
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

