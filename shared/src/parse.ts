// Browser-safe YAML helpers (no fs). Pair with `io.ts` for node fs wrappers.
import yaml from 'js-yaml';
import type { Project, Package, Page, IcMap } from './types.ts';

const FORMAT_VERSION = '1';

function checkVersion(doc: unknown, label: string): void {
  if (!doc || typeof doc !== 'object' || (doc as { kronikarz?: unknown }).kronikarz !== FORMAT_VERSION) {
    throw new Error(`${label}: missing or wrong "kronikarz: ${FORMAT_VERSION}"`);
  }
}

export function parseProject(text: string, label = '<text>'): Project {
  const doc = yaml.load(text);
  checkVersion(doc, label);
  return doc as Project;
}

export function parsePackage(text: string, label = '<text>'): Package {
  const doc = yaml.load(text);
  checkVersion(doc, label);
  return doc as Package;
}

export function parsePage(text: string, label = '<text>'): Page {
  const doc = yaml.load(text);
  checkVersion(doc, label);
  return doc as Page;
}

export function parseIcMap(text: string, label = '<text>'): IcMap {
  const doc = yaml.load(text);
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${label}: not a YAML mapping`);
  }
  return doc as IcMap;
}

function dump(doc: unknown): string {
  return yaml.dump(doc, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    quotingType: `"`,
    forceQuotes: false,
    sortKeys: false,
  });
}

export const serializeProject = (doc: Project): string => dump(doc);
export const serializePackage = (doc: Package): string => dump(doc);
export const serializePage = (doc: Page): string => dump(doc);
export const serializeIcMap = (doc: IcMap): string => dump(doc);

// --- Pin id helpers (pure) ---

export function pinId(ref: string, gate: string | null, num: number): string {
  return gate === null ? `${ref}.${num}` : `${ref}.${gate}.${num}`;
}

export function parsePinId(id: string): { ref: string; gate: string | null; num: number } {
  const parts = id.split('.');
  if (parts.length === 2) {
    const [ref, numStr] = parts;
    const num = Number(numStr);
    if (!ref || Number.isNaN(num)) throw new Error(`bad pin id: ${id}`);
    return { ref, gate: null, num };
  }
  if (parts.length === 3) {
    const [ref, gate, numStr] = parts;
    const num = Number(numStr);
    if (!ref || !gate || Number.isNaN(num)) throw new Error(`bad pin id: ${id}`);
    return { ref, gate, num };
  }
  throw new Error(`bad pin id: ${id}`);
}

// --- IC suffix normalization ---
//
// Polish ICs use various prefixes: MH7411 / UCY7411 / MCY74175 → 11 / 175.
// AI may leave the prefix; this resolves to the canonical key in ic_map.
export function resolveIcKey(ic: string | number, icMap: IcMap): string | null {
  const raw = String(ic).trim();
  if (raw in icMap) return raw;
  let s = raw.toUpperCase();
  // Strip family prefixes (longest-first)
  s = s.replace(/^(SN|UCY|MCY|MH|CDB|HCF)/, '');
  // Strip 74xx family designator (with optional speed grade)
  s = s.replace(/^74(LS|HCT|HC|ALS|AS|H|S|F)?/, '');
  // Strip trailing package letter (N=DIP, D=SOIC, etc.)
  s = s.replace(/[ND]$/, '');
  if (s in icMap) return s;
  // Try padding single digit
  if (s.length === 1 && ('0' + s) in icMap) return '0' + s;
  // Try the raw H-prefix case: "H11" → "11"
  if (raw.toUpperCase().startsWith('H') && raw.slice(1) in icMap) return raw.slice(1);
  return null;
}
