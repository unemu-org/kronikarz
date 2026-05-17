import type { ChangeEvent } from 'react';
import { useDocStore } from './store.ts';

const ROTATIONS: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];

export function SelectionPanel(): JSX.Element | null {
  const page = useDocStore((s) => s.page);
  const icMap = useDocStore((s) => s.icMap);
  const pkg = useDocStore((s) => s.pkg);
  const selection = useDocStore((s) => s.selection);
  const issues = useDocStore((s) => s.issues);
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
          <h2 className="font-bold text-net-active">{netName}</h2>
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
        </div>
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

      <hr className="my-3 border-bg-accent" />
      <h3 className="text-text-dim">WALIDACJA — {issues.length}</h3>
      <ul className="space-y-0.5 text-[10px]">
        {issues.slice(0, 100).map((i, k) => (
          <li
            key={k}
            className={
              i.level === 'err'
                ? 'text-error'
                : i.level === 'warn'
                  ? 'text-warning'
                  : 'text-text-dim'
            }
          >
            <span className="font-bold">{i.level.toUpperCase()}</span> {i.code}: {i.message}
          </li>
        ))}
      </ul>
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
