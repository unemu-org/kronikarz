// Run: npm test -w viewer (node --test --experimental-strip-types).
// The real store + save queue; fetch is stubbed and records every request.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Package, Page } from '@kronikarz/shared';
import {
  flushSaves,
  packageFilePath,
  pageFilePath,
  parsePackageFilePath,
  parsePageFilePath,
  scanFilePath,
  useDocStore,
} from './store.ts';
import { connectPins, renameNet } from './netOps.ts';

interface Req { method: string; url: string; body: string; ifMatch: string | null }
const reqs: Req[] = [];
let etagN = 0;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  reqs.push({
    method: init?.method ?? 'GET',
    url: String(url),
    body: typeof init?.body === 'string' ? init.body : '',
    ifMatch: headers.get('If-Match'),
  });
  return new Response('{"ok":true}', { status: 200, headers: { ETag: `"e${++etagN}"` } });
}) as typeof fetch;

const puts = () => reqs.filter((r) => r.method === 'PUT').map((r) => ({ url: r.url, body: r.body }));

function mkPage(id: string, pkg = 'P-1'): Page {
  return {
    kronikarz: '1',
    page: id,
    package: pkg,
    scan_size: [100, 100],
    gates: [],
    power: [],
    nets: {},
    annotations: [],
  };
}

const PATH_A = pageFilePath('P-1', '2-1');
const PATH_B = pageFilePath('P-1', '2-2');

beforeEach(async () => {
  await flushSaves().catch(() => {});
  reqs.length = 0;
  useDocStore.getState().setPage(null, null);
  useDocStore.getState().setPackage(null, null);
});

test('path helpers: page/package/scan addressed by file, not YAML fields', () => {
  assert.deepEqual(parsePageFilePath(PATH_A), { pkg: 'P-1', pageId: '2-1' });
  assert.equal(parsePageFilePath('MJC-400/P-1/package.yaml'), null);
  assert.equal(parsePageFilePath('MJC-400/P-1/pages/sub/2-1.sch.yaml'), null);
  assert.equal(parsePackageFilePath(packageFilePath('P-R3-2')), 'P-R3-2');
  assert.equal(parsePackageFilePath(PATH_A), null);
  assert.equal(scanFilePath(PATH_A), 'MJC-400/P-1/scans/2-1.jpg');
  assert.equal(scanFilePath('MJC-400/P-1/package.yaml'), null);
});

test('page save goes to the file it was loaded from, even if `page:` differs', async () => {
  const st = useDocStore.getState();
  // File 2-1.sch.yaml whose YAML says page: "2-7" (vision-page.py does not enforce it).
  st.setPage(mkPage('2-7'), PATH_A);
  assert.equal(useDocStore.getState().pagePath, PATH_A);
  useDocStore.getState().editPage((p) => { p.annotations.push({ text: 'x', x: 1, y: 1 } as never); });
  await flushSaves();
  assert.deepEqual(puts().map((p) => p.url), [`/files/${PATH_A}`]);
  assert.ok(puts()[0]!.body.includes('page: 2-7') || puts()[0]!.body.includes("page: '2-7'"));
  // undo/redo too
  useDocStore.getState().undo();
  useDocStore.getState().redo();
  await flushSaves();
  assert.deepEqual(puts().map((p) => p.url), [`/files/${PATH_A}`, `/files/${PATH_A}`]);
});

test('edit A, navigate to B (load in progress), edit again: all of A goes to A', async () => {
  useDocStore.getState().setPage(mkPage('2-1'), PATH_A);
  useDocStore.getState().editPage((p) => { p.scan_size = [1, 1]; });
  // Navigation: the route already points at B, B's GET is still running.
  useDocStore.getState().setRoute({ mode: 'page', pkg: 'P-1', page: '2-2' });
  useDocStore.getState().editPage((p) => { p.scan_size = [2, 2]; }); // still page A on screen
  // B lands (page + path together); its edits go to B.
  useDocStore.getState().setPage(mkPage('2-2'), PATH_B);
  useDocStore.getState().editPage((p) => { p.scan_size = [3, 3]; });
  await flushSaves();
  const got = puts();
  assert.deepEqual(got.map((p) => p.url).sort(), [`/files/${PATH_A}`, `/files/${PATH_B}`]);
  const a = got.find((p) => p.url === `/files/${PATH_A}`)!;
  const b = got.find((p) => p.url === `/files/${PATH_B}`)!;
  assert.match(a.body, /page: 2-1|page: '2-1'/);
  assert.match(a.body, /- 2\n\s*- 2|\[2, 2\]/);
  assert.match(b.body, /page: 2-2|page: '2-2'/);
});

test('route already on another package: edits of the page still shown go to its file', async () => {
  useDocStore.getState().setRoute({ mode: 'page', pkg: 'P-1', page: '2-1' });
  useDocStore.getState().setPage(mkPage('2-1'), PATH_A);
  useDocStore.getState().editPage((p) => { p.scan_size = [8, 8]; });
  // Navigated to another package; its load is still running, A is on screen.
  useDocStore.getState().setRoute({ mode: 'page', pkg: 'P-2', page: '2-5' });
  useDocStore.getState().editPage((p) => { p.scan_size = [9, 9]; });
  await flushSaves();
  assert.deepEqual(puts().map((p) => p.url), [`/files/${PATH_A}`]);
  assert.match(puts()[0]!.body, /- 9\n\s*- 9|\[9, 9\]/);
});

test('no page path → no save; setPage(null) clears the path', async () => {
  useDocStore.getState().setPage(mkPage('2-1'), PATH_A);
  useDocStore.getState().setPage(null, PATH_A);
  assert.equal(useDocStore.getState().pagePath, null);
  useDocStore.getState().editPage((p) => { p.scan_size = [5, 5]; });
  await flushSaves();
  assert.deepEqual(puts(), []);
});

test('package save goes to the package file it was loaded from', async () => {
  const pkg = { kronikarz: '1', package: { id: 'P-1', pages: [] } } as unknown as Package;
  useDocStore.getState().setPackage(pkg, packageFilePath('P-1'));
  useDocStore.getState().setRoute({ mode: 'package', pkg: 'P-9' });
  useDocStore.getState().editPackage(() => {});
  await flushSaves();
  assert.deepEqual(puts().map((p) => p.url), [`/files/${packageFilePath('P-1')}`]);
});

test('net ops through editPage: one undo step restores the page exactly', async () => {
  const pg = mkPage('2-1');
  pg.gates = [{
    ref: 'U1', gate: null, x: 0, y: 0, rotation: 0, verified: false, note: null,
    pins: [
      { num: 1, side: 'left', px: 0, py: 0, net: 'A' },
      { num: 2, side: 'left', px: 9, py: 0, net: 'B' },
    ],
  }];
  pg.nets = { A: { pins: [], segments: [[0, 0, 5, 0]], junctions: null }, B: { pins: [], segments: null, junctions: null } };
  useDocStore.getState().setPage(pg, PATH_A);
  const before = JSON.stringify(useDocStore.getState().page);
  useDocStore.getState().editPage((p) => { renameNet(p, 'A', 'B'); });
  assert.equal(useDocStore.getState().page!.gates[0]!.pins[0]!.net, 'B');
  useDocStore.getState().undo();
  assert.equal(JSON.stringify(useDocStore.getState().page), before);
  useDocStore.getState().editPage((p) => { connectPins(p, { gateIdx: 0, pinIdx: 0 }, { gateIdx: 0, pinIdx: 1 }, 'X'); });
  assert.equal(useDocStore.getState().page!.gates[0]!.pins[1]!.net, 'A');
  useDocStore.getState().undo();
  assert.equal(JSON.stringify(useDocStore.getState().page), before);
  await flushSaves();
});
