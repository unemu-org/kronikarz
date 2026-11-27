// Run: npm test -w viewer. Format v1.2: każda edycja przez editPage jest ludzka —
// zmienione elementy `src: auto` tracą pole, późniejsze zatwierdzone kroki → stale.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage, type Page } from '@kronikarz/shared';
import { flushSaves, pageFilePath, useDocStore } from './store.ts';
import { renameNet, assignEndpointNet } from './netOps.ts';

const bodies: string[] = [];
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  if (init?.method === 'PUT' && typeof init.body === 'string') bodies.push(init.body);
  return new Response('{"ok":true}', { status: 200, headers: { ETag: '"e"' } });
}) as typeof fetch;

const PATH = pageFilePath('P-1', '2-1');

function mkPage(): Page {
  return {
    kronikarz: '1',
    page: '2-1',
    package: 'P-1',
    scan_size: [100, 100],
    steps: {
      gates: { status: 'approved' },
      text: { status: 'approved' },
      wires: { status: 'approved' },
      labels: { status: 'auto' },
    },
    gates: [
      {
        ref: 'U1',
        gate: null,
        x: 10,
        y: 10,
        rotation: 0,
        verified: false,
        note: null,
        src: 'auto',
        text_src: 'auto',
        pins: [
          { num: 1, side: 'left', px: 0, py: 10, net: 'A', src: 'auto', net_src: 'auto' },
          { num: 2, side: 'right', px: 20, py: 10, net: 'B', src: 'auto', net_src: 'auto' },
        ],
      },
    ],
    power: [],
    ports: [
      {
        connector: 'A',
        pin: 1,
        label: 'X',
        net: 'B',
        x: 50,
        y: 10,
        side: 'right',
        src: 'auto',
        net_src: 'auto',
      },
    ],
    nets: {
      A: {
        pins: [],
        segments: [[0, 10, -10, 10]],
        junctions: null,
        auto_segments: [[0, 10, -10, 10]],
      },
      B: {
        pins: [],
        segments: [[20, 10, 50, 10]],
        junctions: null,
        auto_segments: [[20, 10, 50, 10]],
      },
    },
    annotations: [],
  };
}

const page = () => useDocStore.getState().page!;
const edit = (fn: (p: Page) => void) => useDocStore.getState().editPage(fn);

beforeEach(async () => {
  await flushSaves().catch(() => {});
  bodies.length = 0;
  useDocStore.getState().setPage(mkPage(), PATH);
});

test('editPage: przesunięcie bramki → box edited, późniejsze approved stale; zapis bez src gdzie edited', async () => {
  edit((p) => {
    const g = p.gates[0]!;
    g.x += 5;
    for (const pin of g.pins) pin.px += 5;
  });
  const g = page().gates[0]!;
  assert.equal('src' in g, false);
  assert.equal(g.text_src, 'auto');
  assert.equal(g.pins[0]!.src, 'auto');
  assert.equal(page().steps!.gates!.status, 'approved');
  assert.equal(page().steps!.text!.status, 'stale');
  assert.equal(page().steps!.wires!.status, 'stale');
  assert.match(page().steps!.text!.at ?? '', /^\d{4}-\d\d-\d\dT/);
  assert.equal(page().steps!.labels!.status, 'auto');
  await flushSaves();
  const saved = parsePage(bodies.at(-1)!);
  assert.deepEqual(saved, page());
  // undo przywraca auto i stan kroków
  useDocStore.getState().undo();
  assert.equal(page().gates[0]!.src, 'auto');
  assert.equal(page().steps!.text!.status, 'approved');
  await flushSaves();
});

test('editPage: tekst / pin / port / net endpointu', () => {
  edit((p) => {
    p.gates[0]!.ref = 'U2';
  });
  assert.equal('text_src' in page().gates[0]!, false);
  assert.equal(page().gates[0]!.src, 'auto');
  assert.equal(page().steps!.wires!.status, 'stale');
  edit((p) => {
    p.ports![0]!.label = 'Y';
  });
  assert.equal('src' in page().ports![0]!, false);
  assert.equal(page().ports![0]!.net_src, 'auto');
  edit((p) => {
    assignEndpointNet(p, { kind: 'pin', gateIdx: 0, pinIdx: 0 }, 'C');
  });
  const pin = page().gates[0]!.pins[0]!;
  assert.equal(pin.net, 'C');
  assert.equal('net_src' in pin, false);
  assert.equal(pin.src, 'auto');
});

test('editPage: renameNet (krok nets) nie zdejmuje auto z drutów; zmiana odcinka zdejmuje', () => {
  edit((p) => {
    renameNet(p, 'A', 'B');
  });
  const b = page().nets.B!;
  assert.equal(b.segments!.length, 2);
  assert.equal(b.auto_segments!.length, 2);
  assert.equal(page().steps!.wires!.status, 'approved'); // nets to ostatni krok
  edit((p) => {
    p.nets.B!.segments![0]![2] = 60;
  });
  assert.equal(page().nets.B!.auto_segments!.length, 1);
});

test('editPage: strona v1.1 (bez src/steps) — zapis bajt w bajt bez nowych pól', async () => {
  const p = mkPage();
  delete p.steps;
  delete p.ports;
  p.gates = [];
  p.nets = {};
  useDocStore.getState().setPage(p, PATH);
  edit((q) => {
    q.scan_size = [7, 7];
  });
  await flushSaves();
  const body = bodies.at(-1)!;
  assert.doesNotMatch(body, /src|steps|auto_/);
});
