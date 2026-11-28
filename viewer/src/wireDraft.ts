// W tool click sequence (kr-9p8.25), pure: what one mouse-up does to the
// wire being drawn. The canvas feeds every click here (mouse up without a
// drag); a double click is the second mouse-up with `count` ≥ 2 on the same
// spot — not Konva's dblclick, which fires before that mouse-up, without a
// distance check, and made the wire commit twice.
import { orthoFrom, type Pt, type SnapTarget } from './wireEdit.ts';

export interface Draft {
  start: Pt;
  /** where the start snapped — kept, not re-snapped at commit (a T on a skewed wire is off the integer grid) */
  startT: SnapTarget | null;
  vertices: Pt[];
}

export interface Click {
  /** snapped point (target's point, else the rounded pointer) */
  at: Pt;
  target: SnapTarget | null;
  /** Shift: no ortho, no routing */
  free: boolean;
  ortho: boolean;
  /** MouseEvent.detail of the mouse-up: 2 = second click of a double click */
  count: number;
  /** this mouse-up is within a few px of the previous one */
  nearLast: boolean;
}

export type ClickOutcome =
  | { kind: 'start'; draft: Draft }
  | { kind: 'vertex'; draft: Draft }
  | { kind: 'commit'; draft: Draft; end: Pt; endT: SnapTarget | null; route: boolean }
  | { kind: 'cancel' }
  | { kind: 'ignore' };

export const anchorOf = (d: Draft): Pt => d.vertices[d.vertices.length - 1] ?? d.start;

/**
 * No wire → start one. Click on a snap target → commit ending there. Click
 * on empty canvas → a vertex (ortho from the last point). Second click of a
 * double click on the same spot → the first click already added the vertex
 * (or started / finished the wire): commit with a free end at that vertex;
 * a wire with no vertex yet is cancelled; no wire (the first click finished
 * it) → ignored, so a double click never commits twice.
 */
export function draftClick(d: Draft | null, c: Click): ClickOutcome {
  if (c.count >= 2 && c.nearLast) {
    if (!d) return { kind: 'ignore' };
    const last = d.vertices[d.vertices.length - 1];
    if (!last) return { kind: 'cancel' };
    return {
      kind: 'commit',
      draft: { ...d, vertices: d.vertices.slice(0, -1) },
      end: last,
      endT: null,
      route: false,
    };
  }
  if (!d) return { kind: 'start', draft: { start: c.at, startT: c.target, vertices: [] } };
  if (c.target) return { kind: 'commit', draft: d, end: c.at, endT: c.target, route: !c.free };
  const a = anchorOf(d);
  const v = c.free || !c.ortho ? c.at : orthoFrom(a, c.at);
  if (v.x === a.x && v.y === a.y) return { kind: 'ignore' };
  return { kind: 'vertex', draft: { ...d, vertices: [...d.vertices, v] } };
}
