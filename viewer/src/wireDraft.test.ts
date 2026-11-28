// Run: npm test -w viewer. W tool click sequence (wireDraft.ts) — mainly: a double click commits once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftClick, type Click, type Draft } from './wireDraft.ts';
import type { Pt, SnapTarget } from './wireEdit.ts';

const pinT = (x: number, y: number): SnapTarget => ({
  kind: 'endpoint',
  x,
  y,
  net: '',
  ep: { kind: 'pin', gateIdx: 0, pinIdx: 0 },
  labeled: false,
});

/** Feed mouse-ups like the canvas does; returns the commits and the final draft. */
function run(ups: Array<{ at: Pt; target?: SnapTarget; count?: number }>) {
  let d: Draft | null = null;
  let last: Pt | null = null;
  const commits: Array<{ pts: Pt[]; end: Pt; endT: SnapTarget | null }> = [];
  for (const u of ups) {
    const nearLast = !!last && Math.hypot(u.at.x - last.x, u.at.y - last.y) <= 4;
    last = u.at;
    const c: Click = {
      at: u.at,
      target: u.target ?? null,
      free: false,
      ortho: true,
      count: u.count ?? 1,
      nearLast,
    };
    const out = draftClick(d, c);
    if (out.kind === 'start' || out.kind === 'vertex') d = out.draft;
    else if (out.kind === 'cancel') d = null;
    else if (out.kind === 'commit') {
      commits.push({ pts: [out.draft.start, ...out.draft.vertices], end: out.end, endT: out.endT });
      d = null;
    }
  }
  return { commits, draft: d };
}

test('double click on empty canvas ends the wire once, as a free end at that point', () => {
  const r = run([
    { at: { x: 0, y: 0 } },
    { at: { x: 100, y: 3 } }, // vertex (ortho → 100,0)
    { at: { x: 100, y: 3 }, count: 2 }, // second mouse-up of the double click
    { at: { x: 100, y: 3 }, count: 3 }, // a stray third one: nothing
  ]);
  assert.deepEqual(r.commits, [{ pts: [{ x: 0, y: 0 }], end: { x: 100, y: 0 }, endT: null }]);
  assert.equal(r.draft, null);
});

test('two fast clicks at different points are two clicks (vertex, vertex), not a double click', () => {
  const r = run([
    { at: { x: 0, y: 0 } },
    { at: { x: 100, y: 0 } },
    { at: { x: 100, y: 80 }, count: 2 },
  ]);
  assert.equal(r.commits.length, 0);
  assert.deepEqual(r.draft?.vertices, [
    { x: 100, y: 0 },
    { x: 100, y: 80 },
  ]);
});

test('double click on a pin: the first click finishes on the pin, the second is ignored', () => {
  const r = run([
    { at: { x: 0, y: 0 } },
    { at: { x: 50, y: 0 }, target: pinT(50, 0) },
    { at: { x: 50, y: 0 }, target: pinT(50, 0), count: 2 },
  ]);
  assert.equal(r.commits.length, 1);
  assert.deepEqual(r.commits[0]!.endT, pinT(50, 0));
  assert.equal(r.draft, null);
});

test('double click right at the start cancels; the start target is kept in the draft', () => {
  const t = pinT(5, 5);
  const one = draftClick(null, {
    at: { x: 5, y: 5 },
    target: t,
    free: false,
    ortho: true,
    count: 1,
    nearLast: false,
  });
  assert.equal(one.kind, 'start');
  assert.deepEqual(one.kind === 'start' && one.draft.startT, t);
  const r = run([{ at: { x: 5, y: 5 } }, { at: { x: 5, y: 5 }, count: 2 }]);
  assert.equal(r.commits.length, 0);
  assert.equal(r.draft, null);
});
