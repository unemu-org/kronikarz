import { useDocStore } from './store.ts';
import { navigate } from './router.ts';

export function ValidationPanel(): JSX.Element {
  const issues = useDocStore((s) => s.issues);
  const route = useDocStore((s) => s.route);
  const project = useDocStore((s) => s.project);
  const pkg = useDocStore((s) => s.pkg);
  const setSelection = useDocStore((s) => s.setSelection);

  const counts = issues.reduce(
    (a, i) => ({ ...a, [i.level]: (a[i.level] ?? 0) + 1 }),
    { err: 0, warn: 0, info: 0 } as Record<'err' | 'warn' | 'info', number>,
  );

  function onIssueClick(code: string, ref?: string) {
    if (!ref) return;
    // Issues with ref like "M5.A" → if in page, select that gate
    if (route.mode === 'page' && useDocStore.getState().page) {
      const page = useDocStore.getState().page!;
      const refRoot = ref.split('.')[0];
      const idx = page.gates.findIndex((g) => g.ref === refRoot);
      if (idx >= 0) {
        setSelection({ kind: 'gate', idx });
        return;
      }
      if (page.nets[ref]) {
        setSelection({ kind: 'net', name: ref });
        return;
      }
    }
    // Backplane signal etc — try jump to first package containing it
    if (project) {
      for (const p of project.packages) {
        if (ref.startsWith(p.id)) {
          navigate({ mode: 'package', pkg: p.id });
          return;
        }
      }
    }
  }

  return (
    <section className="border-t border-bg-accent bg-bg-panel p-2 text-xs">
      <div className="flex items-center gap-3">
        <h3 className="font-bold text-text-dim">WALIDACJA</h3>
        <span className="text-error">{counts.err} err</span>
        <span className="text-warning">{counts.warn} warn</span>
        <span className="text-text-dim">{counts.info} info</span>
        <span className="ml-auto text-text-dim">
          {pkg ? `${pkg.package.id}` : project ? project.project.name : '—'}
        </span>
      </div>
      <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-[10px]">
        {issues.length === 0 && <li className="text-text-dim">— brak problemów —</li>}
        {issues.map((i, k) => (
          <li
            key={k}
            className={`cursor-pointer hover:bg-bg-accent ${
              i.level === 'err'
                ? 'text-error'
                : i.level === 'warn'
                  ? 'text-warning'
                  : 'text-text-dim'
            }`}
            onClick={() => onIssueClick(i.code, i.ref)}
            title={i.ref ?? ''}
          >
            <span className="font-bold">{i.level.toUpperCase()}</span> {i.code}: {i.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
