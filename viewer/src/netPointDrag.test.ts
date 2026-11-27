// Run: npm test -w viewer (node --test --experimental-strip-types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPointDragSession, type PointDrag } from './netPointDrag.ts';
import type { NetPoint } from './netOps.ts';

function mk() {
  const previews: Array<PointDrag | null> = [];
  const commits: Array<{ net: string; from: NetPoint; to: NetPoint }> = [];
  const s = createPointDragSession({
    preview: (d) => previews.push(d),
    commit: (net, from, to) => commits.push({ net, from, to }),
  });
  return { s, previews, commits };
}

test('point drag: many moves preview, one commit at the drag end', () => {
  const { s, previews, commits } = mk();
  s.start('A', { x: 10, y: 0 });
  for (let i = 1; i <= 50; i++) s.move({ x: 10 + i, y: 0 });
  s.move({ x: 60, y: 0 }); // unchanged → no extra preview
  assert.equal(commits.length, 0);
  assert.equal(previews.length, 51);
  s.end({ x: 61, y: 2 });
  assert.deepEqual(commits, [{ net: 'A', from: { x: 10, y: 0 }, to: { x: 61, y: 2 } }]);
  assert.equal(previews.at(-1), null);
  assert.equal(s.current(), null);
  s.end({ x: 99, y: 99 }); // second dragend (stopDrag + real one) → no second commit
  assert.equal(commits.length, 1);
});

test('point drag: ending where it started commits nothing (a click)', () => {
  const { s, commits, previews } = mk();
  s.start('A', { x: 5, y: 5 });
  s.move({ x: 8, y: 5 });
  s.end({ x: 5, y: 5 });
  assert.deepEqual(commits, []);
  assert.equal(previews.at(-1), null);
});

test('point drag cut short (tool left edit): end() commits the last preview, or just clears', () => {
  const a = mk();
  a.s.start('A', { x: 0, y: 0 });
  a.s.move({ x: 7, y: 3 });
  a.s.end();
  assert.deepEqual(a.commits, [{ net: 'A', from: { x: 0, y: 0 }, to: { x: 7, y: 3 } }]);
  assert.equal(a.previews.at(-1), null);

  const b = mk();
  b.s.start('A', { x: 0, y: 0 });
  b.s.end();
  assert.deepEqual(b.commits, []);
  assert.equal(b.previews.at(-1), null);

  const c = mk();
  c.s.end(); // no drag running
  assert.deepEqual(c.previews, []);
  assert.deepEqual(c.commits, []);
});
