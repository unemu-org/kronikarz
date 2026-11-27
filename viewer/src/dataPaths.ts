// Data-file paths (relative to KRONIKARZ_DATA, as used by /files/*). Pure.
//
// The page shown in the viewer is identified by the file it was loaded from
// (store `pagePath`), never by the `page:` field inside the YAML: the two can
// differ (vision-page.py does not enforce it), and the server's page actions
// (/vision-page, /restore-bak, …) take the file name, not the YAML field.

/** Path of a page yaml in package `pkg`, file stem `pageId`. */
export function pageFilePath(pkg: string, pageId: string): string {
  return `MJC-400/${pkg}/pages/${pageId}.sch.yaml`;
}

/** Inverse of pageFilePath: package dir and file stem, or null. */
export function parsePageFilePath(path: string): { pkg: string; pageId: string } | null {
  const m = /^MJC-400\/([^/]+)\/pages\/([^/]+)\.sch\.yaml$/.exec(path);
  return m ? { pkg: m[1]!, pageId: m[2]! } : null;
}

/** `<page>.zones.yaml` next to the page yaml at `pagePath`, or null. */
export function zonesFilePath(pagePath: string): string | null {
  return pagePath.endsWith('.sch.yaml') ? pagePath.slice(0, -'.sch.yaml'.length) + '.zones.yaml' : null;
}

/** Path of a package manifest. */
export function packageFilePath(pkg: string): string {
  return `MJC-400/${pkg}/package.yaml`;
}

/** Package dir of a package manifest path (inverse of packageFilePath), or null. */
export function parsePackageFilePath(path: string): string | null {
  const m = /^MJC-400\/([^/]+)\/package\.yaml$/.exec(path);
  return m ? m[1]! : null;
}

/** Scan of the page whose yaml is at `pagePath`: `MJC-400/<pkg>/scans/<stem>.jpg`, or null. */
export function scanFilePath(pagePath: string): string | null {
  const ref = parsePageFilePath(pagePath);
  return ref ? `MJC-400/${ref.pkg}/scans/${ref.pageId}.jpg` : null;
}
