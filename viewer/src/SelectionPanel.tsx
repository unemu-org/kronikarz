import { useDocStore } from './store.ts';

export function SelectionPanel(): JSX.Element | null {
  const page = useDocStore((s) => s.page);
  const icMap = useDocStore((s) => s.icMap);
  const pkg = useDocStore((s) => s.pkg);
  const selection = useDocStore((s) => s.selection);
  const issues = useDocStore((s) => s.issues);

  if (!page) return null;
  const gate =
    selection?.kind === 'gate' && selection.idx >= 0 && selection.idx < page.gates.length
      ? page.gates[selection.idx]!
      : null;
  const net = selection?.kind === 'net' ? page.nets[selection.name] : null;
  const netName = selection?.kind === 'net' ? selection.name : null;
  const comp = gate && pkg ? pkg.components[gate.ref] : null;
  const icDef = comp && comp.ic && icMap ? icMap[comp.ic] : null;

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-bg-accent bg-bg-panel p-2 text-xs">
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
            segmenty: {net.segments?.length ?? 'null'} · junctions: {net.junctions?.length ?? 'null'}
          </div>
          {net.cross && (
            <div className="text-warning">cross → {net.cross.page} ({net.cross.label})</div>
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
