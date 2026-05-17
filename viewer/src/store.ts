import { create } from 'zustand';
import type { Project, Package, Page, IcMap, Issue } from '@kronikarz/shared';

export type Mode = 'module' | 'package' | 'page' | 'empty';
export type Tool = 'select' | 'edit';

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
  selectedGateIdx: number | null;
  scanOpacity: number;
  zoom: number;

  setRoute: (r: Route) => void;
  setProject: (p: Project | null) => void;
  setPackage: (p: Package | null) => void;
  setPage: (p: Page | null) => void;
  setIcMap: (m: IcMap | null) => void;
  setIssues: (i: Issue[]) => void;
  setTool: (t: Tool) => void;
  setLoadError: (e: string | null) => void;
  setLoading: (b: boolean) => void;
  setSelectedGateIdx: (i: number | null) => void;
  setScanOpacity: (n: number) => void;
  setZoom: (n: number) => void;
}

export const useDocStore = create<DocState>((set) => ({
  route: { mode: 'empty' },
  project: null,
  pkg: null,
  page: null,
  icMap: null,
  issues: [],
  tool: 'select',
  loadError: null,
  loading: false,
  selectedGateIdx: null,
  scanOpacity: 0.7,
  zoom: 1,

  setRoute: (route) => set({ route }),
  setProject: (project) => set({ project }),
  setPackage: (pkg) => set({ pkg }),
  setPage: (page) => set({ page }),
  setIcMap: (icMap) => set({ icMap }),
  setIssues: (issues) => set({ issues }),
  setTool: (tool) => set({ tool }),
  setLoadError: (loadError) => set({ loadError }),
  setLoading: (loading) => set({ loading }),
  setSelectedGateIdx: (selectedGateIdx) => set({ selectedGateIdx }),
  setScanOpacity: (scanOpacity) => set({ scanOpacity }),
  setZoom: (zoom) => set({ zoom }),
}));
