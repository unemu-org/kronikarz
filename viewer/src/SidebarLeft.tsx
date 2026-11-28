import { useDocStore } from './store.ts';
import { navigate } from './router.ts';
import { StepMarks, usePagesLive } from './StepMarks.tsx';

export function SidebarLeft(): JSX.Element | null {
  const project = useDocStore((s) => s.project);
  const pkg = useDocStore((s) => s.pkg);
  const route = useDocStore((s) => s.route);
  const pages = usePagesLive();

  if (!project) return null;

  return (
    <aside className="w-48 shrink-0 overflow-y-auto border-r border-bg-accent bg-bg-panel p-2 text-xs">
      <h2 className="mb-1 text-text-dim">PAKIETY</h2>
      <ul className="mb-3">
        {project.packages.map((p) => (
          <li key={p.id}>
            <button
              className={`block w-full text-left px-1 py-0.5 ${
                route.pkg === p.id ? 'bg-bg-accent text-phosphor' : 'hover:bg-bg-accent'
              }`}
              onClick={() => navigate({ mode: 'package', pkg: p.id })}
            >
              {p.id}
            </button>
          </li>
        ))}
      </ul>
      {pkg && (
        <>
          <h2 className="mb-1 text-text-dim">STRONY — {pkg.package.id}</h2>
          <ul>
            {pkg.package.pages.map((p) => (
              <li key={p.id}>
                <button
                  className={`flex w-full items-center text-left px-1 py-0.5 ${
                    route.page === p.id ? 'bg-bg-accent text-phosphor' : 'hover:bg-bg-accent'
                  }`}
                  onClick={() => navigate({ mode: 'page', pkg: pkg.package.id, page: p.id })}
                >
                  {p.id}{' '}
                  <span className="text-text-dim">
                    {p.status === 'verified'
                      ? 'V'
                      : p.status === 'done'
                        ? '·'
                        : p.status === 'wip'
                          ? '…'
                          : ''}
                  </span>
                  <span className="ml-auto text-[10px]">
                    <StepMarks page={pages.get(p.id)} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
