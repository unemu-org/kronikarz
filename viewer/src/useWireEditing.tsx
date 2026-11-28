// Fast wire fixing on the page canvas (kr-9p8.25): the W tool (draw with
// snapping) and the hover keys of V / E / W — x delete, j junction dot,
// t cut — plus Delete for the wire selection. Logic in wireEdit.ts and
// wireDraft.ts (pure, tested); here only pointer / key plumbing, store access
// and the overlay. Every action is one editPage = one undo step.
//
// Hover, cursor and the wire being drawn live in a small store of their own
// (useWireUi), read synchronously by the handlers (no stale closures between
// two mouse-ups) and rendered by <WireOverlay> — so a mouse move re-renders
// only the overlay, and only when what is under the pointer changes.
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { Circle, Group, Line, Rect } from 'react-konva';
import { isLocked, useDocStore } from './store.ts';
import { plainKey, type KeyLike } from './hotkeys.ts';
import { canEditElement } from './stepView.ts';
import { netExists, netRefCount } from './netOps.ts';
import { anchorOf, draftClick, type Draft } from './wireDraft.ts';
import {
  addJunction,
  alignTee,
  commitWire,
  cutSegment,
  deleteSegment,
  deleteWires,
  hitSegment,
  junctionCandidate,
  orthoFrom,
  planMerge,
  removeJunction,
  resolveMerge,
  routeTo,
  snapPoint,
  snapRadius,
  wireNets,
  type EditResult,
  type JunctionAction,
  type MergePlan,
  type Pt,
  type SegHit,
  type SnapTarget,
} from './wireEdit.ts';
import type { Page } from '@kronikarz/shared';

/** A merge of two nets that each had ≥ 2 endpoints (this session) — listed in the ③ / ⑤ review queue. */
export interface SuspiciousMerge {
  pagePath: string;
  into: string;
  from: string[];
  x: number;
  y: number;
  endpoints: number;
}

interface WireUi {
  draft: Draft | null;
  cursor: { pt: Pt; target: SnapTarget | null } | null;
  hover: { seg: SegHit | null; junc: JunctionAction | null } | null;
  /** net flashed for ~1 s after a merge (NetLayer) */
  flash: string | null;
  /** non-modal note after a merge (WireToast) */
  toast: string | null;
  suspicious: SuspiciousMerge[];
}

export const useWireUi = create<WireUi>(() => ({
  draft: null,
  cursor: null,
  hover: null,
  flash: null,
  toast: null,
  suspicious: [],
}));

let flashTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * After an edit that joined nets (W, J, E drag): flash the resulting net for
 * ~1 s, show „połączono … (n końców) — Ctrl+Z cofa”, and remember a
 * suspicious merge (two nets with ≥ 2 endpoints each) for the review queue.
 * `before` = the page before the edit (which of `from` really existed).
 */
export function noteMerge(
  before: Page,
  plan: MergePlan | null,
  res: { into: string; from: string[] },
  at: Pt,
): void {
  const st = useDocStore.getState();
  const joined = res.from.filter((n) => netExists(before, n));
  if (!plan || !joined.length || !st.page || !netExists(st.page, res.into)) return;
  const endpoints = netRefCount(st.page, res.into);
  const s = useWireUi.getState();
  useWireUi.setState({
    flash: res.into,
    toast: `połączono ${joined.join(', ')} z ${res.into} (${endpoints} końców) — Ctrl+Z cofa`,
    suspicious:
      plan.suspicious && st.pagePath
        ? [
            ...s.suspicious,
            { pagePath: st.pagePath, into: res.into, from: joined, x: at.x, y: at.y, endpoints },
          ]
        : s.suspicious,
  });
  clearTimeout(flashTimer);
  clearTimeout(toastTimer);
  flashTimer = setTimeout(() => useWireUi.setState({ flash: null }), 1000);
  toastTimer = setTimeout(() => useWireUi.setState({ toast: null }), 4000);
}

/** Suspicious merges of this page still in effect (the merged net exists, none of the joined ones came back — e.g. by undo). */
export function liveSuspicious(
  all: SuspiciousMerge[],
  page: Page | null,
  pagePath: string | null,
): SuspiciousMerge[] {
  if (!page || !pagePath) return [];
  return all.filter(
    (m) =>
      m.pagePath === pagePath && netExists(page, m.into) && !m.from.some((f) => netExists(page, f)),
  );
}

interface MouseLike {
  button: number;
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  detail?: number;
}

const CLICK_PX = 4; // screen px: a mouse-up this close to the mouse-down / previous mouse-up is "the same spot"
const round = (p: Pt): Pt => ({ x: Math.round(p.x), y: Math.round(p.y) });
const targetKey = (t: SnapTarget | null) => (t ? `${t.kind}:${t.net}:${t.x},${t.y}` : '');

/** Would `fn` change the page? Run it on a copy (so no-op keys leave no undo entry). */
function changes(page: Page, fn: (p: Page) => EditResult): boolean {
  return fn(structuredClone(page)).ok;
}

/** The user's answer to a merge plan (prompt only when the plan asks). Null = cancelled. */
export function askMerge(
  page: Page,
  plan: MergePlan | null,
  fallback: string,
): { into: string; from: string[] } | null {
  if (!plan) return { into: fallback, from: [] };
  return resolveMerge(plan, (m, d) => window.prompt(m, d), {
    exists: (n) => netExists(page, n),
    confirm: (m) => window.confirm(m),
  });
}

export function useWireEditing({
  ptrScan,
  zoom,
  panning,
}: {
  ptrScan: () => Pt | null;
  zoom: number;
  panning: boolean;
}) {
  const tool = useDocStore((s) => s.tool);
  const step = useDocStore((s) => s.currentStep);
  const wireOrtho = useDocStore((s) => s.wireOrtho);
  const drafting = useWireUi((s) => s.draft !== null); // hint + hoverOn only
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const lastUpRef = useRef<{ x: number; y: number } | null>(null);
  const hoverKey = useRef('');
  const cursorKey = useRef('');

  const reset = () => {
    useWireUi.setState({ draft: null, cursor: null, hover: null });
    hoverKey.current = '';
    cursorKey.current = '';
  };
  // Another step or tool ends a started wire (like the other place / draw modes).
  useEffect(reset, [step, tool]);

  // Hover keys where wire geometry is editable (③, „wszystko”), in V / E / W, not while drawing.
  const hoverOn =
    canEditElement(step, 'segment', 'geom') &&
    (tool === 'select' || tool === 'edit' || tool === 'wire') &&
    !drafting;
  const hitTol = Math.max(2, 6 / zoom);
  const juncTol = snapRadius(zoom, 8);
  const snapR = snapRadius(zoom);

  const cancel = () => {
    useWireUi.setState({ draft: null, cursor: null });
    cursorKey.current = '';
  };

  // Snap target of the pointer; while drawing ortho, a T slides along its wire to the last point's axis.
  function snapAt(pg: Page, p: Pt, free: boolean): SnapTarget | null {
    const t = snapPoint(pg, p, snapR);
    const d = useWireUi.getState().draft;
    return d && wireOrtho && !free ? alignTee(pg, t, anchorOf(d)) : t;
  }

  function refreshHover(free = false): void {
    const pg = useDocStore.getState().page;
    const p = ptrScan();
    if (!pg || !p) return;
    const ui = useWireUi.getState();
    if (tool === 'wire') {
      const target = snapAt(pg, p, free);
      const d = ui.draft;
      const pt = target
        ? { x: target.x, y: target.y }
        : d && wireOrtho && !free
          ? orthoFrom(anchorOf(d), round(p))
          : round(p);
      // Without a wire only the snap ring is drawn; while drawing also the rubber line.
      const key = d ? `${pt.x},${pt.y}|${targetKey(target)}` : targetKey(target);
      if (key !== cursorKey.current) {
        cursorKey.current = key;
        useWireUi.setState({ cursor: { pt, target } });
      }
    }
    if (hoverOn) {
      const seg = hitSegment(pg, p, hitTol);
      const junc = junctionCandidate(pg, p, juncTol);
      const key = `${seg ? `${seg.net}#${seg.idx}` : ''}|${junc ? `${junc.kind}${junc.at.x},${junc.at.y}` : ''}`;
      if (key !== hoverKey.current) {
        hoverKey.current = key;
        useWireUi.setState({ hover: seg || junc ? { seg, junc } : null });
      }
    } else if (ui.hover) {
      hoverKey.current = '';
      useWireUi.setState({ hover: null });
    }
  }

  function clearSegmentSelection(): void {
    const st = useDocStore.getState();
    if (st.selection?.kind === 'segment') st.setSelection(null);
  }

  function finish(d: Draft, end: Pt, endT: SnapTarget | null, route: boolean): void {
    const st = useDocStore.getState();
    const pg = st.page;
    cancel();
    if (!pg || isLocked(st)) return;
    const pts = [d.start, ...d.vertices];
    const tail = route ? routeTo(pg, pts[pts.length - 1]!, end, wireOrtho) : [end];
    const full = [...pts, ...tail];
    const { names, fallback } = wireNets(pg, d.startT, endT);
    const plan = planMerge(pg, names);
    const res = askMerge(pg, plan, names[0] ?? fallback);
    // A wire that would add nothing (only along existing wires) leaves no undo entry.
    if (res && commitWire(structuredClone(pg), full, res.into, res.from, d.startT, endT)) {
      st.editPage((p) => void commitWire(p, full, res.into, res.from, d.startT, endT));
      noteMerge(pg, plan, res, end);
    }
    clearSegmentSelection();
  }

  /** W: one click (mouse up without drag) — wireDraft.draftClick decides. */
  function wireClick(e: MouseLike, nearLast: boolean): void {
    const pg = useDocStore.getState().page;
    const p = ptrScan();
    if (!pg || !p) return;
    const target = snapAt(pg, p, e.shiftKey);
    const at = target ? { x: target.x, y: target.y } : round(p);
    const out = draftClick(useWireUi.getState().draft, {
      at,
      target,
      free: e.shiftKey,
      ortho: wireOrtho,
      count: e.detail ?? 1,
      nearLast,
    });
    if (out.kind === 'start') useWireUi.setState({ draft: out.draft, cursor: { pt: at, target } });
    else if (out.kind === 'vertex') useWireUi.setState({ draft: out.draft });
    else if (out.kind === 'cancel') cancel();
    else if (out.kind === 'commit') finish(out.draft, out.end, out.endT, out.route);
  }

  /** Enter: end the wire at the cursor (free end, or its snap target). */
  function finishAtCursor(): void {
    const { draft: d, cursor } = useWireUi.getState();
    if (!d) return;
    const a = anchorOf(d);
    if (cursor && (cursor.pt.x !== a.x || cursor.pt.y !== a.y))
      return finish(d, cursor.pt, cursor.target, true);
    const last = d.vertices[d.vertices.length - 1];
    if (!last) return cancel();
    finish({ ...d, vertices: d.vertices.slice(0, -1) }, last, null, false);
  }

  function edit(fn: (p: Page) => EditResult): boolean {
    const st = useDocStore.getState();
    if (!st.page || isLocked(st) || !changes(st.page, fn)) return false;
    st.editPage((p) => void fn(p));
    clearSegmentSelection();
    refreshHover();
    return true;
  }

  /** Delete the wire selection (rectangle / Shift+click), else the selected segment. */
  function deleteSelected(): boolean {
    const st = useDocStore.getState();
    if (!canEditElement(st.currentStep, 'segment', 'geom')) return false;
    if (st.wireSel) {
      const sel = st.wireSel;
      st.setWireSel(null);
      return edit((p) => deleteWires(p, sel));
    }
    if (st.selection?.kind === 'segment') {
      const { netName, segmentIdx } = st.selection;
      return edit((p) => deleteSegment(p, netName, segmentIdx));
    }
    return false;
  }

  function deleteHovered(): boolean {
    const pg = useDocStore.getState().page;
    const p = ptrScan();
    const h = pg && p && hoverOn ? hitSegment(pg, p, hitTol) : null;
    return h ? edit((q) => deleteSegment(q, h.net, h.idx)) : false;
  }

  function toggleJunction(): void {
    const st = useDocStore.getState();
    const pg = st.page;
    const p = ptrScan();
    const c = pg && p ? junctionCandidate(pg, p, juncTol) : null;
    if (!pg || !c || isLocked(st)) return;
    if (c.kind === 'remove') {
      edit((q) => removeJunction(q, c.at));
      return;
    }
    const plan = planMerge(pg, c.nets);
    const res = askMerge(pg, plan, c.nets[0]!);
    if (res && edit((q) => (addJunction(q, c.at, res.into, res.from), { ok: true, split: [] })))
      noteMerge(pg, plan, res, c.at);
  }

  function cutHovered(): void {
    const pg = useDocStore.getState().page;
    const p = ptrScan();
    const h = pg && p ? hitSegment(pg, p, hitTol) : null;
    if (h) edit((q) => cutSegment(q, h.net, h.idx, h.at));
  }

  return {
    hoverOn,
    /** Window keydown; true = handled (Canvas stops there). */
    onKeyDown(e: KeyLike & { repeat?: boolean; preventDefault(): void }): boolean {
      const d = useWireUi.getState().draft;
      if (tool === 'wire' && d) {
        if (e.key === 'Escape') return (cancel(), true);
        if (e.key === 'Enter') return (finishAtCursor(), true);
        if (e.key === 'Backspace') {
          e.preventDefault();
          useWireUi.setState({ draft: { ...d, vertices: d.vertices.slice(0, -1) } });
          return true;
        }
      }
      if (!hoverOn) return false;
      const k = plainKey(e);
      if (k !== 'x' && k !== 'j' && k !== 't') return false;
      if (e.repeat) return true; // held key: one action, not one per autorepeat
      if (k === 'x') deleteHovered() || deleteSelected();
      else if (k === 'j') toggleJunction();
      else cutHovered();
      return true;
    },
    /** Delete / Backspace when Canvas had no element selection to delete: wire selection, else the hovered wire. */
    deleteFallback(): boolean {
      return deleteSelected() || deleteHovered();
    },
    onMouseMove(shift: boolean): void {
      refreshHover(shift);
    },
    onMouseDown(e: MouseLike): void {
      downRef.current = tool === 'wire' && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    },
    onMouseUp(e: MouseLike): void {
      const d = downRef.current;
      downRef.current = null;
      if (tool !== 'wire' || !d || panning || e.button !== 0 || e.ctrlKey || e.metaKey) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
      const last = lastUpRef.current;
      lastUpRef.current = { x: e.clientX, y: e.clientY };
      wireClick(e, !!last && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= CLICK_PX);
    },
    cancel,
    hint:
      tool !== 'wire'
        ? null
        : drafting
          ? 'klik = wierzchołek · klik na pin / port / koniec / drut = zakończ · 2×klik / Enter = wolny koniec · Backspace = cofnij wierzchołek · Shift = bez orto · Esc = anuluj'
          : 'klik = początek drutu (przyciąga do pinów, portów, końców i drutów) · x / j / t jak w V · Esc = wyjdź',
  };
}

/** Hover highlight, dot ring, the wire being drawn and the W snap ring (inside a non-listening layer). */
export function WireOverlay({ zoom }: { zoom: number }): JSX.Element {
  const { draft, cursor, hover } = useWireUi();
  const page = useDocStore((s) => s.page);
  const tool = useDocStore((s) => s.tool);
  const wireOrtho = useDocStore((s) => s.wireOrtho);
  const seg = hover?.seg ? page?.nets[hover.seg.net]?.segments?.[hover.seg.idx] : null;
  return (
    <Group listening={false}>
      {seg && (
        <Line points={seg} stroke="#ff4dd2" opacity={0.6} strokeWidth={7 / zoom} lineCap="round" />
      )}
      {hover?.junc && (
        <Circle
          x={hover.junc.at.x}
          y={hover.junc.at.y}
          radius={8 / zoom}
          stroke={hover.junc.kind === 'add' ? '#00e5ff' : '#ff3838'}
          strokeWidth={2 / zoom}
          dash={hover.junc.kind === 'remove' ? [3 / zoom, 2 / zoom] : undefined}
        />
      )}
      {draft && (
        <>
          <Line
            points={[
              draft.start,
              ...draft.vertices,
              ...(cursor && page ? routeTo(page, anchorOf(draft), cursor.pt, wireOrtho) : []),
            ].flatMap((p) => [p.x, p.y])}
            stroke="#FF9800"
            strokeWidth={2 / zoom}
          />
          {draft.vertices.map((v, i) => (
            <Rect
              key={i}
              x={v.x - 3 / zoom}
              y={v.y - 3 / zoom}
              width={6 / zoom}
              height={6 / zoom}
              fill="#FF9800"
            />
          ))}
        </>
      )}
      {tool === 'wire' && cursor?.target && (
        <Circle
          x={cursor.target.x}
          y={cursor.target.y}
          radius={7 / zoom}
          stroke="#FF9800"
          strokeWidth={2 / zoom}
        />
      )}
    </Group>
  );
}

/** Non-modal note after a merge (bottom of the canvas, ~4 s). */
export function WireToast(): JSX.Element | null {
  const toast = useWireUi((s) => s.toast);
  if (!toast) return null;
  return (
    <div
      className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 border border-warning/70 bg-bg-panel px-2 py-1 text-xs text-text-main"
      data-testid="wire-toast"
    >
      {toast}
    </div>
  );
}
