// Run: npm test -w viewer (node --test --experimental-strip-types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZonesSync, parseZones, serializeZones, type ZonesSyncDeps } from './zonesSync.ts';
import { createSaveQueue } from './saveQueue.ts';
import { zonesFilePath } from './dataPaths.ts';
import type { VisionZone } from './store.ts';

const A = 'MJC-400/P-1/pages/2-1.zones.yaml';
const B = 'MJC-400/P-1/pages/2-2.zones.yaml';
const Z1: VisionZone = { role: 'gates', x: 1, y: 2, w: 30, h: 40 };
const Z2: VisionZone = { role: 'ports_left', x: 5, y: 6, w: 7, h: 8 };

interface Get {
  path: string;
  resolve: (status: number, text?: string) => void;
  reject: (e: Error) => void;
}

// UI stand-in: `shown` is what setZones last set; schedule records saves.
function harness(schedule?: (path: string, body: string) => void) {
  const gets: Get[] = [];
  const saves: Array<{ path: string; body: string }> = [];
  const errors: string[] = [];
  const ui = { shown: [] as VisionZone[] };
  const deps: ZonesSyncDeps = {
    fetch: (path) =>
      new Promise((res, rej) => {
        gets.push({
          path,
          resolve: (status, text = '') =>
            res({ ok: status >= 200 && status < 300, status, text: async () => text }),
          reject: rej,
        });
      }),
    schedule: schedule ?? ((path, body) => saves.push({ path, body })),
    apply: (z) => {
      ui.shown = z;
    },
    onLoadError: (path, e) => errors.push(`${path}: ${e}`),
  };
  const zs = createZonesSync(deps);
  // A render after a state change: Canvas's effect reports the zones shown.
  const render = (path: string | null) => zs.changed(path, ui.shown);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { zs, gets, saves, errors, ui, render, settle };
}

test('zonesFilePath: next to the page file', () => {
  assert.equal(zonesFilePath('MJC-400/P-1/pages/2-1.sch.yaml'), A);
  assert.equal(zonesFilePath('MJC-400/P-1/package.yaml'), null);
});

test('serializeZones/parseZones round-trip; empty keeps the old format', () => {
  assert.equal(serializeZones([]), 'zones: []\n');
  assert.deepEqual(parseZones(serializeZones([Z1, Z2])), [Z1, Z2]);
  assert.deepEqual(parseZones(''), []);
  assert.deepEqual(parseZones('other: 1\n'), []);
  assert.throws(() => parseZones('- a\n- b\n'));
});

test('opening a page: reset + loaded zones are never saved', async () => {
  const h = harness();
  h.zs.open(A);
  assert.equal(h.render(A), 'unchanged'); // reset to [] is not a user change
  assert.equal(h.zs.state(A), 'loading');
  h.gets[0]!.resolve(200, serializeZones([Z1]));
  await h.settle();
  assert.deepEqual(h.ui.shown, [Z1]);
  assert.equal(h.render(A), 'unchanged'); // loaded zones are not a user change
  assert.equal(h.zs.state(A), 'loaded');
  assert.deepEqual(h.saves, []);
  assert.deepEqual(h.gets.map((g) => g.path), [A]);
});

test('no save before the GET resolves, even for a user change (slow GET)', async () => {
  const h = harness();
  h.zs.open(A);
  h.render(A);
  // User draws a zone while the GET (> 500 ms) is still pending.
  h.ui.shown = [Z2];
  assert.equal(h.render(A), 'not-loaded');
  h.ui.shown = [];
  assert.equal(h.render(A), 'not-loaded'); // e.g. "wyczyść" before the load
  assert.deepEqual(h.saves, []);
  // The file's zones win: shown, still nothing saved.
  h.gets[0]!.resolve(200, serializeZones([Z1]));
  await h.settle();
  assert.deepEqual(h.ui.shown, [Z1]);
  h.render(A);
  assert.deepEqual(h.saves, []);
});

test('user change after load → one save of that page\'s zones file', async () => {
  const h = harness();
  h.zs.open(A);
  h.gets[0]!.resolve(200, serializeZones([Z1]));
  await h.settle();
  h.render(A);
  h.ui.shown = [...h.ui.shown, Z2];
  assert.equal(h.render(A), 'scheduled');
  assert.equal(h.render(A), 'unchanged'); // re-render, same array: no second save
  assert.deepEqual(h.saves, [{ path: A, body: serializeZones([Z1, Z2]) }]);
  // "wyczyść" is a user change: saved as an empty list.
  h.ui.shown = [];
  assert.equal(h.render(A), 'scheduled');
  assert.deepEqual(h.saves[1], { path: A, body: 'zones: []\n' });
});

test('404: nothing created on open; a user change creates the file', async () => {
  const h = harness();
  h.zs.open(A);
  h.render(A);
  h.gets[0]!.resolve(404);
  await h.settle();
  h.render(A);
  assert.equal(h.zs.state(A), 'loaded');
  assert.deepEqual(h.ui.shown, []);
  assert.deepEqual(h.saves, []);
  h.ui.shown = [Z1];
  assert.equal(h.render(A), 'scheduled');
  assert.deepEqual(h.saves, [{ path: A, body: serializeZones([Z1]) }]);
});

test('GET error or unparsable file: never saved (would overwrite unread zones)', async () => {
  for (const fail of [
    (g: Get) => g.resolve(500),
    (g: Get) => g.reject(new Error('network')),
    (g: Get) => g.resolve(200, '- not\n- a mapping\n'),
  ]) {
    const h = harness();
    h.zs.open(A);
    fail(h.gets[0]!);
    await h.settle();
    assert.equal(h.zs.state(A), 'error');
    assert.equal(h.errors.length, 1);
    h.ui.shown = [Z1];
    assert.equal(h.render(A), 'load-failed');
    assert.deepEqual(h.saves, []);
  }
});

test('navigation: a late GET of the previous page is ignored; paths never mix', async () => {
  const h = harness();
  h.zs.open(A);
  h.zs.open(B); // navigated before A's zones arrived
  h.render(B);
  h.gets[0]!.resolve(200, serializeZones([Z1])); // A's late answer
  await h.settle();
  assert.deepEqual(h.ui.shown, []); // not shown on B
  assert.equal(h.zs.state(B), 'loading');
  h.gets[1]!.resolve(200, serializeZones([Z2]));
  await h.settle();
  assert.deepEqual(h.ui.shown, [Z2]);
  h.ui.shown = [Z2, Z1];
  h.render(B);
  // A stale report for A (old effect) is not saved anywhere.
  assert.equal(h.zs.changed(A, [Z1]), 'not-loaded');
  assert.deepEqual(h.saves, [{ path: B, body: serializeZones([Z2, Z1]) }]);
});

test('onState: loading → loaded (Canvas unblocks zone editing only then)', async () => {
  const states: string[] = [];
  const h = harness();
  const zs = createZonesSync({
    fetch: (p) => new Promise((res) => h.gets.push({ path: p, resolve: (st, t = '') => res({ ok: st < 300, status: st, text: async () => t }), reject: () => {} })),
    schedule: () => {},
    apply: () => {},
    onState: (s, e) => states.push(e ? `${s}:${e}` : s),
  });
  zs.open(A);
  assert.deepEqual(states, ['loading']);
  h.gets[0]!.resolve(404);
  await h.settle();
  assert.deepEqual(states, ['loading', 'loaded']);
  zs.open(B);
  h.gets[1]!.resolve(500);
  await h.settle();
  assert.deepEqual(states.slice(2), ['loading', `error:GET ${B} → 500`]);
});

test('after a failed load, open() of the same path retries; success unblocks saves', async () => {
  const h = harness();
  h.zs.open(A);
  h.gets[0]!.resolve(500);
  await h.settle();
  assert.equal(h.zs.state(A), 'error');
  h.zs.open(A); // "ponów" / reopen
  assert.equal(h.gets.length, 2);
  assert.equal(h.zs.state(A), 'loading');
  h.gets[1]!.resolve(200, serializeZones([Z1]));
  await h.settle();
  assert.equal(h.zs.state(A), 'loaded');
  assert.deepEqual(h.ui.shown, [Z1]);
  h.ui.shown = [Z2];
  assert.equal(h.render(A), 'scheduled');
  assert.deepEqual(h.saves, [{ path: A, body: serializeZones([Z2]) }]);
});

test('open is idempotent for the same path (re-render / StrictMode)', async () => {
  const h = harness();
  h.zs.open(A);
  h.gets[0]!.resolve(200, serializeZones([Z1]));
  await h.settle();
  h.ui.shown = [Z1, Z2];
  h.render(A);
  h.zs.open(A);
  assert.equal(h.gets.length, 1);
  assert.deepEqual(h.ui.shown, [Z1, Z2]);
});

test('through the save queue: debounced, right path, If-Match from the load', async () => {
  const timers: Array<{ fn: () => void; live: boolean }> = [];
  const sent: Array<{ path: string; body: string; ifMatch: string | undefined }> = [];
  const q = createSaveQueue({
    async send(path, body, _o, ifMatch) {
      sent.push({ path, body, ifMatch });
      return '"t2"';
    },
    setTimer(fn) {
      const t = { fn, live: true };
      timers.push(t);
      return t;
    },
    clearTimer(t) {
      (t as { live: boolean }).live = false;
    },
    delayMs: 500,
  });
  const h = harness((p, b) => q.schedule(p, b));
  h.zs.open(A);
  h.render(A);
  // fetchDataFile records the ETag of the GET for the queue.
  q.setLoadedEtag(A, '"t1"', q.loadTicket(A));
  h.gets[0]!.resolve(200, serializeZones([Z1]));
  await h.settle();
  h.render(A);
  assert.equal(q.isDirty(), false); // opening left nothing to save
  h.ui.shown = [Z1, Z2];
  h.render(A);
  assert.equal(q.isDirty(), true); // beforeunload sees it
  assert.equal(sent.length, 0); // debounced
  await q.flush();
  assert.deepEqual(sent, [{ path: A, body: serializeZones([Z1, Z2]), ifMatch: '"t1"' }]);
  assert.equal(q.isDirty(), false);
});
