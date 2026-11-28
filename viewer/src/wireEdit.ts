// Wire editing after step ③ (kr-9p8.25): delete / draw / junction dot / cut /
// move end, and the rectangle selection of wires. Pure — no React, no store —
// mutate the page passed in; call inside `editPage` so one action = one undo
// step (and provenance is tracked by applyHumanEdit).
//
// Connectivity is the validator's: two segments of a net touch when their
// ends are within CONNECT_TOL (8 px, like NET_DISCONNECTED). A segment end in
// the interior of another segment of the same net counts only with a junction
// dot there (like ENDPOINT_NET_MISMATCH's mid-line rule) — a T without a dot,
// or a crossing, is two separate wires.
//
// Split policy: when an edit (delete, cut, removing a dot) breaks a connected
// piece of a net into several, the piece with the most endpoints labelled
// with the net's own name, then labelled endpoints (port / cross_ref with a
// label, power symbol), then endpoints, then segments keeps the name; every other piece becomes a new net together with
// its junctions and the pins / ports / cross_refs / power symbols on it. The
// new net is named after its most frequent label / power type
// (netOps.uniqueNetName), else NET_AUTO_<n> (smallest free n, like step ③).
// Pieces that were already disconnected before the edit are left alone (the
// validator keeps flagging them).
import type { Page, Port } from '@kronikarz/shared';
import {
  assignEndpointNet,
  isNetLive,
  netExists,
  netRefCount,
  normalizeNetName,
  pruneNetIfDead,
  renameNet,
  uniqueNetName,
  type EndpointRef,
} from './netOps.ts';

export type Seg = [number, number, number, number];
export interface Pt {
  x: number;
  y: number;
}

export const CONNECT_TOL = 8;
/** Half of the gap a cut leaves (gap 12 px > CONNECT_TOL: the two ends no longer touch). */
export const CUT_HALF = 6;
/** Wire end ≤ this many px off-axis from the previous point: one straight (slightly skewed) segment instead of an L. */
export const ORTHO_SKEW = 8;

const ON_LINE = 1; // px: a point "lies on" a segment
const near = (a: Pt, b: Pt, tol: number): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
const same = (a: Pt, b: Pt): boolean => a.x === b.x && a.y === b.y;
const ends = (s: Seg): [Pt, Pt] => [
  { x: s[0], y: s[1] },
  { x: s[2], y: s[3] },
];
const segKey = (s: Seg): string => {
  const a = `${s[0]},${s[1]}`;
  const b = `${s[2]},${s[3]}`;
  return a < b ? `${a};${b}` : `${b};${a}`;
};

function netNames(page: Page): string[] {
  return Object.keys(page.nets).filter((n) => normalizeNetName(n));
}

function segsOf(page: Page, name: string): Seg[] {
  return (page.nets[name]?.segments ?? []) as Seg[];
}

/** Projection of `p` on segment `s`: t ∈ [0,1], point, distance. */
export function project(s: Seg, p: Pt): { t: number; x: number; y: number; d: number } {
  const dx = s[2] - s[0];
  const dy = s[3] - s[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - s[0]) * dx + (p.y - s[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = s[0] + t * dx;
  const y = s[1] + t * dy;
  return { t, x, y, d: Math.hypot(p.x - x, p.y - y) };
}

/** `p` lies on `s` strictly between its ends (≤ ON_LINE px from the line). */
export function inInterior(s: Seg, p: Pt): boolean {
  const [a, b] = ends(s);
  if (near(p, a, ON_LINE) || near(p, b, ON_LINE)) return false;
  return project(s, p).d <= ON_LINE;
}

/** Wire attach point of a port (opposite the chevron tip), as in PortLayer / Canvas. */
export function portOpenEnd(p: Pick<Port, 'x' | 'y' | 'side' | 'connector' | 'pin'>): Pt {
  const labelWidth = Math.max(60, `${p.connector}${p.pin}`.length * 16 + 12);
  const bw = labelWidth + 16;
  const rot = p.side === 'left' ? 0 : p.side === 'right' ? 180 : p.side === 'top' ? 90 : 270;
  const rad = (rot * Math.PI) / 180;
  return { x: Math.round(p.x + bw * Math.cos(rad)), y: Math.round(p.y + bw * Math.sin(rad)) };
}

export interface EndpointPos extends Pt {
  ep: EndpointRef;
  net: string;
  /** port / cross_ref with a printed label, or a power symbol — names its net */
  labeled: boolean;
  /** that name: the label, or the power type */
  label?: string;
  /** power symbol type (its natural net name) */
  power?: string;
}

/** Every wire endpoint of the page (NC pins skipped, like the validator). */
export function endpointPositions(page: Page): EndpointPos[] {
  const out: EndpointPos[] = [];
  page.gates.forEach((g, gateIdx) =>
    g.pins.forEach((pin, pinIdx) => {
      if (!pin.disconnected)
        out.push({
          x: pin.px,
          y: pin.py,
          ep: { kind: 'pin', gateIdx, pinIdx },
          net: pin.net,
          labeled: false,
        });
    }),
  );
  (page.ports ?? []).forEach((p, idx) => {
    const label = p.label?.trim() || undefined;
    out.push({ ...portOpenEnd(p), ep: { kind: 'port', idx }, net: p.net, labeled: !!label, label });
  });
  (page.cross_refs ?? []).forEach((c, idx) => {
    const label = c.label?.trim() || undefined;
    out.push({
      x: c.x,
      y: c.y,
      ep: { kind: 'cross_ref', idx },
      net: c.net,
      labeled: !!label,
      label,
    });
  });
  (page.power ?? []).forEach((p, idx) =>
    out.push({
      x: p.x,
      y: p.y,
      ep: { kind: 'power', idx },
      net: p.net,
      labeled: true,
      label: p.type,
      power: p.type,
    }),
  );
  return out;
}

// --- hit test / snapping ---

export interface SegHit {
  net: string;
  idx: number;
  /** projection of the cursor on the segment (rounded) */
  at: Pt;
  d: number;
}

/** Nearest segment within `tol` of `p`, or null. */
export function hitSegment(page: Page, p: Pt, tol: number): SegHit | null {
  let best = null as SegHit | null;
  for (const net of netNames(page)) {
    segsOf(page, net).forEach((s, idx) => {
      const pr = project(s, p);
      if (pr.d <= tol && (!best || pr.d < best.d))
        best = { net, idx, at: { x: Math.round(pr.x), y: Math.round(pr.y) }, d: pr.d };
    });
  }
  return best;
}

export type SnapTarget =
  | ({ kind: 'endpoint' } & EndpointPos)
  | { kind: 'point'; x: number; y: number; net: string } // segment end / junction
  | { kind: 'segment'; x: number; y: number; net: string; idx: number }; // segment interior (T)

export interface SnapExclude {
  net: string;
  /** points of `net` at `at` and segments of `net` ending there are skipped (they are being moved) */
  at: Pt;
}

/**
 * Where a wire end at `p` attaches: the nearest endpoint (pin / port open end /
 * cross_ref / power) within `radius`, else the nearest segment end or junction,
 * else the nearest point inside a segment (a T). Null = free point.
 */
export function snapPoint(
  page: Page,
  p: Pt,
  radius: number,
  exclude?: SnapExclude,
): SnapTarget | null {
  const dist = (q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);
  let ep: (EndpointPos & { d: number }) | null = null;
  for (const e of endpointPositions(page)) {
    const d = dist(e);
    if (d <= radius && (!ep || d < ep.d)) ep = { ...e, d };
  }
  if (ep) {
    const { d: _d, ...rest } = ep;
    void _d;
    return { kind: 'endpoint', ...rest };
  }
  const skipPt = (net: string, q: Pt) => !!exclude && exclude.net === net && same(q, exclude.at);
  const skipSeg = (net: string, s: Seg) =>
    !!exclude && exclude.net === net && ends(s).some((q) => same(q, exclude.at));
  let pt = null as { x: number; y: number; net: string; d: number } | null;
  const consider = (net: string, q: Pt) => {
    if (skipPt(net, q)) return;
    const d = dist(q);
    if (d <= radius && (!pt || d < pt.d)) pt = { x: q.x, y: q.y, net, d };
  };
  for (const net of netNames(page)) {
    for (const s of segsOf(page, net)) for (const q of ends(s)) consider(net, q);
    for (const j of page.nets[net]?.junctions ?? []) consider(net, { x: j[0], y: j[1] });
  }
  if (pt) return { kind: 'point', x: pt.x, y: pt.y, net: pt.net };
  let sg = null as { x: number; y: number; net: string; idx: number; d: number } | null;
  for (const net of netNames(page)) {
    segsOf(page, net).forEach((s, idx) => {
      if (skipSeg(net, s)) return;
      const pr = project(s, p);
      const q = { x: Math.round(pr.x), y: Math.round(pr.y) };
      if (pr.d <= radius && inInterior(s, q) && (!sg || pr.d < sg.d))
        sg = { ...q, net, idx, d: pr.d };
    });
  }
  if (sg) return { kind: 'segment', x: sg.x, y: sg.y, net: sg.net, idx: sg.idx };
  return null;
}

/** Axis-locked point from `ref` toward `p` (the longer delta wins). */
export function orthoFrom(ref: Pt, p: Pt): Pt {
  return Math.abs(p.x - ref.x) >= Math.abs(p.y - ref.y)
    ? { x: p.x, y: ref.y }
    : { x: ref.x, y: p.y };
}

/**
 * Ortho drawing: a T target slides along its wire to `anchor`'s axis when it
 * stays inside the wire — the new wire is then straight, without a skew.
 */
export function alignTee(page: Page, t: SnapTarget | null, anchor: Pt): SnapTarget | null {
  if (t?.kind !== 'segment') return t;
  const s = segsOf(page, t.net)[t.idx];
  if (!s) return t;
  const on = [
    { x: anchor.x, y: t.y },
    { x: t.x, y: anchor.y },
  ].filter((c) => inInterior(s, c) && project(s, c).d <= 0.5);
  if (!on.length) return t;
  const d = (c: Pt) => Math.hypot(c.x - t.x, c.y - t.y);
  const best = on.reduce((a, b) => (d(b) < d(a) ? b : a));
  return { ...t, x: best.x, y: best.y };
}

/**
 * Points to append after `last` to reach `end`. Ortho: an L corner, chosen so
 * it does not land inside an existing segment; an end at most ORTHO_SKEW px
 * off-axis is reached by one straight segment (the end stays exactly on the
 * pin / wire — endpoints are never moved).
 */
export function routeTo(page: Page, last: Pt, end: Pt, ortho: boolean): Pt[] {
  if (!ortho || last.x === end.x || last.y === end.y) return [end];
  const dx = Math.abs(end.x - last.x);
  const dy = Math.abs(end.y - last.y);
  if (Math.min(dx, dy) <= ORTHO_SKEW) return [end];
  const c1 = { x: end.x, y: last.y };
  const c2 = { x: last.x, y: end.y };
  const onAny = (q: Pt) =>
    netNames(page).some((n) => segsOf(page, n).some((s) => inInterior(s, q)));
  const b1 = onAny(c1);
  const b2 = onAny(c2);
  const corner = b1 && !b2 ? c2 : b2 && !b1 ? c1 : dx >= dy ? c1 : c2;
  return [corner, end];
}

// --- nets: names, merge planning ---

/** Generated placeholder names (NET_AUTO_n from step ③, NET_<pin> / NET_<timestamp> from the W tool). */
export function isPlaceholderNet(name: string): boolean {
  return /^NET_/.test(name);
}

/** NET_AUTO_<n>, smallest n ≥ 1 not used on the page (like step ③). */
export function nextAutoNetName(page: Page): string {
  for (let n = 1; ; n++) {
    const name = `NET_AUTO_${n}`;
    if (!netExists(page, name)) return name;
  }
}

/** Every label naming net `name`: port / cross_ref labels and power types on it. */
function netLabels(page: Page, name: string): Set<string> {
  const out = new Set<string>();
  for (const p of page.ports ?? []) if (p.net === name && p.label?.trim()) out.add(p.label.trim());
  for (const c of page.cross_refs ?? [])
    if (c.net === name && c.label?.trim()) out.add(c.label.trim());
  for (const p of page.power ?? []) if (p.net === name) out.add(p.type);
  return out;
}

/** Label sets that may merge silently: equal, or one of them empty. */
const compatible = (a: Set<string>, b: Set<string>): boolean =>
  a.size === 0 || b.size === 0 || (a.size === b.size && [...a].every((x) => b.has(x)));

/** A power symbol's type names a net even before any net carries it. */
const isPowerName = (page: Page, name: string): boolean =>
  (page.power ?? []).some((p) => p.type === name);

export interface MergePlan {
  into: string;
  from: string[];
  /** the UI must ask: a name has to be chosen (two real names, different labels) */
  confirm: boolean;
  /**
   * two of the joined nets have ≥ 2 endpoints each — merged without asking
   * (USER), but the UI flashes the net, shows a toast and lists the merge in
   * the review queue: a snap may have landed on the wrong wire
   */
  suspicious: boolean;
}

/**
 * Joining nets `names` (first = where the action started). Dead nets are
 * absorbed silently. A real name (not NET_* — also a power type, even of a
 * power symbol not on a net yet) wins first, then a labelled placeholder,
 * over a plain placeholder — merging placeholders loses nothing; a real name
 * never loses to a labelled placeholder. `confirm` (the user picks the name)
 * when two real names differ and their label sets are not the same
 * non-empty set, or when the label sets (port / cross_ref labels, power
 * types) of any two of these nets are incompatible — compatible = equal or
 * one empty. Placeholders only → the one with most references + segments.
 * Null when fewer than two distinct names.
 */
export function planMerge(page: Page, names: string[]): MergePlan | null {
  const uniq = [...new Set(names.map((n) => normalizeNetName(n)).filter((n): n is string => !!n))];
  if (uniq.length < 2) return null;
  const live = uniq.filter((n) => isNetLive(page, n) || isPowerName(page, n));
  const realNames = live.filter((n) => !isPlaceholderNet(n));
  const labelled = live.filter((n) => isPlaceholderNet(n) && netLabels(page, n).size > 0);
  const real = [...realNames, ...labelled];
  let into: string;
  let confirm = false;
  if (real.length >= 1) {
    into = real[0]!;
    const sets = real.map((n) => netLabels(page, n));
    const allCompatible = sets.every((a, i) => sets.every((b, j) => j <= i || compatible(a, b)));
    const nameSets = realNames.map((n) => netLabels(page, n));
    const sameNamedSet = nameSets.every(
      (x) => x.size > 0 && compatible(x, nameSets[0]!) && nameSets[0]!.size > 0,
    );
    confirm = !allCompatible || (realNames.length >= 2 && !sameNamedSet);
  } else if (live.length >= 1) {
    const weight = (n: string) => netRefCount(page, n) + segsOf(page, n).length;
    into = live.reduce((a, b) => (weight(b) > weight(a) ? b : a));
  } else {
    into = uniq[0]!;
  }
  const suspicious = live.filter((n) => netRefCount(page, n) >= 2).length >= 2;
  return { into, from: uniq.filter((n) => n !== into), confirm, suspicious };
}

/** Rename every net of `from` into `into` (netOps.renameNet: entries merged, endpoints follow). */
export function mergeNets(page: Page, from: string[], into: string): void {
  for (const f of from) if (f !== into && netExists(page, f)) renameNet(page, f, into);
}

/** Nets with a segment end, a junction or a segment interior at `at`. */
export function netsAt(page: Page, at: Pt): string[] {
  return netNames(page).filter((n) => {
    const net = page.nets[n]!;
    return (
      segsOf(page, n).some((s) => ends(s).some((q) => same(q, at)) || inInterior(s, at)) ||
      (net.junctions ?? []).some((j) => near({ x: j[0], y: j[1] }, at, ON_LINE))
    );
  });
}

/** Nets of the endpoints (pins …) exactly at `at` — non-empty names only. */
function endpointNetsAt(page: Page, at: Pt): string[] {
  return endpointPositions(page)
    .filter((e) => near(e, at, ON_LINE) && normalizeNetName(e.net))
    .map((e) => e.net);
}

/**
 * Nets a wire end at snap target `t` joins: the target's net, nets of the
 * endpoints on that point, and the type of a power symbol there that is on
 * no net yet (so GND wins over a NET_AUTO_n placeholder).
 */
export function targetNets(page: Page, t: SnapTarget | null): string[] {
  if (!t) return [];
  const power = endpointPositions(page)
    .filter((e) => e.power && !normalizeNetName(e.net) && near(e, t, ON_LINE))
    .map((e) => e.power!);
  const out = [t.net, ...endpointNetsAt(page, t), ...power];
  return out.filter((n) => normalizeNetName(n));
}

// --- connectivity / split ---

interface Piece {
  segs: number[];
}

/** Connected pieces of net `name` (indices into its segments). */
export function netPieces(page: Page, name: string): Piece[] {
  const segs = segsOf(page, name);
  const js = (page.nets[name]?.junctions ?? []).map((j) => ({ x: j[0], y: j[1] }));
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const dotT = (end: Pt, s: Seg) => inInterior(s, end) && js.some((j) => near(j, end, CONNECT_TOL));
  for (let i = 0; i < segs.length; i++) {
    for (let k = i + 1; k < segs.length; k++) {
      const ei = ends(segs[i]!);
      const ek = ends(segs[k]!);
      if (
        ei.some((a) => ek.some((b) => near(a, b, CONNECT_TOL))) ||
        ei.some((a) => dotT(a, segs[k]!)) ||
        ek.some((b) => dotT(b, segs[i]!))
      )
        union(i, k);
    }
  }
  const by = new Map<number, number[]>();
  segs.forEach((_, i) => {
    const r = find(i);
    const l = by.get(r);
    if (l) l.push(i);
    else by.set(r, [i]);
  });
  return [...by.values()].map((s) => ({ segs: s }));
}

/** `p` at an end of the piece (CONNECT_TOL), or with `interior` also on one of its segments. */
function pieceTouches(segs: Seg[], piece: Piece, p: Pt, interior = true): boolean {
  return piece.segs.some(
    (i) =>
      ends(segs[i]!).some((q) => near(q, p, CONNECT_TOL)) ||
      (interior && project(segs[i]!, p).d <= ON_LINE),
  );
}

/**
 * After an edit of net `name`: each group of `seeds` holds points that were
 * connected before (ends of removed segments, the two sides of a cut …). The
 * pieces touching a group were one piece — if there are several now, all but
 * the best one move to new NET_AUTO_<n> nets (see split policy at the top).
 * Returns the new names.
 */
export function splitDetached(page: Page, name: string, seedGroups: Pt[][]): string[] {
  const net = page.nets[name];
  if (!net?.segments?.length) return [];
  const segs = net.segments as Seg[];
  const pieces = netPieces(page, name);
  const eps = endpointPositions(page).filter((e) => e.net === name);
  const moves: Array<{ piece: Piece; eps: EndpointPos[] }> = [];
  const claimed = new Set<Piece>();
  for (const group of seedGroups) {
    const touched = pieces.filter(
      (pc) => !claimed.has(pc) && group.some((s) => pieceTouches(segs, pc, s)),
    );
    if (touched.length < 2) continue;
    touched.forEach((pc) => claimed.add(pc));
    const scored = touched.map((pc) => {
      const on = eps.filter((e) => pieceTouches(segs, pc, e, false));
      // A piece whose label / power type is the net's own name keeps it first.
      const own = on.filter((e) => e.label === name).length;
      return {
        pc,
        on,
        score: [own, on.filter((e) => e.labeled).length, on.length, pc.segs.length],
      };
    });
    let best = scored[0]!;
    for (const s of scored) {
      for (let k = 0; k < s.score.length; k++) {
        if (s.score[k]! > best.score[k]!) {
          best = s;
          break;
        }
        if (s.score[k]! < best.score[k]!) break;
      }
    }
    for (const s of scored) if (s !== best) moves.push({ piece: s.pc, eps: s.on });
  }
  const created: string[] = [];
  const movedIdx = new Set<number>();
  const movedJ = new Set<number>();
  const juncs = net.junctions ?? [];
  for (const m of moves) {
    const newName = pieceName(page, m.eps);
    const mySegs = m.piece.segs.map((i) => segs[i]!);
    const myJ: Array<[number, number]> = [];
    juncs.forEach((j, ji) => {
      if (movedJ.has(ji)) return;
      if (pieceTouches(segs, m.piece, { x: j[0], y: j[1] })) {
        movedJ.add(ji);
        myJ.push(j);
      }
    });
    m.piece.segs.forEach((i) => movedIdx.add(i));
    page.nets[newName] = { pins: [], segments: mySegs, junctions: myJ.length ? myJ : null };
    for (const e of m.eps) assignEndpointNet(page, e.ep, newName);
    created.push(newName);
  }
  net.segments = segs.filter((_, i) => !movedIdx.has(i));
  if (net.junctions) {
    const rest = juncs.filter((_, ji) => !movedJ.has(ji));
    net.junctions = rest.length ? rest : null;
  }
  return created;
}

/** Name for a split-off piece: its most frequent label / power type (made unique), else NET_AUTO_<n>. */
function pieceName(page: Page, eps: EndpointPos[]): string {
  const count = new Map<string, number>();
  for (const e of eps) if (e.label) count.set(e.label, (count.get(e.label) ?? 0) + 1);
  let best: string | null = null;
  for (const [l, n] of count) if (best === null || n > count.get(best)!) best = l;
  return best ? uniqueNetName(page, best) : nextAutoNetName(page);
}

/** Connections at `p` in net `name`: segment ends + 2 per segment passing through + endpoints of the net. */
function degreeAt(page: Page, name: string, p: Pt): number {
  let n = 0;
  for (const s of segsOf(page, name)) {
    n += ends(s).filter((q) => near(q, p, ON_LINE)).length;
    if (inInterior(s, p)) n += 2;
  }
  n += endpointPositions(page).filter((e) => e.net === name && near(e, p, ON_LINE)).length;
  return n;
}

/** Drop junction dots of `name` at `pts` that no longer join three or more wires. */
function dropStrayJunctions(page: Page, name: string, pts: Pt[]): void {
  const net = page.nets[name];
  if (!net?.junctions) return;
  if (!net.segments?.length) {
    net.junctions = null;
    return;
  }
  const keep = net.junctions.filter((j) => {
    const jp = { x: j[0], y: j[1] };
    return !pts.some((p) => near(p, jp, ON_LINE)) || degreeAt(page, name, jp) >= 3;
  });
  net.junctions = keep.length ? keep : null;
}

// --- wire selection (rectangle / Shift+click) ---

/** Wires selected by value (indices shift on every edit; values stay valid until the wire changes). */
export interface WireSel {
  segs: Array<{ net: string; seg: Seg }>;
  juncs: Array<{ net: string; x: number; y: number }>;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function segCrossesBox(s: Seg, r: Box): boolean {
  const inside = (q: Pt) => q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;
  const [a, b] = ends(s);
  if (inside(a) || inside(b)) return true;
  const edges: Seg[] = [
    [r.x, r.y, r.x + r.w, r.y],
    [r.x + r.w, r.y, r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h, r.x + r.w, r.y + r.h],
    [r.x, r.y, r.x, r.y + r.h],
  ];
  return edges.some((e) => segmentsCross(s, e) !== null);
}

/**
 * Wires in rectangle `r`: a segment whose both ends lie inside (with
 * `touching`: any segment the rectangle touches — Alt), junction dots inside.
 */
export function wiresInBox(page: Page, r: Box, touching = false): WireSel {
  const inside = (q: Pt) => q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y && q.y <= r.y + r.h;
  const out: WireSel = { segs: [], juncs: [] };
  for (const net of netNames(page)) {
    for (const s of segsOf(page, net)) {
      const [a, b] = ends(s);
      if (touching ? segCrossesBox(s, r) : inside(a) && inside(b))
        out.segs.push({ net, seg: [...s] as Seg });
    }
    for (const j of page.nets[net]?.junctions ?? [])
      if (inside({ x: j[0], y: j[1] })) out.juncs.push({ net, x: j[0], y: j[1] });
  }
  return out;
}

const selSegKey = (e: { net: string; seg: Seg }) => `${e.net}|${segKey(e.seg)}`;
const selJKey = (e: { net: string; x: number; y: number }) => `${e.net}|${e.x},${e.y}`;

/** Shift: toggle `add` in `cur` (present → removed, absent → added); otherwise `add` replaces. Empty → null. */
export function combineWireSel(cur: WireSel | null, add: WireSel, toggle: boolean): WireSel | null {
  let res: WireSel = add;
  if (toggle && cur) {
    const ak = new Set(add.segs.map(selSegKey));
    const aj = new Set(add.juncs.map(selJKey));
    const ck = new Set(cur.segs.map(selSegKey));
    const cj = new Set(cur.juncs.map(selJKey));
    res = {
      segs: [
        ...cur.segs.filter((e) => !ak.has(selSegKey(e))),
        ...add.segs.filter((e) => !ck.has(selSegKey(e))),
      ],
      juncs: [
        ...cur.juncs.filter((e) => !aj.has(selJKey(e))),
        ...add.juncs.filter((e) => !cj.has(selJKey(e))),
      ],
    };
  }
  return res.segs.length || res.juncs.length ? res : null;
}

/** Is segment `seg` of `net` in the selection (by value)? */
export function wireSelHas(sel: WireSel | null, net: string, seg: Seg): boolean {
  if (!sel) return false;
  const k = selSegKey({ net, seg });
  return sel.segs.some((e) => selSegKey(e) === k);
}

// --- edits ---

export interface EditResult {
  ok: boolean;
  /** new nets made by the split policy */
  split: string[];
}

/**
 * Delete wires (segments and junction dots, by value) in one go. Per net:
 * dots left joining < 3 wires at the removed ends are dropped, pieces cut
 * apart are split off (split policy), a net left dead is removed.
 */
export function deleteWires(page: Page, sel: WireSel): EditResult {
  const byNet = new Map<string, { segs: Set<string>; juncs: Set<string> }>();
  const slot = (n: string) => {
    let s = byNet.get(n);
    if (!s) byNet.set(n, (s = { segs: new Set(), juncs: new Set() }));
    return s;
  };
  for (const e of sel.segs) slot(e.net).segs.add(segKey(e.seg));
  for (const j of sel.juncs) slot(j.net).juncs.add(`${j.x},${j.y}`);
  let ok = false;
  const split: string[] = [];
  for (const [name, want] of byNet) {
    const net = page.nets[name];
    if (!net) continue;
    const segs = (net.segments ?? []) as Seg[];
    // Seeds grouped by the piece they belonged to before the edit.
    const pieces = netPieces(page, name);
    const groups = new Map<Piece, Pt[]>();
    const removedEnds: Pt[] = [];
    const removed = new Set<number>();
    segs.forEach((s, i) => {
      if (!want.segs.has(segKey(s))) return;
      want.segs.delete(segKey(s)); // one entry removes one copy
      removed.add(i);
      const pc = pieces.find((p) => p.segs.includes(i))!;
      const g = groups.get(pc) ?? [];
      g.push(...ends(s));
      groups.set(pc, g);
      removedEnds.push(...ends(s));
    });
    if (removed.size) {
      net.segments = segs.filter((_, i) => !removed.has(i));
      ok = true;
    }
    if (net.junctions && want.juncs.size) {
      const before = net.junctions.length;
      const rest = net.junctions.filter((j) => !want.juncs.has(`${j[0]},${j[1]}`));
      if (rest.length !== before) ok = true;
      net.junctions = rest.length ? rest : null;
    }
    dropStrayJunctions(page, name, removedEnds);
    split.push(...splitDetached(page, name, [...groups.values()]));
    pruneNetIfDead(page, name);
  }
  return { ok, split };
}

/** Delete one segment (index) — deleteWires for one wire. */
export function deleteSegment(page: Page, name: string, idx: number): EditResult {
  const s = page.nets[name]?.segments?.[idx];
  if (!s) return { ok: false, split: [] };
  return deleteWires(page, { segs: [{ net: name, seg: [...s] as Seg }], juncs: [] });
}

/**
 * Cut segment `idx` of `name` at `at` (projected): a gap of at least
 * 2·CUT_HALF px along the wire and more than CONNECT_TOL px on some axis
 * (connectivity uses Chebyshev distance — a 45° wire needs a longer gap), so
 * the two sides are separate wires; the split policy names the far side.
 * Refused (ok: false, page untouched) when the segment is too short.
 */
export function cutSegment(page: Page, name: string, idx: number, at: Pt): EditResult {
  const net = page.nets[name];
  const s = net?.segments?.[idx] as Seg | undefined;
  if (!net || !s) return { ok: false, split: [] };
  const len = Math.hypot(s[2] - s[0], s[3] - s[1]);
  if (len === 0) return { ok: false, split: [] };
  const ux = (s[2] - s[0]) / len;
  const uy = (s[3] - s[1]) / len;
  // +2: rounding each end may shorten the gap by up to 1 px per axis.
  const half = Math.max(
    CUT_HALF,
    Math.ceil((CONNECT_TOL + 2) / Math.max(Math.abs(ux), Math.abs(uy)) / 2),
  );
  if (len < 2 * half + 2) return { ok: false, split: [] };
  const tc = Math.max(half + 1, Math.min(len - half - 1, project(s, at).t * len));
  const p1 = { x: Math.round(s[0] + ux * (tc - half)), y: Math.round(s[1] + uy * (tc - half)) };
  const p2 = { x: Math.round(s[0] + ux * (tc + half)), y: Math.round(s[1] + uy * (tc + half)) };
  if (near(p1, p2, CONNECT_TOL)) return { ok: false, split: [] };
  net.segments!.splice(idx, 1, [s[0], s[1], p1.x, p1.y], [p2.x, p2.y, s[2], s[3]]);
  return { ok: true, split: splitDetached(page, name, [[p1, p2]]) };
}

/** Proper intersection point of two segments (not at an end of either), or null. */
export function segmentsCross(a: Seg, b: Seg): Pt | null {
  const d = (a[2] - a[0]) * (b[3] - b[1]) - (a[3] - a[1]) * (b[2] - b[0]);
  if (d === 0) return null;
  const t = ((b[0] - a[0]) * (b[3] - b[1]) - (b[1] - a[1]) * (b[2] - b[0])) / d;
  const u = ((b[0] - a[0]) * (a[3] - a[1]) - (b[1] - a[1]) * (a[2] - a[0])) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a[0] + t * (a[2] - a[0]), y: a[1] + t * (a[3] - a[1]) };
}

export type JunctionAction =
  | { kind: 'add'; at: Pt; nets: string[] } // crossing / T without a dot
  | { kind: 'remove'; at: Pt; nets: string[] }; // dot (drawn or ≥ 3 ends meeting)

/**
 * What `j` does near `p` (within `tol`): an existing dot — drawn junction or
 * three+ segment ends of a net meeting — is removed; a crossing of two
 * segments or a T (segment end inside another segment) without a dot gets one.
 * The nearest candidate wins, a dot before a crossing at the same distance.
 */
export function junctionCandidate(page: Page, p: Pt, tol: number): JunctionAction | null {
  const nearSegs: Array<{ net: string; s: Seg }> = [];
  for (const net of netNames(page))
    for (const s of segsOf(page, net)) if (project(s, p).d <= tol) nearSegs.push({ net, s });
  type C = { kind: 'add' | 'remove'; at: Pt; d: number };
  const cands: C[] = [];
  const dist = (q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);
  for (const net of netNames(page))
    for (const j of page.nets[net]?.junctions ?? []) {
      const q = { x: j[0], y: j[1] };
      if (dist(q) <= tol) cands.push({ kind: 'remove', at: q, d: dist(q) });
    }
  const endCount = new Map<string, number>();
  for (const { net, s } of nearSegs)
    for (const q of ends(s)) {
      const k = `${net}|${q.x},${q.y}`;
      endCount.set(k, (endCount.get(k) ?? 0) + 1);
    }
  for (const [k, n] of endCount) {
    if (n < 3) continue;
    const [x, y] = k.split('|')[1]!.split(',').map(Number) as [number, number];
    const q = { x, y };
    if (dist(q) <= tol) cands.push({ kind: 'remove', at: q, d: dist(q) });
  }
  for (let i = 0; i < nearSegs.length; i++) {
    for (let k = 0; k < nearSegs.length; k++) {
      if (i === k) continue;
      const a = nearSegs[i]!.s;
      const b = nearSegs[k]!.s;
      for (const q of ends(a))
        if (inInterior(b, q) && dist(q) <= tol) cands.push({ kind: 'add', at: q, d: dist(q) });
      if (i < k) {
        const x = segmentsCross(a, b);
        if (!x) continue;
        const q = { x: Math.round(x.x), y: Math.round(x.y) };
        if (inInterior(a, q) && inInterior(b, q) && dist(q) <= tol)
          cands.push({ kind: 'add', at: q, d: dist(q) });
      }
    }
  }
  if (!cands.length) return null;
  cands.sort(
    (a, b) => a.d - b.d || (a.kind === 'remove' ? -1 : 1) - (b.kind === 'remove' ? -1 : 1),
  );
  const c = cands[0]!;
  const nets = [...new Set([...netsAt(page, c.at), ...endpointNetsAt(page, c.at)])];
  return { kind: c.kind, at: c.at, nets };
}

/** Split every segment of `name` that passes through `at` (interior) into two at `at`. */
function splitSegmentsAt(page: Page, name: string, at: Pt): void {
  const net = page.nets[name];
  if (!net?.segments) return;
  const out: Seg[] = [];
  for (const s of net.segments as Seg[]) {
    if (inInterior(s, at)) out.push([s[0], s[1], at.x, at.y], [at.x, at.y, s[2], s[3]]);
    else out.push(s);
  }
  net.segments = out;
}

function addJunctionTo(page: Page, name: string, at: Pt): void {
  const net = (page.nets[name] ??= { pins: [], segments: null, junctions: null });
  net.junctions ??= [];
  if (!net.junctions.some((j) => j[0] === at.x && j[1] === at.y)) net.junctions.push([at.x, at.y]);
}

/**
 * Join everything at `at` into one net with a dot: nets `from` merge into
 * `into` (planMerge + confirm in the UI), segments passing through `at` are
 * split there, and a junction is added.
 */
export function addJunction(page: Page, at: Pt, into: string, from: string[]): void {
  const nets = [...new Set([...netsAt(page, at), ...from])];
  mergeNets(
    page,
    nets.filter((n) => n !== into),
    into,
  );
  splitSegmentsAt(page, into, at);
  addJunctionTo(page, into, at);
  for (const e of endpointPositions(page))
    if (near(e, at, ON_LINE) && !normalizeNetName(e.net)) assignEndpointNet(page, e.ep, into);
}

/**
 * Remove the dot at `at`: drawn junctions there go, and at the point each pair
 * of opposite collinear segments is joined back into one (T: the through wire
 * is whole again and the stub only touches it; crossing: two crossing wires).
 * Pieces that come apart are split off (split policy). ok = something changed.
 */
export function removeJunction(page: Page, at: Pt): EditResult {
  let ok = false;
  const split: string[] = [];
  for (const name of netsAt(page, at)) {
    const net = page.nets[name]!;
    if (net.junctions) {
      const rest = net.junctions.filter((j) => !near({ x: j[0], y: j[1] }, at, ON_LINE));
      if (rest.length !== net.junctions.length) ok = true;
      net.junctions = rest.length ? rest : null;
    }
    const segs = (net.segments ?? []) as Seg[];
    const atEnd = segs
      .map((s, i) => ({
        i,
        other: same({ x: s[0], y: s[1] }, at)
          ? { x: s[2], y: s[3] }
          : same({ x: s[2], y: s[3] }, at)
            ? { x: s[0], y: s[1] }
            : null,
      }))
      .filter((e): e is { i: number; other: Pt } => e.other !== null && !same(e.other, at));
    const used = new Set<number>();
    const joined: Seg[] = [];
    const seeds: Pt[] = [at];
    for (let a = 0; a < atEnd.length; a++) {
      for (let b = a + 1; b < atEnd.length; b++) {
        if (used.has(a) || used.has(b)) continue;
        const ua = { x: atEnd[a]!.other.x - at.x, y: atEnd[a]!.other.y - at.y };
        const ub = { x: atEnd[b]!.other.x - at.x, y: atEnd[b]!.other.y - at.y };
        if (ua.x * ub.y - ua.y * ub.x !== 0 || ua.x * ub.x + ua.y * ub.y >= 0) continue;
        used.add(a);
        used.add(b);
        joined.push([atEnd[a]!.other.x, atEnd[a]!.other.y, atEnd[b]!.other.x, atEnd[b]!.other.y]);
        seeds.push(atEnd[a]!.other, atEnd[b]!.other);
      }
    }
    if (joined.length) {
      const drop = new Set([...used].map((k) => atEnd[k]!.i));
      net.segments = [...segs.filter((_, i) => !drop.has(i)), ...joined];
      ok = true;
    }
    split.push(...splitDetached(page, name, [seeds]));
  }
  return { ok, split };
}

/**
 * A wire end at `pt` on snap target `t` (already merged into `into`): a T in
 * a segment splits it there and gets a dot; endpoints on the point without a
 * net join `into`.
 */
function attachEnd(page: Page, into: string, pt: Pt, t: SnapTarget | null): void {
  if (t?.kind === 'segment') {
    splitSegmentsAt(page, into, pt);
    addJunctionTo(page, into, pt);
  }
  for (const e of endpointPositions(page)) {
    if (!near(e, pt, ON_LINE)) continue;
    if (e.net !== into) assignEndpointNet(page, e.ep, into);
  }
}

/**
 * Commit a drawn wire: `pts` (≥ 2, consecutive duplicates skipped) on net
 * `into`; nets `from` merge into it first (planMerge, confirmed by the UI).
 * Ends on a segment interior make a T with a dot; endpoints at the ends join
 * `into`. Pins / ports are never moved.
 */
export function commitWire(
  page: Page,
  pts: Pt[],
  into: string,
  from: string[],
  start: SnapTarget | null,
  end: SnapTarget | null,
): boolean {
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (!same(a, b))
      segs.push([Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y)]);
  }
  if (!segs.length) return false;
  // Drawn only along wires that are already there (e.g. along its own collinear wire):
  // nothing to add — no split, no dot, no merge.
  const onWire = (q: Seg) =>
    netNames(page).some((n) =>
      segsOf(page, n).some(
        (s) =>
          project(s, { x: q[0], y: q[1] }).d <= ON_LINE &&
          project(s, { x: q[2], y: q[3] }).d <= ON_LINE,
      ),
    );
  if (segs.every(onWire)) return false;
  mergeNets(page, from, into);
  page.nets[into] ??= { pins: [], segments: null, junctions: null };
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  // T first (splits only existing segments), then the new wire.
  attachEnd(page, into, first, start);
  attachEnd(page, into, last, end);
  // A segment the net already has (drawn again between two of its points) is not doubled.
  const have = new Set((page.nets[into]!.segments ?? []).map((q) => segKey(q as Seg)));
  page.nets[into]!.segments = [
    ...(page.nets[into]!.segments ?? []),
    ...segs.filter((q) => !have.has(segKey(q))),
  ];
  return true;
}

/**
 * Net name for a new wire from `start` to `end` targets: the joined nets'
 * plan, else a power symbol's type, else a fresh NET_AUTO_<n>.
 */
export function wireNets(
  page: Page,
  start: SnapTarget | null,
  end: SnapTarget | null,
): { names: string[]; fallback: string } {
  const names = [...new Set([...targetNets(page, start), ...targetNets(page, end)])];
  const pw = [start, end].find((t) => t?.kind === 'endpoint' && t.power) as
    | (EndpointPos & { kind: 'endpoint' })
    | undefined;
  return { names, fallback: pw?.power ?? nextAutoNetName(page) };
}

/**
 * Drag end of a net point (segment end / dot) of `name` from `from` to `to`
 * on target `t`: moves it (netOps.moveNetPoint semantics, every end of the
 * net at `from`), merges `merge` into `into` and attaches like a wire end.
 */
export function movePointTo(
  page: Page,
  name: string,
  from: Pt,
  to: Pt,
  t: SnapTarget | null,
  into: string,
  merge: string[],
): void {
  const net = page.nets[name];
  if (!net) return;
  for (const s of (net.segments ?? []) as Seg[]) {
    if (s[0] === from.x && s[1] === from.y) {
      s[0] = to.x;
      s[1] = to.y;
    }
    if (s[2] === from.x && s[3] === from.y) {
      s[2] = to.x;
      s[3] = to.y;
    }
  }
  for (const j of net.junctions ?? [])
    if (j[0] === from.x && j[1] === from.y) {
      j[0] = to.x;
      j[1] = to.y;
    }
  mergeNets(
    page,
    [name, ...merge].filter((n) => n !== into),
    into,
  );
  attachEnd(page, into, to, t);
}

/**
 * The user's answer to a merge plan: no confirm → the plan as it is; else
 * `ask` (window.prompt) with the names as A, B, …; a letter picks a name (a
 * letter outside the list asks again), a full name of the list picks it,
 * anything else is a new name for all of them — when that name is already
 * a net on the page, `confirm` must agree to merge it too (else ask again).
 * Null = cancelled (empty answer, Esc, three wrong answers).
 */
export function resolveMerge(
  plan: MergePlan,
  ask: (message: string, def: string) => string | null,
  opts: { exists?: (name: string) => boolean; confirm?: (message: string) => boolean } = {},
): { into: string; from: string[] } | null {
  if (!plan.confirm) return { into: plan.into, from: plan.from };
  const all = [plan.into, ...plan.from];
  const list = all.map((n, i) => `${String.fromCharCode(65 + i)}: ${n}`).join('\n');
  const base = `Łączysz sieci. Którą nazwę zachować?\n${list}\nWpisz literę albo nową nazwę:`;
  let msg = base;
  for (let tries = 0; tries < 3; tries++) {
    const c = ask(msg, 'A')?.trim();
    if (!c) return null;
    if (/^[A-Za-z]$/.test(c)) {
      const i = c.toUpperCase().charCodeAt(0) - 65;
      if (i < all.length) return { into: all[i]!, from: all.filter((n) => n !== all[i]) };
      msg = `Nie ma litery „${c}”.\n${base}`;
      continue;
    }
    if (
      !all.includes(c) &&
      opts.exists?.(c) &&
      !opts.confirm?.(`Net „${c}” już jest na stronie — scalić z nim także?`)
    ) {
      msg = base;
      continue;
    }
    return { into: c, from: all.filter((n) => n !== c) };
  }
  return null;
}

/** Snap / hover radius in scan px for `screenPx` screen pixels at `zoom`. */
export function snapRadius(zoom: number, screenPx = 10): number {
  return Math.max(3, Math.min(40, screenPx / zoom));
}
