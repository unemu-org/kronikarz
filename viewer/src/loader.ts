import { useEffect } from 'react';
import {
  parseProject,
  parsePackage,
  parsePage,
  parseIcMap,
  validatePage,
  validatePackage,
  validateProject,
} from '@kronikarz/shared';
import type { Issue } from '@kronikarz/shared';
import { useDocStore } from './store.ts';

async function fetchText(path: string): Promise<string> {
  const r = await fetch(`/files/${path}`);
  if (!r.ok) throw new Error(`GET /files/${path} → ${r.status}`);
  return r.text();
}

async function fetchTextOptional(path: string): Promise<string | null> {
  const r = await fetch(`/files/${path}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET /files/${path} → ${r.status}`);
  return r.text();
}

export function useLoader(): void {
  const route = useDocStore((s) => s.route);
  const setProject = useDocStore((s) => s.setProject);
  const setPackage = useDocStore((s) => s.setPackage);
  const setPage = useDocStore((s) => s.setPage);
  const setIcMap = useDocStore((s) => s.setIcMap);
  const setIssues = useDocStore((s) => s.setIssues);
  const setLoadError = useDocStore((s) => s.setLoadError);
  const setLoading = useDocStore((s) => s.setLoading);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);

    async function run() {
      if (route.mode === 'empty') {
        setProject(null);
        setPackage(null);
        setPage(null);
        setIssues([]);
        return;
      }

      setLoading(true);
      try {
        // Always try project + ic_map at MJC-400 root
        const project = await fetchTextOptional('MJC-400/project.yaml').then((t) =>
          t ? parseProject(t, 'MJC-400/project.yaml') : null,
        );
        const icMap = await fetchTextOptional('MJC-400/ic_map.yaml').then((t) =>
          t ? parseIcMap(t, 'MJC-400/ic_map.yaml') : null,
        );
        if (cancelled) return;
        setProject(project);
        setIcMap(icMap);

        let pkg = null;
        let page = null;
        const issues: Issue[] = [];

        if (route.pkg) {
          const pkgPath = `MJC-400/${route.pkg}/package.yaml`;
          const pkgText = await fetchTextOptional(pkgPath);
          pkg = pkgText ? parsePackage(pkgText, pkgPath) : null;
          if (pkg) issues.push(...validatePackage(pkg, icMap ?? undefined));
        }
        if (cancelled) return;
        setPackage(pkg);

        if (route.mode === 'page' && route.pkg && route.page) {
          const pagePath = `MJC-400/${route.pkg}/pages/${route.page}.sch.yaml`;
          const pageText = await fetchTextOptional(pagePath);
          page = pageText ? parsePage(pageText, pagePath) : null;
          if (page && pkg) issues.push(...validatePage(page, pkg, icMap ?? undefined));
        }
        if (cancelled) return;
        setPage(page);

        if (project) issues.push(...validateProject(project));
        setIssues(issues);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [route, setProject, setPackage, setPage, setIcMap, setIssues, setLoadError, setLoading]);
}
