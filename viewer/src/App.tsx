import { useHashRouter } from './router.ts';
import { useLoader } from './loader.ts';
import { Canvas } from './Canvas.tsx';
import { Toolbar } from './Toolbar.tsx';
import { SidebarLeft } from './SidebarLeft.tsx';
import { SelectionPanel } from './SelectionPanel.tsx';
import { useDocStore } from './store.ts';

export function App(): JSX.Element {
  useHashRouter();
  useLoader();
  const route = useDocStore((s) => s.route);
  const pkg = useDocStore((s) => s.pkg);
  const page = useDocStore((s) => s.page);
  const issues = useDocStore((s) => s.issues);
  const loadError = useDocStore((s) => s.loadError);
  const opacity = useDocStore((s) => s.scanOpacity);
  const zoom = useDocStore((s) => s.zoom);

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      {loadError && (
        <div className="bg-error/30 px-4 py-1 text-xs text-error">! {loadError}</div>
      )}
      <main className="flex flex-1 overflow-hidden">
        <SidebarLeft />
        <Canvas />
        <SelectionPanel />
      </main>
      <footer className="flex items-center gap-4 border-t border-bg-accent bg-bg-panel px-3 py-1 text-[11px] text-text-dim">
        {page && (
          <span>
            strona: <span className="text-text-main">{page.page}</span> | pakiet:{' '}
            <span className="text-text-main">{page.package}</span> | gates:{' '}
            {page.gates.length} | nets: {Object.keys(page.nets).length}
          </span>
        )}
        {pkg && !page && (
          <span>
            pakiet: {pkg.package.id} | stron: {pkg.package.pages.length}
          </span>
        )}
        <span>
          zoom: {Math.round(zoom * 100)}% | opacity: {Math.round(opacity * 100)}%
        </span>
        <span className="ml-auto">
          {route.mode} | issues: {issues.length}
        </span>
      </footer>
    </div>
  );
}
