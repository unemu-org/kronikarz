import { create } from 'zustand';
import type { Project, Package, Page, IcMap, Issue } from '@kronikarz/shared';
import { applyHumanEdit, serializePage, serializePackage } from '@kronikarz/shared';
import { apiWrite } from './api.ts';
import {
  createSaveQueue,
  rewriteOutcomeFor,
  SaveBusyError,
  SaveConflictError,
  type FileIO,
  type RewriteOutcome,
  type RewriteResult,
  type SaveQueue,
  type UpdateResult,
} from './saveQueue.ts';
import { canEditElement, defaultStep, toolAllowed, type OthersMode, type ViewStep } from './stepView.ts';
export {
  packageFilePath,
  pageFilePath,
  parsePackageFilePath,
  parsePageFilePath,
  scanFilePath,
  zonesFilePath,
} from './dataPaths.ts';

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
  /** File `pkg` was loaded from — every auto-save of the package goes there. */
  pkgPath: string | null;
  page: Page | null;
  /**
   * File `page` was loaded from (set together with `page`) — every auto-save
   * of the page goes there, never to a path built from the YAML `page:` field
   * or from the current route (which may already point at the next page).
   */
  pagePath: string | null;
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
  /**
   * Bieżący krok pipeline'u na pasku kroków (kr-9p8.20); null = „wszystko”
   * (bez filtra — jak przed pipeline'em). Ogranicza widoczne warstwy i
   * narzędzia (stepView.ts). Stan widoku, nie pliku.
   */
  currentStep: ViewStep | null;
  /** Elementy innych kroków: wyszarzone albo ukryte. */
  othersMode: OthersMode;
  /**
   * Strona zablokowana przez krok pipeline'u uruchomiony z viewera (albo po
   * niepewnym wyniku — do przeładowania): editPage / undo / redo tej strony
   * nic nie robią, płótno pokazuje powód. Osobno dla każdej strony.
   */
  pageLocks: Readonly<Record<string, string>>; // ścieżka strony → powód blokady
  /** Liczba trwających POST /auto w tej karcie (strona albo cały pakiet). */
  autoRuns: number;

  setRoute: (r: Route) => void;
  setProject: (p: Project | null) => void;
  setPackage: (p: Package | null, path: string | null) => void;
  setPage: (p: Page | null, path: string | null) => void;
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
  setCurrentStep: (s: ViewStep | null) => void;
  setOthersMode: (m: OthersMode) => void;
  setPageLock: (path: string, reason: string | null) => void;
  bumpAutoRuns: (delta: 1 | -1) => void;
}

const HISTORY_LIMIT = 50;

function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}

// Debounced auto-save (per-path, 500 ms) — logic in saveQueue.ts. Every PUT
// goes through apiWrite (X-Kronikarz header) with If-Match = the last ETag the
// queue knows (from the load, then from each PUT); 409 → SaveConflictError,
// 409 {error:'busy'} (server job on the page) → SaveBusyError (retried).
// Status mirrors into the store (saveStatus/saveError → SaveToast).
const DEBOUNCE_MS = 500;
// Browsers cap the total body of in-flight keepalive requests at 64 KiB; past
// that fetch() rejects, so larger bodies go as a plain PUT.
const KEEPALIVE_MAX_BYTES = 60 * 1024;

// 409 {error:'busy'} = a server job rewrites the file (not an ETag conflict).
async function isBusy409(r: Response): Promise<boolean> {
  if (r.status !== 409) return false;
  try {
    return (await r.clone().json())?.error === 'busy';
  } catch {
    return false;
  }
}

const saveQueue: SaveQueue = createSaveQueue({
  async send(path, body, opts, ifMatch) {
    const keepalive = opts.keepalive === true && new Blob([body]).size <= KEEPALIVE_MAX_BYTES;
    const headers: Record<string, string> = { 'Content-Type': 'text/yaml' };
    if (ifMatch) headers['If-Match'] = ifMatch;
    const r = await apiWrite(`/files/${path}`, { method: 'PUT', headers, body, keepalive });
    if (await isBusy409(r)) throw new SaveBusyError(`PUT ${path} → 409 busy`);
    if (r.status === 409) throw new SaveConflictError(`PUT ${path} → 409`);
    if (!r.ok) throw new Error(`PUT ${path} → ${r.status}`);
    return r.headers.get('ETag');
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
 * Debounced auto-save of a data file other than the page/package in the store
 * (e.g. `<page>.zones.yaml`): same queue, so flush, fences, If-Match and
 * beforeunload cover it. Load the file with fetchDataFile first (ETag).
 */
export function scheduleSave(path: string, body: string): void {
  saveQueue.schedule(path, body);
}

/**
 * GET a data file and hand its ETag to the save queue (used as If-Match by
 * the next auto-save of that path; a 404 forgets it). Same contract as fetch().
 */
export async function fetchDataFile(path: string): Promise<Response> {
  const ticket = saveQueue.loadTicket(path);
  const r = await fetch(`/files/${path}`);
  if (r.ok) saveQueue.setLoadedEtag(path, r.headers.get('ETag'), ticket);
  else if (r.status === 404) saveQueue.setLoadedEtag(path, null, ticket);
  return r;
}

const fileIO: FileIO = {
  async get(path) {
    const r = await fetch(`/files/${path}`);
    return { status: r.status, text: r.ok ? await r.text() : '', etag: r.headers.get('ETag') };
  },
  async put(path, body, ifMatch) {
    const headers: Record<string, string> = { 'Content-Type': 'text/yaml' };
    if (ifMatch) headers['If-Match'] = ifMatch;
    const r = await apiWrite(`/files/${path}`, { method: 'PUT', headers, body });
    return { status: r.status, etag: r.headers.get('ETag'), busy: await isBusy409(r) };
  },
};

/**
 * Change a data file that is not the page being edited (another page of the
 * package): flush auto-saves, GET, `mutate(text)` → new body or null (no
 * change), PUT with If-Match. Never overwrites a file changed meanwhile (409
 * → error). See SaveQueue.updateFile / UpdateResult.
 */
export function updateDataFile(path: string, mutate: (text: string) => string | null): Promise<UpdateResult> {
  return saveQueue.updateFile(path, mutate, fileIO);
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
  opts: { ambiguousMessage?: string } = {},
): Promise<RewriteResult> {
  return saveQueue.runRewrite(path, {
    name,
    action,
    ambiguousMessage: opts.ambiguousMessage,
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

/** Powód blokady otwartej strony (krok pipeline'u na niej) albo null. */
export function lockReason(s: Pick<DocState, 'pageLocks' | 'pagePath'>): string | null {
  return s.pagePath !== null && Object.hasOwn(s.pageLocks, s.pagePath) ? s.pageLocks[s.pagePath]! : null;
}

/** Otwarta strona zablokowana przez krok pipeline'u. */
export function isLocked(s: Pick<DocState, 'pageLocks' | 'pagePath'>): boolean {
  return lockReason(s) !== null;
}

export const useDocStore = create<DocState>((set, get) => ({
  route: { mode: 'empty' },
  project: null,
  pkg: null,
  pkgPath: null,
  page: null,
  pagePath: null,
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
  currentStep: null,
  othersMode: 'faint',
  pageLocks: {},
  autoRuns: 0,

  setRoute: (route) => set({ route }),
  setProject: (project) => set({ project }),
  setPackage: (pkg, path) => set({ pkg, pkgPath: pkg ? path : null }),
  setPage: (page, path) =>
    set((s) => {
      // Inna strona → jej krok domyślny; przeładowanie tej samej zostawia wybór.
      const currentStep = !page ? null : path === s.pagePath ? s.currentStep : defaultStep(page);
      return {
        page,
        pagePath: page ? path : null,
        past: [],
        future: [],
        selection: null,
        currentStep,
        tool: toolAllowed(currentStep, s.tool) ? s.tool : 'select',
      };
    }),
  setAllPages: (allPages) => set({ allPages }),
  setIcMap: (icMap) => set({ icMap }),
  setIssues: (issues) => set({ issues }),
  // Narzędzie spoza bieżącego kroku (klawisz, przycisk) jest ignorowane.
  setTool: (tool) => set((s) => (toolAllowed(s.currentStep, tool) ? { tool } : {})),
  setLoadError: (loadError) => set({ loadError }),
  setLoading: (loading) => set({ loading }),
  setSelection: (selection) => set({ selection, multi: null }),
  setMulti: (multi) => set({ multi }),
  toggleMulti: (kind, i) => set((s) => {
    // Shift+klik: tylko elementy, które wolno w bieżącym kroku przesuwać.
    if (!canEditElement(s.currentStep, kind, kind === 'gate' ? 'box' : 'label')) return {};
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
  // Zmiana kroku czyści historię cofania: cofnięcie edycji innego kroku
  // (niewidocznej, wyszarzonej) z poziomu bieżącego byłoby zaskoczeniem.
  setCurrentStep: (currentStep) =>
    set((s) => ({
      currentStep,
      selection: null,
      multi: null,
      past: [],
      future: [],
      tool: toolAllowed(currentStep, s.tool) ? s.tool : 'select',
    })),
  setOthersMode: (othersMode) => set({ othersMode }),
  setPageLock: (path, reason) =>
    set((s) => {
      const pageLocks = { ...s.pageLocks };
      if (reason === null) delete pageLocks[path];
      else pageLocks[path] = reason;
      return { pageLocks };
    }),
  bumpAutoRuns: (delta) => set((s) => ({ autoRuns: Math.max(0, s.autoRuns + delta) })),

  editPage: (mutator) => {
    const state = get();
    if (!state.page || !state.pagePath) return;
    if (isLocked(state)) return; // trwa krok pipeline'u — edycja zablokowana
    const draft = clone(state.page);
    mutator(draft);
    // Każda edycja tu jest ludzka: zmienione elementy `src: auto` → edited,
    // zmieniony krok → późniejsze zatwierdzone kroki `stale` (format v1.2).
    applyHumanEdit(state.page, draft, new Date().toISOString());
    const past = [...state.past, state.page].slice(-HISTORY_LIMIT);
    set({ page: draft, past, future: [] });
    schedulePut(state.pagePath, serializePage(draft));
  },

  editPackage: (mutator) => {
    const state = get();
    if (!state.pkg || !state.pkgPath) return;
    const draft = clone(state.pkg);
    mutator(draft);
    set({ pkg: draft });
    schedulePut(state.pkgPath, serializePackage(draft));
  },

  undo: () => {
    const state = get();
    if (!state.past.length || !state.page || isLocked(state)) return;
    const prev = state.past[state.past.length - 1]!;
    set({
      page: prev,
      past: state.past.slice(0, -1),
      future: [state.page, ...state.future].slice(0, HISTORY_LIMIT),
    });
    if (state.pagePath) schedulePut(state.pagePath, serializePage(prev));
  },

  redo: () => {
    const state = get();
    if (!state.future.length || !state.page || isLocked(state)) return;
    const next = state.future[0]!;
    set({
      page: next,
      past: [...state.past, state.page].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
    });
    if (state.pagePath) schedulePut(state.pagePath, serializePage(next));
  },
}));
