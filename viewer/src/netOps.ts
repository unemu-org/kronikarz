// Net operations on a page — the one place for the rules (pure, mutate the
// page passed in; call them inside `editPage` so one action = one undo step).
//
// Source of truth for connectivity: pin.net / port.net / cr.net / power.net.
// `page.nets[name]` holds only geometry (segments, junctions, cross); a net
// may legally exist through endpoint references alone, without an entry.
// `net.pins[]` is legacy/info-only: never read for connectivity and never
// written with endpoint ids here (merge keeps the ids already in the files).
import type { CrossPage, Net, Page } from '@kronikarz/shared';

export type EndpointRef =
  | { kind: 'pin'; gateIdx: number; pinIdx: number }
  | { kind: 'port'; idx: number }
  | { kind: 'cross_ref'; idx: number }
  | { kind: 'power'; idx: number };

export type NetOpError = 'empty-name' | 'no-endpoint' | 'no-net';
export type NetOpResult = { ok: true; merged?: boolean } | { ok: false; error: NetOpError };

// Trimmed name, or null when empty/whitespace (not a valid net name).
export function normalizeNetName(name: string | null | undefined): string | null {
  const t = (name ?? '').trim();
  return t ? t : null;
}

interface Holder { net: string }

function endpointHolder(page: Page, ep: EndpointRef): Holder | undefined {
  switch (ep.kind) {
    case 'pin': return page.gates[ep.gateIdx]?.pins[ep.pinIdx];
    case 'port': return page.ports?.[ep.idx];
    case 'cross_ref': return page.cross_refs?.[ep.idx];
    case 'power': return page.power?.[ep.idx];
  }
}

// Every endpoint whose `.net` is exactly `name`.
export function netEndpoints(page: Page, name: string): EndpointRef[] {
  const out: EndpointRef[] = [];
  page.gates.forEach((g, gateIdx) => g.pins.forEach((pin, pinIdx) => {
    if (pin.net === name) out.push({ kind: 'pin', gateIdx, pinIdx });
  }));
  (page.ports ?? []).forEach((x, idx) => { if (x.net === name) out.push({ kind: 'port', idx }); });
  (page.cross_refs ?? []).forEach((x, idx) => { if (x.net === name) out.push({ kind: 'cross_ref', idx }); });
  (page.power ?? []).forEach((x, idx) => { if (x.net === name) out.push({ kind: 'power', idx }); });
  return out;
}

export function netRefCount(page: Page, name: string): number {
  return netEndpoints(page, name).length;
}

function hasGeometry(net: Net | undefined): boolean {
  return !!net && ((net.segments?.length ?? 0) > 0 || (net.junctions?.length ?? 0) > 0 || !!net.cross);
}

// A net is live while anything references it or it still has geometry.
export function isNetLive(page: Page, name: string): boolean {
  return netRefCount(page, name) > 0 || hasGeometry(page.nets[name]);
}

// Exists = has an entry in page.nets or at least one endpoint reference.
export function netExists(page: Page, name: string): boolean {
  return !!page.nets[name] || netRefCount(page, name) > 0;
}

// Delete the page.nets entry only when the net is dead (no references, no
// segments/junctions/cross). Returns true when deleted.
export function pruneNetIfDead(page: Page, name: string): boolean {
  if (!(name in page.nets)) return false;
  if (isNetLive(page, name)) return false;
  delete page.nets[name];
  return true;
}

export function getEndpointNet(page: Page, ep: EndpointRef): string | undefined {
  return endpointHolder(page, ep)?.net;
}

// Put ONE endpoint on net `name`. Other endpoints of its old net are not
// touched; no nets entry is created (not needed — references suffice); the
// old net's entry is dropped only if it became dead.
export function assignEndpointNet(page: Page, ep: EndpointRef, name: string): NetOpResult {
  const v = normalizeNetName(name);
  if (!v) return { ok: false, error: 'empty-name' };
  const h = endpointHolder(page, ep);
  if (!h) return { ok: false, error: 'no-endpoint' };
  const old = h.net;
  if (old === v) return { ok: true };
  h.net = v;
  if (old) pruneNetIfDead(page, old);
  return { ok: true };
}

// Take ONE endpoint off its net (net = ''); the old net's entry is dropped
// only if it became dead.
export function disconnectEndpoint(page: Page, ep: EndpointRef): NetOpResult {
  const h = endpointHolder(page, ep);
  if (!h) return { ok: false, error: 'no-endpoint' };
  const old = h.net;
  if (!old) return { ok: true };
  h.net = '';
  pruneNetIfDead(page, old);
  return { ok: true };
}

// Renaming `from` → `into` merges two live nets: ask the user first. A dead
// target (no refs, no geometry — e.g. an empty leftover entry) merges silently.
export function renameNeedsConfirm(page: Page, from: string, into: string): boolean {
  const v = normalizeNetName(into);
  return !!v && v !== from && isNetLive(page, v);
}

// `cross` is a single object: on merge the target's wins. Returns the source's
// `cross` that a merge from → into would drop, or null.
export function mergeDropsCross(page: Page, from: string, into: string): CrossPage | null {
  const a = page.nets[from]?.cross;
  const b = page.nets[into]?.cross;
  return a && b ? a : null;
}

function mergeNetInto(target: Net, src: Net): void {
  if (src.segments?.length) target.segments = [...(target.segments ?? []), ...src.segments];
  if (src.junctions?.length) {
    const seen = new Set((target.junctions ?? []).map((j) => `${j[0]},${j[1]}`));
    const add = src.junctions.filter((j) => !seen.has(`${j[0]},${j[1]}`));
    target.junctions = [...(target.junctions ?? []), ...add];
  }
  if (!target.cross && src.cross) target.cross = src.cross;
  // Legacy info only: carry the source's ids over, never invent the field.
  if (src.pins?.length) target.pins = Array.from(new Set([...(target.pins ?? []), ...src.pins]));
}

// Rename a whole net: every endpoint reference old → new, and the nets entry
// (moved, or merged into an existing `new` entry). Works when `old` has no
// nets entry. `merged` = `new` already existed (entry or references).
export function renameNet(page: Page, oldName: string, newName: string): NetOpResult {
  const v = normalizeNetName(newName);
  if (!v) return { ok: false, error: 'empty-name' };
  // An empty old name means "unconnected", not a net: never rewrite those.
  if (!normalizeNetName(oldName)) return { ok: false, error: 'no-net' };
  if (v === oldName) return { ok: true, merged: false };
  if (!netExists(page, oldName)) return { ok: false, error: 'no-net' };
  const merged = netExists(page, v);
  for (const ep of netEndpoints(page, oldName)) endpointHolder(page, ep)!.net = v;
  const src = page.nets[oldName];
  if (src) {
    const dst = page.nets[v];
    if (dst) mergeNetInto(dst, src);
    else page.nets[v] = src;
    delete page.nets[oldName];
  }
  return { ok: true, merged };
}

// `base`, or `base_2`, `base_3`, … — first name not yet used on the page.
export function uniqueNetName(page: Page, base: string): string {
  if (!netExists(page, base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base}_${i}`;
    if (!netExists(page, n)) return n;
  }
}

export type ConnectPlan =
  | { status: 'join'; net: string } // b (and/or a) just joins `net`
  | { status: 'merge'; from: string; into: string } // b's net is live elsewhere
  | { status: 'noop'; net: string } // already on the same net
  | { status: 'missing' };

// What a pin-to-pin connect a → b would do; no mutation.
// Net = a's, else b's, else `fallbackName` (made unique). When b is on another
// net that is still live without b (other references or geometry), the
// connect is a merge b's net → a's net, which the UI must confirm.
export function planConnect(
  page: Page,
  a: { gateIdx: number; pinIdx: number },
  b: { gateIdx: number; pinIdx: number },
  fallbackName: string,
): ConnectPlan {
  const pa = page.gates[a.gateIdx]?.pins[a.pinIdx];
  const pb = page.gates[b.gateIdx]?.pins[b.pinIdx];
  if (!pa || !pb) return { status: 'missing' };
  const na = normalizeNetName(pa.net);
  const nb = normalizeNetName(pb.net);
  if (na && na === nb) return { status: 'noop', net: na };
  if (na && nb) {
    const othersOnB = netRefCount(page, nb) - 1; // b itself references nb
    if (othersOnB > 0 || hasGeometry(page.nets[nb])) return { status: 'merge', from: nb, into: na };
  }
  return { status: 'join', net: na ?? nb ?? uniqueNetName(page, fallbackName) };
}

// Pin-to-pin connect (edit tool): both pins on one net + a segment a → b.
// A 'merge' plan is applied only with `allowMerge` (renameNet b's net → a's);
// otherwise nothing changes. 'noop' adds no duplicate segment.
export function connectPins(
  page: Page,
  a: { gateIdx: number; pinIdx: number },
  b: { gateIdx: number; pinIdx: number },
  fallbackName: string,
  opts: { allowMerge?: boolean } = {},
): ConnectPlan & { applied: boolean } {
  const plan = planConnect(page, a, b, fallbackName);
  if (plan.status === 'missing' || plan.status === 'noop') return { ...plan, applied: false };
  if (plan.status === 'merge' && !opts.allowMerge) return { ...plan, applied: false };
  const pa = page.gates[a.gateIdx]!.pins[a.pinIdx]!;
  const pb = page.gates[b.gateIdx]!.pins[b.pinIdx]!;
  let name: string;
  if (plan.status === 'merge') {
    renameNet(page, plan.from, plan.into);
    name = plan.into;
  } else {
    name = plan.net;
    const olds = [pa.net, pb.net];
    pa.net = name;
    pb.net = name;
    for (const old of olds) if (old && old !== name) pruneNetIfDead(page, old);
  }
  const rec = (page.nets[name] ??= { pins: [], segments: null, junctions: null });
  rec.segments = [...(rec.segments ?? []), [pa.px, pa.py, pb.px, pb.py]];
  return { ...plan, applied: true };
}

// Dragging one point of a net's geometry (NetLayer: segment-end handle,
// auto-junction dot): every segment end and junction of the net at `from`
// moves to `to`, so a junction moves as one piece. While the mouse moves the
// drag is only previewed (withNetPointMoved at render time: the page is not
// touched — no undo entry, no auto-save, no validation); the drag end
// commits it once with moveNetPoint inside editPage = one undo step.
export interface NetPoint {
  x: number;
  y: number;
}

/** Move every segment end / junction of `net` at `from` to `to` (in place). */
export function moveNetPoint(net: Net, from: NetPoint, to: NetPoint): void {
  for (const s of net.segments ?? []) {
    if (s[0] === from.x && s[1] === from.y) { s[0] = to.x; s[1] = to.y; }
    if (s[2] === from.x && s[3] === from.y) { s[2] = to.x; s[3] = to.y; }
  }
  for (const j of net.junctions ?? []) {
    if (j[0] === from.x && j[1] === from.y) { j[0] = to.x; j[1] = to.y; }
  }
}

/** Copy of `net` with moveNetPoint applied; `net` is not changed (drag preview). */
export function withNetPointMoved(net: Net, from: NetPoint, to: NetPoint): Net {
  const copy: Net = {
    ...net,
    segments: net.segments ? net.segments.map((s) => [...s] as [number, number, number, number]) : null,
    junctions: net.junctions ? net.junctions.map((j) => [...j] as [number, number]) : null,
  };
  moveNetPoint(copy, from, to);
  return copy;
}
