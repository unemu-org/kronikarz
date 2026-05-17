import { create } from 'zustand';
import type { Project, Package, Page, IcMap, Issue } from '@kronikarz/shared';
import { serializePage, serializePackage } from '@kronikarz/shared';

export type Mode = 'module' | 'package' | 'page' | 'empty';
export type Tool = 'select' | 'edit';
export type Selection =
  | { kind: 'gate'; idx: number }
  | { kind: 'net'; name: string }
  | null;

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
  icMap: IcMap | null;
  issues: Issue[];
  tool: Tool;
  loadError: string | null;
  loading: boolean;
  selection: Selection;
  scanOpacity: number;
  zoom: number;
  past: Page[];
  future: Page[];
  saveStatus: 'idle' | 'pending' | 'saving' | 'error';
  saveError: string | null;

  setRoute: (r: Route) => void;
  setProject: (p: Project | null) => void;
  setPackage: (p: Package | null) => void;
  setPage: (p: Page | null) => void;
  setIcMap: (m: IcMap | null) => void;
  setIssues: (i: Issue[]) => void;
  setTool: (t: Tool) => void;
  setLoadError: (e: string | null) => void;
  setLoading: (b: boolean) => void;
  setSelection: (s: Selection) => void;
  setScanOpacity: (n: number) => void;
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

// Schedule debounced PUTs to the file server. Per-path timers.
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

function schedulePut(path: string, body: string, store: { setSaveStatus: DocState['setSaveStatus'] }): void {
  store.setSaveStatus('pending');
  const existing = pendingTimers.get(path);
  if (existing) clearTimeout(existing);
  pendingTimers.set(
    path,
    setTimeout(async () => {
      pendingTimers.delete(path);
      store.setSaveStatus('saving');
      try {
        const r = await fetch(`/files/${path}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/yaml' },
          body,
        });
        if (!r.ok) throw new Error(`PUT ${path} → ${r.status}`);
        store.setSaveStatus('idle');
      } catch (err) {
        store.setSaveStatus('error', err instanceof Error ? err.message : String(err));
      }
    }, DEBOUNCE_MS),
  );
}

export const useDocStore = create<DocState>((set, get) => ({
  route: { mode: 'empty' },
  project: null,
  pkg: null,
  page: null,
  icMap: null,
  issues: [],
  tool: 'select',
  loadError: null,
  loading: false,
  selection: null,
  scanOpacity: 0.7,
  zoom: 1,
  past: [],
  future: [],
  saveStatus: 'idle',
  saveError: null,

  setRoute: (route) => set({ route }),
  setProject: (project) => set({ project }),
  setPackage: (pkg) => set({ pkg }),
  setPage: (page) => set({ page, past: [], future: [], selection: null }),
  setIcMap: (icMap) => set({ icMap }),
  setIssues: (issues) => set({ issues }),
  setTool: (tool) => set({ tool }),
  setLoadError: (loadError) => set({ loadError }),
  setLoading: (loading) => set({ loading }),
  setSelection: (selection) => set({ selection }),
  setScanOpacity: (scanOpacity) => set({ scanOpacity }),
  setZoom: (zoom) => set({ zoom }),
  setSaveStatus: (saveStatus, err = null) => set({ saveStatus, saveError: err }),

  editPage: (mutator) => {
    const state = get();
    if (!state.page || !state.route.pkg) return;
    const draft = clone(state.page);
    mutator(draft);
    const past = [...state.past, state.page].slice(-HISTORY_LIMIT);
    set({ page: draft, past, future: [] });
    const path = `MJC-400/${state.route.pkg}/pages/${draft.page}.sch.yaml`;
    schedulePut(path, serializePage(draft), { setSaveStatus: state.setSaveStatus });
  },

  editPackage: (mutator) => {
    const state = get();
    if (!state.pkg || !state.route.pkg) return;
    const draft = clone(state.pkg);
    mutator(draft);
    set({ pkg: draft });
    const path = `MJC-400/${state.route.pkg}/package.yaml`;
    schedulePut(path, serializePackage(draft), { setSaveStatus: state.setSaveStatus });
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
      schedulePut(
        `MJC-400/${state.route.pkg}/pages/${prev.page}.sch.yaml`,
        serializePage(prev),
        { setSaveStatus: state.setSaveStatus },
      );
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
      schedulePut(
        `MJC-400/${state.route.pkg}/pages/${next.page}.sch.yaml`,
        serializePage(next),
        { setSaveStatus: state.setSaveStatus },
      );
    }
  },
}));
