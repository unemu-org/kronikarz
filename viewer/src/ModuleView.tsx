import { useDocStore } from './store.ts';
import { navigate } from './router.ts';

export function ModuleView(): JSX.Element | null {
  const project = useDocStore((s) => s.project);
  if (!project) return null;
  return (
    <div className="flex flex-1 overflow-auto">
      <main className="flex-1 p-4 text-xs">
        <h1 className="mb-3 text-xl font-bold text-phosphor">
          {project.project.name}
        </h1>
        <div className="mb-4 text-text-dim">
          {project.project.desc} · {project.project.doc} · status {project.project.status}
        </div>
        <h2 className="mb-2 text-text-dim">PAKIETY</h2>
        <table className="mb-6 w-full max-w-xl">
          <tbody>
            {project.packages.map((p) => (
              <tr key={p.id} className="border-b border-bg-accent">
                <td>
                  <button
                    className="text-phosphor hover:underline"
                    onClick={() => navigate({ mode: 'package', pkg: p.id })}
                  >
                    {p.id}
                  </button>
                </td>
                <td className="text-text-dim">{p.name}</td>
                <td className="text-text-dim">{p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2 className="mb-2 text-text-dim">BACKPLANE SIGNALS ({project.backplane.length})</h2>
        <table className="w-full max-w-3xl">
          <tbody>
            {project.backplane.map((s, i) => (
              <tr key={i} className="border-b border-bg-accent">
                <td className="text-phosphor">{s.signal}</td>
                <td className="text-text-dim">
                  {s.endpoints.map((ep, k) => (
                    <button
                      key={k}
                      className="mr-2 hover:text-phosphor"
                      onClick={() => navigate({ mode: 'package', pkg: ep.package })}
                    >
                      {ep.package}/{ep.connector}{ep.pin}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
            {project.backplane.length === 0 && (
              <tr>
                <td className="text-text-dim">brak</td>
              </tr>
            )}
          </tbody>
        </table>
      </main>
    </div>
  );
}
