import { useEffect } from 'react';
import {
  parseProject,
  parsePackage,
  parsePage,
  parseIcMap,
  validatePage,
  validatePackage,
  validatePackagePages,
  validateProject,
} from '@kronikarz/shared';
import type { Issue, Page } from '@kronikarz/shared';
import { fetchDataFile, flushSaves, packageFilePath, pageFilePath, parsePageFilePath, useDocStore } from './store.ts';

// Records the file's ETag for auto-save If-Match (fetchDataFile).
async function fetchTextOptional(path: string): Promise<string | null> {
  const r = await fetchDataFile(path);
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
  // Re-run validation whenever page/pkg/icMap/project changes so issues stay fresh.
  const page = useDocStore((s) => s.page);
  const pagePath = useDocStore((s) => s.pagePath);
  const pkg = useDocStore((s) => s.pkg);
  const icMap = useDocStore((s) => s.icMap);
  const project = useDocStore((s) => s.project);
  const allPages = useDocStore((s) => s.allPages);
  useEffect(() => {
    const issues: Issue[] = [];
    if (pkg) issues.push(...validatePackage(pkg, icMap ?? undefined));
    if (page && pkg) issues.push(...validatePage(page, pkg, icMap ?? undefined, project ?? undefined));
    if (project) issues.push(...validateProject(project));
    if (pkg && allPages.size > 0) {
      // Live override: aktualna strona z `page` (po edycji) zamiast wersji z cache.
      // allPages is keyed by file stem (package.pages[].id), so is the override.
      const merged = new Map(allPages);
      const openId = pagePath ? parsePageFilePath(pagePath)?.pageId : undefined;
      if (page && openId) merged.set(openId, page);
      issues.push(...validatePackagePages(pkg, merged));
    }
    setIssues(issues);
  }, [page, pagePath, pkg, icMap, project, allPages, setIssues]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);

    async function run() {
      if (route.mode === 'empty') {
        setProject(null);
        setPackage(null, null);
        setPage(null, null);
        useDocStore.getState().setAllPages(new Map());
        setIssues([]);
        return;
      }

      setLoading(true);
      // Land queued auto-saves first, so going A→B→A within the debounce
      // cannot load A from before its last edit. On failure load anyway — the
      // error stays visible in SaveToast (the queue keeps the path dirty).
      await flushSaves().catch(() => {});
      if (cancelled) return;
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
        let pkgPath: string | null = null;
        let page = null;
        let pagePath: string | null = null;
        const issues: Issue[] = [];

        if (route.pkg) {
          pkgPath = packageFilePath(route.pkg);
          const pkgText = await fetchTextOptional(pkgPath);
          pkg = pkgText ? parsePackage(pkgText, pkgPath) : null;
          if (pkg) issues.push(...validatePackage(pkg, icMap ?? undefined));
        }
        if (cancelled) return;
        setPackage(pkg, pkgPath);

        if (route.mode === 'page' && route.pkg && route.page) {
          pagePath = pageFilePath(route.pkg, route.page);
          const pageText = await fetchTextOptional(pagePath);
          page = pageText ? parsePage(pageText, pagePath) : null;
          if (page && pkg) issues.push(...validatePage(page, pkg, icMap ?? undefined, project ?? undefined));
        }

        // Cross-page validacja: zaladuj wszystkie strony pakietu i zapisz w store
        // (re-validation effect uzyje allPages do validatePackagePages).
        if (pkg && route.pkg) {
          const pagesMap = new Map<string, Page>();
          for (const ref of pkg.package.pages) {
            try {
              const refPath = pageFilePath(route.pkg, ref.id);
              const pt = await fetchTextOptional(refPath);
              if (pt) pagesMap.set(ref.id, parsePage(pt, refPath));
            } catch { /* ignore parse fails per page */ }
          }
          if (cancelled) return;
          useDocStore.getState().setAllPages(pagesMap);
        }
        if (cancelled) return;
        // Page and the file it came from land together: auto-save of this
        // page always goes to pagePath (not to the YAML `page:` field).
        setPage(page, pagePath);

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
