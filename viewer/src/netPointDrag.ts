// Drag session of one net point (NetLayer: segment-end handle, auto-junction
// dot). Pure — no React, no Konva, no store — so it is unit-tested
// (netPointDrag.test.ts). `preview` gets every change of the drag (render the
// net with withNetPointMoved; null = drag over); `commit` is called at most
// once per drag, only when the point ended somewhere else than it started
// (NetLayer: one editPage = one undo step).
import type { NetPoint } from './netOps.ts';

export interface PointDrag {
  net: string;
  from: NetPoint;
  to: NetPoint;
}

export interface PointDragSession {
  start(net: string, at: NetPoint): void;
  move(to: NetPoint): void;
  /**
   * Finish the drag at `to` (drag end), or at the last previewed point when
   * `to` is omitted (drag cut short, e.g. the tool left edit mode). No-op
   * when no drag is running, so a second end never commits twice.
   */
  end(to?: NetPoint): void;
  current(): PointDrag | null;
}

const same = (a: NetPoint, b: NetPoint): boolean => a.x === b.x && a.y === b.y;

export function createPointDragSession(opts: {
  preview: (d: PointDrag | null) => void;
  commit: (net: string, from: NetPoint, to: NetPoint) => void;
}): PointDragSession {
  let cur: PointDrag | null = null;
  return {
    start(net, at) {
      cur = { net, from: { ...at }, to: { ...at } };
      opts.preview(cur);
    },
    move(to) {
      if (!cur || same(to, cur.to)) return;
      cur = { ...cur, to: { ...to } };
      opts.preview(cur);
    },
    end(to) {
      const d = cur;
      if (!d) return;
      cur = null;
      opts.preview(null);
      const final = to ?? d.to;
      if (!same(final, d.from)) opts.commit(d.net, d.from, final);
    },
    current: () => cur,
  };
}
