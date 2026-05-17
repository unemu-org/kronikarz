import { useEffect } from 'react';
import { useDocStore, type Route } from './store.ts';

// URL hash format:
//   #/module/<project>
//   #/package/<project>/<pkg>
//   #/page/<project>/<pkg>/<page>
function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [kind, , pkg, page] = parts;
  if (kind === 'page' && pkg && page) return { mode: 'page', pkg, page };
  if (kind === 'package' && pkg) return { mode: 'package', pkg };
  if (kind === 'module') return { mode: 'module' };
  return { mode: 'empty' };
}

export function useHashRouter(): void {
  const setRoute = useDocStore((s) => s.setRoute);
  useEffect(() => {
    const apply = () => setRoute(parseHash(window.location.hash));
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [setRoute]);
}

export function navigate(route: Route): void {
  let hash = '#/';
  if (route.mode === 'module') hash = '#/module/MJC-400';
  else if (route.mode === 'package') hash = `#/package/MJC-400/${route.pkg}`;
  else if (route.mode === 'page') hash = `#/page/MJC-400/${route.pkg}/${route.page}`;
  window.location.hash = hash;
}
