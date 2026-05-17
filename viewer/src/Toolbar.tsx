import { useDocStore } from './store.ts';
import { navigate } from './router.ts';

export function Toolbar(): JSX.Element {
  const route = useDocStore((s) => s.route);
  const project = useDocStore((s) => s.project);
  const pkg = useDocStore((s) => s.pkg);
  const opacity = useDocStore((s) => s.scanOpacity);
  const setOpacity = useDocStore((s) => s.setScanOpacity);
  const zoom = useDocStore((s) => s.zoom);
  const tool = useDocStore((s) => s.tool);
  const setTool = useDocStore((s) => s.setTool);

  return (
    <header className="flex items-center gap-3 border-b border-bg-accent bg-bg-panel px-3 py-1.5 text-xs">
      <button
        onClick={() => navigate({ mode: 'module' })}
        className="font-bold text-phosphor hover:text-phosphor-dim"
      >
        ☰ KRONIKARZ
      </button>
      {project && route.mode !== 'module' && (
        <select
          value={route.pkg ?? ''}
          onChange={(e) => navigate({ mode: 'package', pkg: e.target.value })}
          className="bg-bg-accent px-2 py-0.5 border border-bg-accent text-text-main"
        >
          <option value="">— pakiet —</option>
          {project.packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
      )}
      {pkg && route.mode === 'page' && (
        <select
          value={route.page ?? ''}
          onChange={(e) => navigate({ mode: 'page', pkg: route.pkg, page: e.target.value })}
          className="bg-bg-accent px-2 py-0.5 border border-bg-accent text-text-main"
        >
          {pkg.package.pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
      )}
      <div className="ml-2 flex items-center gap-1 border-l border-bg-accent pl-3">
        <button
          onClick={() => setTool('select')}
          className={`px-2 py-0.5 ${tool === 'select' ? 'bg-phosphor-dim text-bg-main' : 'text-text-dim'}`}
          title="V — zaznacz"
        >
          V
        </button>
        <button
          onClick={() => setTool('edit')}
          className={`px-2 py-0.5 ${tool === 'edit' ? 'bg-phosphor-dim text-bg-main' : 'text-text-dim'}`}
          title="E — edytuj"
        >
          E
        </button>
      </div>
      <span className="ml-3 text-text-dim">zoom: {Math.round(zoom * 100)}%</span>
      <div className="flex items-center gap-2">
        <span className="text-text-dim">opacity:</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(opacity * 100)}
          onChange={(e) => setOpacity(Number(e.target.value) / 100)}
          className="w-24"
        />
        <span className="w-8 text-text-dim">{Math.round(opacity * 100)}%</span>
      </div>
    </header>
  );
}
