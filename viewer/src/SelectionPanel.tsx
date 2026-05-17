import type { ChangeEvent } from 'react';
import type { Page } from '@kronikarz/shared';
import { parsePinId } from '@kronikarz/shared';
import { useDocStore } from './store.ts';

const ROTATIONS: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];

export function SelectionPanel(): JSX.Element | null {
  const page = useDocStore((s) => s.page);
  const icMap = useDocStore((s) => s.icMap);
  const pkg = useDocStore((s) => s.pkg);
  const selection = useDocStore((s) => s.selection);
  const tool = useDocStore((s) => s.tool);
  const editPage = useDocStore((s) => s.editPage);
  const saveStatus = useDocStore((s) => s.saveStatus);
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
  const icDef = comp && comp.ic && icMap ? icMap[comp.ic] : null;

  const updateGate = (mutator: (g: NonNullable<typeof gate>) => void) => {
    if (gateIdx === null) return;
    editPage((p) => {
      const g = p.gates[gateIdx];
      if (g) mutator(g);
    });
  };

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-bg-accent bg-bg-panel p-2 text-xs">
      <SaveBadge status={saveStatus} />
      {!gate && !net && <div className="text-text-dim">brak zaznaczenia</div>}

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
          <hr className="border-bg-accent" />
          {editing ? (
            <div className="space-y-1">
              <Field
                label="ref"
                value={gate.ref}
                onChange={(v) => updateGate((g) => (g.ref = v))}
              />
              <Field
                label="gate"
                value={gate.gate ?? ''}
                onChange={(v) => updateGate((g) => (g.gate = v || null))}
              />
              <div className="flex items-center gap-2">
                <label className="w-16 text-text-dim">rotation</label>
                <select
                  className="flex-1 bg-bg-accent px-1 py-0.5"
                  value={gate.rotation}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    updateGate((g) => (g.rotation = Number(e.target.value) as 0 | 90 | 180 | 270))
                  }
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
                <li key={p.num} className="flex items-center gap-1">
                  <span className="w-4 text-phosphor">{p.num}</span>
                  <span className="w-8 text-text-dim">{p.side}</span>
                  {editing ? (
                    <input
                      className="flex-1 bg-bg-accent px-1"
                      value={p.net}
                      onChange={(e) =>
                        updateGate((g) => {
                          const pin = g.pins[pi];
                          if (pin) pin.net = e.target.value;
                        })
                      }
                    />
                  ) : (
                    <span className="flex-1">{p.net}</span>
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
  });
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
      <h2 className="font-bold text-selected">SEGMENT {netName} #{segmentIdx}</h2>
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

function SaveBadge({ status }: { status: 'idle' | 'pending' | 'saving' | 'error' }): JSX.Element {
  if (status === 'idle') return <></>;
  const colors = {
    pending: 'text-text-dim',
    saving: 'text-warning',
    error: 'text-error',
  } as const;
  const label = { pending: 'zmiana...', saving: 'zapisuje', error: 'blad zapisu' }[status];
  return <div className={`mb-2 text-[10px] ${colors[status]}`}>{label}</div>;
}
