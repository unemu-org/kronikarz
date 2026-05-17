import { useDocStore } from './store.ts';

export function SelectionPanel(): JSX.Element | null {
  const page = useDocStore((s) => s.page);
  const icMap = useDocStore((s) => s.icMap);
  const pkg = useDocStore((s) => s.pkg);
  const idx = useDocStore((s) => s.selectedGateIdx);
  const issues = useDocStore((s) => s.issues);

  if (!page) return null;
  const gate = idx !== null ? page.gates[idx] : null;
  const comp = gate && pkg ? pkg.components[gate.ref] : null;
  const icDef = comp && comp.ic && icMap ? icMap[comp.ic] : null;

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-bg-accent bg-bg-panel p-2 text-xs">
      {!gate && <div className="text-text-dim">brak zaznaczenia</div>}
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
          <div>
            <h3 className="text-text-dim">PINY</h3>
            <ul>
              {gate.pins.map((p) => (
                <li key={p.num}>
                  <span className="text-phosphor">{p.num}</span>{' '}
                  <span className="text-text-dim">{p.side}</span> {p.net}
                  {p.cross && (
                    <span className="text-warning"> → {p.cross.page}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <hr className="border-bg-accent" />
          <div className="text-text-dim">
            x={gate.x} y={gate.y} rot={gate.rotation}
          </div>
          <div>
            verified:{' '}
            <span className={gate.verified ? 'text-verified' : 'text-warning'}>
              {gate.verified ? 'tak' : 'nie'}
            </span>
          </div>
          {gate.note && <div>note: {gate.note}</div>}
        </div>
      )}
      <hr className="my-3 border-bg-accent" />
      <h3 className="text-text-dim">WALIDACJA — {issues.length}</h3>
      <ul className="space-y-0.5 text-[10px]">
        {issues.slice(0, 50).map((i, k) => (
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
