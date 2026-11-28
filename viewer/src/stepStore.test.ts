// Run: npm test -w viewer. Etapowy viewer (kr-9p8.20) w store: krok bieżący,
// blokada narzędzi, zatwierdzanie przez editPage (stan kroku nie jest treścią).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage, type Page } from '@kronikarz/shared';
import { flushSaves, isLocked, lockReason, pageFilePath, useDocStore } from './store.ts';
import { approveStep, unapproveStep } from './stepView.ts';

const bodies: string[] = [];
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  if (init?.method === 'PUT' && typeof init.body === 'string') bodies.push(init.body);
  return new Response('{"ok":true}', { status: 200, headers: { ETag: '"e"' } });
}) as typeof fetch;

const PATH = pageFilePath('P-1', '2-1');
const OTHER = pageFilePath('P-1', '2-2');

function mkPage(steps: Page['steps']): Page {
  return {
    kronikarz: '1',
    page: '2-1',
    package: 'P-1',
    scan_size: [100, 100],
    ...(steps ? { steps } : {}),
    gates: [
      {
        ref: 'U1', gate: null, x: 10, y: 10, rotation: 0, verified: false, note: null, src: 'auto',
        pins: [{ num: 1, side: 'left', px: 0, py: 10, net: 'A', src: 'auto' }],
      },
    ],
    power: [],
    nets: { A: { pins: [], segments: [[0, 10, -10, 10]], junctions: null, auto_segments: [[0, 10, -10, 10]] } },
    annotations: [],
  } as Page;
}

const st = () => useDocStore.getState();

beforeEach(async () => {
  await flushSaves().catch(() => {});
  bodies.length = 0;
  st().setPage(null, null);
  st().setCurrentStep(null);
  st().setTool('select');
  for (const p of Object.keys(st().pageLocks)) st().setPageLock(p, null);
  st().setMulti(null);
});

test('setPage: strona bez steps → bez kroku; z krokiem do przeglądu → ten krok; ta sama ścieżka zostawia wybór', () => {
  st().setPage(mkPage(undefined), PATH);
  assert.equal(st().currentStep, null);
  st().setPage(mkPage({ gates: { status: 'approved' }, text: { status: 'auto' } }), OTHER);
  assert.equal(st().currentStep, 'text');
  st().setCurrentStep('wires');
  st().setPage(mkPage({ gates: { status: 'approved' }, text: { status: 'auto' } }), OTHER); // przeładowanie
  assert.equal(st().currentStep, 'wires');
});

test('setTool: narzędzie spoza kroku ignorowane; zmiana kroku cofa je do select', () => {
  st().setPage(mkPage({ wires: { status: 'auto' } }), PATH);
  st().setCurrentStep('wires');
  st().setTool('wire');
  assert.equal(st().tool, 'wire');
  st().setCurrentStep('gates');
  assert.equal(st().tool, 'select');
  st().setTool('wire');
  assert.equal(st().tool, 'select');
  st().setTool('zones');
  assert.equal(st().tool, 'select');
  st().setTool('edit');
  assert.equal(st().tool, 'edit');
  st().setCurrentStep(null);
  st().setTool('zones');
  assert.equal(st().tool, 'zones');
});

test('zatwierdzenie przez editPage: src auto zostaje, nic nie staje się stale, zapis ma status i verified', async () => {
  st().setPage(mkPage({ gates: { status: 'auto', run: 'R1' }, text: { status: 'approved' } }), PATH);
  st().editPage((p) => approveStep(p, 'gates', '2026-11-28T10:00:00Z'));
  const p = st().page!;
  assert.deepEqual(p.steps!.gates, { status: 'approved', run: 'R1', at: '2026-11-28T10:00:00Z' });
  assert.equal(p.steps!.text!.status, 'approved'); // nie stale: stan kroku i verified to nie treść
  assert.equal(p.gates[0]!.src, 'auto');
  assert.equal(p.gates[0]!.verified, true);
  assert.equal(p.gates[0]!.pins[0]!.src, 'auto');
  assert.deepEqual(p.nets.A!.auto_segments, [[0, 10, -10, 10]]);
  await flushSaves();
  const saved = parsePage(bodies.at(-1)!);
  assert.equal(saved.steps!.gates!.status, 'approved');
  assert.equal(saved.gates[0]!.verified, true);
  assert.equal(saved.gates[0]!.src, 'auto');
});

test('cofnięcie zatwierdzenia przez editPage: krok auto, późniejsze zatwierdzone stale, src bez zmian', () => {
  st().setPage(mkPage({ gates: { status: 'approved', run: 'R1' }, text: { status: 'approved' } }), PATH);
  st().editPage((p) => unapproveStep(p, 'gates', 'T'));
  const p = st().page!;
  assert.equal(p.steps!.gates!.status, 'auto');
  assert.equal(p.steps!.text!.status, 'stale');
  assert.equal(p.gates[0]!.src, 'auto');
});

test('pageLock: trwa krok — editPage / undo / redo tej strony nic nie robią i nie zapisują', async () => {
  st().setPage(mkPage({ gates: { status: 'auto' } }), PATH);
  st().editPage((p) => { p.gates[0]!.note = 'przed'; });
  await flushSaves();
  const n = bodies.length;
  st().setPageLock(PATH, 'trwa krok');
  assert.equal(isLocked(st()), true);
  st().editPage((p) => { p.gates[0]!.note = 'w trakcie'; });
  st().editPage((p) => approveStep(p, 'gates', 'T'));
  assert.equal(st().page!.gates[0]!.note, 'przed');
  assert.equal(st().page!.steps!.gates!.status, 'auto');
  st().undo();
  assert.equal(st().page!.gates[0]!.note, 'przed');
  await flushSaves();
  assert.equal(bodies.length, n);
  // blokada innej strony nie dotyczy otwartej
  st().setPageLock(PATH, null);
  st().setPageLock(OTHER, 'trwa krok');
  assert.equal(isLocked(st()), false);
  st().undo();
  assert.equal(st().page!.gates[0]!.note ?? null, null);
  st().redo();
  assert.equal(st().page!.gates[0]!.note, 'przed');
});

test('toggleMulti: Shift+klik tylko elementów edytowalnych w kroku', () => {
  st().setPage(mkPage({ wires: { status: 'auto' } }), PATH);
  st().setCurrentStep('wires');
  st().toggleMulti('gate', 0);
  assert.equal(st().multi, null);
  st().setCurrentStep('gates');
  st().toggleMulti('gate', 0);
  assert.deepEqual(st().multi, { kind: 'gate', indices: [0] });
  st().setCurrentStep('labels');
  st().toggleMulti('port', 0);
  assert.deepEqual(st().multi, { kind: 'port', indices: [0] });
});

test('pageLocks: blokada każdej strony osobno — zdjęcie blokady 2-2 nie zdejmuje blokady 2-1', () => {
  st().setPage(mkPage(undefined), PATH);
  st().setPageLock(PATH, 'trwa krok');
  st().setPageLock(OTHER, 'trwa krok');
  st().setPageLock(OTHER, null); // przebieg na drugiej stronie się skończył
  assert.equal(isLocked(st()), true);
  assert.equal(lockReason(st()), 'trwa krok');
  st().editPage((p) => { p.gates[0]!.note = 'x'; });
  assert.equal(st().page!.gates[0]!.note, null);
  st().setPageLock(PATH, null);
  assert.equal(isLocked(st()), false);
});

test('autoRuns: licznik przebiegów w karcie (nie spada poniżej 0)', () => {
  st().bumpAutoRuns(1);
  st().bumpAutoRuns(1);
  st().bumpAutoRuns(-1);
  assert.equal(st().autoRuns, 1);
  st().bumpAutoRuns(-1);
  st().bumpAutoRuns(-1);
  assert.equal(st().autoRuns, 0);
});

test('zmiana kroku czyści historię cofania', () => {
  st().setPage(mkPage({ gates: { status: 'auto' } }), PATH);
  st().editPage((p) => { p.gates[0]!.note = 'a'; });
  assert.equal(st().past.length, 1);
  st().undo();
  assert.equal(st().future.length, 1);
  st().editPage((p) => { p.gates[0]!.note = 'b'; });
  st().setCurrentStep('wires');
  assert.equal(st().past.length, 0);
  assert.equal(st().future.length, 0);
  st().undo();
  assert.equal(st().page!.gates[0]!.note, 'b');
});
