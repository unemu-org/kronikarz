import { create } from 'zustand';
import type { Project, Package, Page, IcMap, Issue } from '@kronikarz/shared';
import { serializePage, serializePackage } from '@kronikarz/shared';
import { apiWrite } from './api.ts';
import {
  createSaveQueue,
  rewriteOutcomeFor,
  type RewriteOutcome,
  type RewriteResult,
  type SaveQueue,
} from './saveQueue.ts';

export type Mode = 'module' | 'package' | 'page' | 'empty';
export type Tool = 'select' | 'edit' | 'roi' | 'wire' | 'zones';

export type ZoneRole = 'gates' | 'ports_left' | 'ports_right' | 'cross_refs_left' | 'cross_refs_right';
export interface VisionZone {
  role: ZoneRole;
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Selection =
  | { kind: 'gate'; idx: number }
  | { kind: 'net'; name: string }
  | { kind: 'segment'; netName: string; segmentIdx: number }
  | { kind: 'pin'; gateIdx: number; pinIdx: number } // armed for wire creation
  | { kind: 'port'; idx: number }
  | { kind: 'cross_ref'; idx: number }
  | { kind: 'annotation'; idx: number }
  | { kind: 'decoration'; idx: number }
  | { kind: 'power'; idx: number }
  | null;

export type MultiKind = 'gate' | 'port' | 'cross_ref';
export type MultiSelect = { kind: MultiKind; indices: number[] } | null;

export interface Route {
  mode: Mode;
  pkg?: string;
  page?: string;
}

export interface DocState {
  route: Route;
  project: Project | null;
  pkg: Package | null;
  page: Page | null;
  allPages: Map<string, Page>;
  icMap: IcMap | null;
  issues: Issue[];
  tool: Tool;
  loadError: string | null;
  loading: boolean;
  selection: Selection;
  multi: MultiSelect;
  scanOpacity: number;
  overlaysVisible: boolean;
  wireOrtho: boolean;
  zoom: number;
  past: Page[];
  future: Page[];
  saveStatus: 'idle' | 'pending' | 'saving' | 'error';
  saveError: string | null;

  setRoute: (r: Route) => void;
  setProject: (p: Project | null) => void;
  setPackage: (p: Package | null) => void;
  setPage: (p: Page | null) => void;
  setAllPages: (m: Map<string, Page>) => void;
  setIcMap: (m: IcMap | null) => void;
  setIssues: (i: Issue[]) => void;
  setTool: (t: Tool) => void;
  setLoadError: (e: string | null) => void;
  setLoading: (b: boolean) => void;
  setSelection: (s: Selection) => void;
  setMulti: (m: MultiSelect) => void;
  toggleMulti: (kind: MultiKind, i: number) => void;
  setScanOpacity: (n: number) => void;
  setOverlaysVisible: (b: boolean) => void;
  setWireOrtho: (b: boolean) => void;
  setZoom: (n: number) => void;
  editPage: (mutator: (p: Page) => void) => void;
  editPackage: (mutator: (p: Package) => void) => void;
  undo: () => void;
  redo: () => void;
  setSaveStatus: (s: 'idle' | 'pending' | 'saving' | 'error', err?: string | null) => void;
}

const HISTORY_LIMIT = 50;

function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}

// Debounced auto-save (per-path, 500 ms) — logic in saveQueue.ts. Every PUT
// goes through apiWrite (X-Kronikarz header). Status mirrors into the store
// (saveStatus/saveError → SaveToast).
const DEBOUNCE_MS = 500;
// Browsers cap the total body of in-flight keepalive requests at 64 KiB; past
// that fetch() rejects, so larger bodies go as a plain PUT.
const KEEPALIVE_MAX_BYTES = 60 * 1024;

const saveQueue: SaveQueue = createSaveQueue({
  async send(path, body, opts) {
    const keepalive = opts.keepalive === true && new Blob([body]).size <= KEEPALIVE_MAX_BYTES;
    const r = await apiWrite(`/files/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/yaml' },
      body,
      keepalive,
    });
    if (!r.ok) throw new Error(`PUT ${path} → ${r.status}`);
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  delayMs: DEBOUNCE_MS,
  onStatus: (status, error) => useDocStore.getState().setSaveStatus(status, error),
});

function schedulePut(path: string, body: string): void {
  saveQueue.schedule(path, body);
}

/**
 * Send all queued auto-saves now and wait for every PUT (queued and in flight)
 * to settle. Rejects if anything stayed unsaved — the error is already shown
 * in SaveToast; callers must abort (no rewrite POST, no reload).
 */
export function flushSaves(): Promise<void> {
  return saveQueue.flush();
}

/**
 * flushSaves() for UI handlers: on failure alert that `what` was not started
 * (SaveToast also shows the error) and return false.
 */
export async function flushSavesOrAlert(what: string): Promise<boolean> {
  try {
    await saveQueue.flush();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    window.alert(`${what}: operacja nie została uruchomiona — nie udało się zapisać bieżących zmian (${msg}).`);
    return false;
  }
}

/**
 * Run a server action that rewrites the data file `path` (e.g. /restore-bak):
 * flush, fence `path` (no auto-save PUT for it from now on), run `action`,
 * then reload — see SaveQueue.runRewrite for the failure branches.
 */
export function runRewrite(
  path: string,
  name: string,
  action: () => Promise<RewriteOutcome>,
): Promise<RewriteResult> {
  return saveQueue.runRewrite(path, {
    name,
    action,
    reload: () => window.location.reload(),
    alert: (m) => window.alert(m),
    confirm: (m) => window.confirm(m),
  });
}

/** JSON reply of a kronikarz-server action endpoint. */
export type RewriteReply = { error?: string; stderr?: string } & Record<string, unknown>;

/** POST JSON for a rewrite action; `data` is null when the reply is not JSON. */
export async function postRewrite(
  url: string,
  body: unknown,
): Promise<{ outcome: RewriteOutcome; status: number; data: RewriteReply | null }> {
  const r = await apiWrite(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: RewriteReply | null = null;
  try {
    data = (await r.json()) as RewriteReply;
  } catch {
    /* non-JSON reply → ambiguous */
  }
  return { outcome: rewriteOutcomeFor(r.status, data !== null), status: r.status, data };
}

/** True while some edit is not yet confirmed saved (pending, in flight, failed, fenced). */
export function hasUnsavedChanges(): boolean {
  return saveQueue.isDirty();
}

/** beforeunload: fire queued PUTs now with fetch keepalive (best effort). */
export function flushSavesOnUnload(): void {
  saveQueue.flushNow({ keepalive: true });
}

/** Data path of a page yaml, as used by auto-save. */
export function pageFilePath(pkg: string, pageId: string): string {
  return `MJC-400/${pkg}/pages/${pageId}.sch.yaml`;
}

export const useDocStore = create<DocState>((set, get) => ({
  route: { mode: 'empty' },
  project: null,
  pkg: null,
  page: null,
  allPages: new Map(),
  icMap: null,
  issues: [],
  tool: 'select',
  loadError: null,
  loading: false,
  selection: null,
  multi: null,
  scanOpacity: 0.7,
  overlaysVisible: true,
  wireOrtho: true,
  zoom: 1,
  past: [],
  future: [],
  saveStatus: 'idle',
  saveError: null,

  setRoute: (route) => set({ route }),
  setProject: (project) => set({ project }),
  setPackage: (pkg) => set({ pkg }),
  setPage: (page) => set({ page, past: [], future: [], selection: null }),
  setAllPages: (allPages) => set({ allPages }),
  setIcMap: (icMap) => set({ icMap }),
  setIssues: (issues) => set({ issues }),
  setTool: (tool) => set({ tool }),
  setLoadError: (loadError) => set({ loadError }),
  setLoading: (loading) => set({ loading }),
  setSelection: (selection) => set({ selection, multi: null }),
  setMulti: (multi) => set({ multi }),
  toggleMulti: (kind, i) => set((s) => {
    if (!s.multi || s.multi.kind !== kind) {
      return { multi: { kind, indices: [i] }, selection: null };
    }
    const has = s.multi.indices.includes(i);
    const indices = has ? s.multi.indices.filter((x) => x !== i) : [...s.multi.indices, i];
    return {
      multi: indices.length ? { kind, indices } : null,
      selection: null,
    };
  }),
  setScanOpacity: (scanOpacity) => set({ scanOpacity }),
  setOverlaysVisible: (overlaysVisible) => set({ overlaysVisible }),
  setWireOrtho: (wireOrtho) => set({ wireOrtho }),
  setZoom: (zoom) => set({ zoom }),
  setSaveStatus: (saveStatus, err = null) => set({ saveStatus, saveError: err }),

  editPage: (mutator) => {
    const state = get();
    if (!state.page || !state.route.pkg) return;
    const draft = clone(state.page);
    mutator(draft);
    const past = [...state.past, state.page].slice(-HISTORY_LIMIT);
    set({ page: draft, past, future: [] });
    schedulePut(pageFilePath(state.route.pkg, draft.page), serializePage(draft));
  },

  editPackage: (mutator) => {
    const state = get();
    if (!state.pkg || !state.route.pkg) return;
    const draft = clone(state.pkg);
    mutator(draft);
    set({ pkg: draft });
    const path = `MJC-400/${state.route.pkg}/package.yaml`;
    schedulePut(path, serializePackage(draft));
  },

  undo: () => {
    const state = get();
    if (!state.past.length || !state.page) return;
    const prev = state.past[state.past.length - 1]!;
    set({
      page: prev,
      past: state.past.slice(0, -1),
      future: [state.page, ...state.future].slice(0, HISTORY_LIMIT),
    });
    if (state.route.pkg) {
      schedulePut(pageFilePath(state.route.pkg, prev.page), serializePage(prev));
    }
  },

  redo: () => {
    const state = get();
    if (!state.future.length || !state.page) return;
    const next = state.future[0]!;
    set({
      page: next,
      past: [...state.past, state.page].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
    });
    if (state.route.pkg) {
      schedulePut(pageFilePath(state.route.pkg, next.page), serializePage(next));
    }
  },
}));
