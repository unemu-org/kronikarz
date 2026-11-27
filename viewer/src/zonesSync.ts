// Load/save of `<page>.zones.yaml` (Vision zones of the open page), independent
// of React so it can be unit-tested with `node --test`. Canvas owns one
// instance; saves go through the store's save queue (debounce, flush, fence,
// If-Match/409, beforeunload — see saveQueue.ts).
//
// Rules:
//   - open(path) resets the zones shown to an empty list and GETs the file.
//     Neither the reset nor the loaded zones are saved — only user changes.
//   - Nothing is saved for `path` until its GET has resolved: a change made
//     while loading is not saved, and the loaded zones replace it in the UI
//     (Canvas blocks zone editing until state is 'loaded' — see onState).
//   - 404 = no zones yet: loaded, empty. The file is created only by a user
//     change (opening a page never writes it).
//   - GET error / unparsable file: never saved (saving would overwrite zones
//     we could not read). open() of the same path then retries the GET, as
//     does reopening the page or reloading the browser tab.
//   - A result for a path that is no longer open is ignored.
//
// "User change" = a zones array other than the one this module last handed to
// apply() (identity, not content): Canvas reports every zones state change.

import yaml from 'js-yaml';
import type { VisionZone } from './store.ts';

export type ZonesLoadState = 'loading' | 'loaded' | 'error';

/** What changed() did with a zones update. */
export type ZonesChange =
  | 'scheduled' // user change, handed to the save queue
  | 'unchanged' // the zones this module set itself (open/load) — not a user change
  | 'not-loaded' // GET still pending, or no page open — not saved
  | 'load-failed'; // GET failed for this page — never saved

export interface ZonesSyncDeps {
  /** GET of a data file (store.fetchDataFile: also records the ETag for If-Match). */
  fetch: (path: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /** Debounced save (store.scheduleSave → save queue). */
  schedule: (path: string, body: string) => void;
  /** Show these zones (setZones). Called on open (empty) and when the GET resolves. */
  apply: (zones: VisionZone[]) => void;
  /** GET/parse failure for `path` (zones of that page will not be saved). */
  onLoadError?: (path: string, error: string) => void;
  /** Load state of the open zones file changed (error: message when 'error'). */
  onState?: (state: ZonesLoadState, error: string | null) => void;
}

export interface ZonesSync {
  /**
   * The open page's zones file changed (null = no page). Idempotent per path,
   * except after a failed load: then it retries the GET.
   */
  open(path: string | null): void;
  /** The zones shown for `path` changed (any cause). Saves only a user change. */
  changed(path: string | null, zones: VisionZone[]): ZonesChange;
  /** Load state of `path`; null if it is not the open zones file. */
  state(path: string | null): ZonesLoadState | null;
}

/** Body of a zones file (format kept from the pre-queue Canvas code). */
export function serializeZones(zones: VisionZone[]): string {
  return zones.length === 0 ? 'zones: []\n' : yaml.dump({ zones }, { flowLevel: 2, lineWidth: 120 });
}

/** Zones from a zones file; throws if the text is not a YAML mapping. */
export function parseZones(text: string): VisionZone[] {
  const doc = yaml.load(text);
  if (doc === null || doc === undefined) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('zones file is not a YAML mapping');
  const zones = (doc as { zones?: unknown }).zones;
  return Array.isArray(zones) ? (zones as VisionZone[]) : [];
}

export function createZonesSync(deps: ZonesSyncDeps): ZonesSync {
  let current: string | null = null;
  let state: ZonesLoadState = 'loaded';
  let baseline: VisionZone[] | null = null; // last array handed to apply()
  let gen = 0;

  function applyBaseline(zones: VisionZone[]): void {
    baseline = zones;
    deps.apply(zones);
  }

  function setState(next: ZonesLoadState, error: string | null = null): void {
    state = next;
    deps.onState?.(next, error);
  }

  function fail(path: string, g: number, error: string): void {
    if (g !== gen) return;
    setState('error', error);
    deps.onLoadError?.(path, error);
  }

  return {
    open(path) {
      if (path === current && baseline !== null && state !== 'error') return;
      current = path;
      const g = ++gen;
      applyBaseline([]);
      if (path === null) {
        setState('loaded');
        return;
      }
      setState('loading');
      deps
        .fetch(path)
        .then(async (r) => {
          if (g !== gen) return;
          if (r.status === 404) {
            applyBaseline([]); // drop anything drawn while loading
            setState('loaded');
            return;
          }
          if (!r.ok) return fail(path, g, `GET ${path} → ${r.status}`);
          const zones = parseZones(await r.text());
          if (g !== gen) return;
          applyBaseline(zones);
          setState('loaded');
        })
        .catch((err) => fail(path, g, err instanceof Error ? err.message : String(err)));
    },

    changed(path, zones) {
      if (path === null || path !== current) return 'not-loaded';
      if (zones === baseline) return 'unchanged';
      if (state === 'loading') return 'not-loaded';
      if (state === 'error') return 'load-failed';
      baseline = zones;
      deps.schedule(path, serializeZones(zones));
      return 'scheduled';
    },

    state(path) {
      return path !== null && path === current ? state : null;
    },
  };
}
