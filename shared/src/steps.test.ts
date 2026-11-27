import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage, serializePage } from './parse.ts';
import {
  STEP_ORDER,
  applyHumanEdit,
  aspectEmpty,
  autoJunctionMask,
  autoSegmentMask,
  canRun,
  changedSteps,
  elementSrc,
  markEdited,
  markStaleAfter,
  nextRunnableStep,
  stepStatus,
} from './steps.ts';
import { validatePage } from './validate.ts';
import type { Page } from './types.ts';

// Własny fixture (nie z data/): dwie bramki, port, odsyłacz, zasilanie, net z drutami.
const FIXTURE = `kronikarz: "1"
page: "2-1"
package: P-T
scan_size: [1000, 800]
steps:
  gates: { status: approved, run: r1, at: "2026-11-27T10:00:00Z" }
  text: { status: approved, run: r2 }
  wires: { status: approved }
  labels: { status: auto, run: r4 }
gates:
  - ref: M1
    gate: A
    x: 100
    y: 100
    rotation: 0
    src: auto
    text_src: auto
    pins:
      - { num: 1, side: left, net: N1, px: 70, py: 90, src: auto, net_src: auto }
      - { num: 3, side: right, net: N2, px: 130, py: 100, src: auto, net_src: auto }
    verified: false
    note: null
  - ref: M2
    gate: B
    x: 300
    y: 100
    rotation: 0
    src: auto
    text_src: auto
    pins:
      - { num: 4, side: left, net: N2, px: 270, py: 100, src: auto, net_src: auto }
    verified: false
    note: null
power:
  - { type: VCC, x: 50, y: 20, net: VCC, src: auto, net_src: auto }
ports:
  - { connector: A, pin: 50, label: "-BLR", net: N1, x: 10, y: 90, side: left, src: auto, net_src: auto }
cross_refs:
  - { net: N2, label: "-X", pages: ["2"], x: 900, y: 100, side: right, src: auto, net_src: auto }
nets:
  N1:
    pins: []
    segments:
      - [10, 90, 70, 90]
    junctions: null
    auto_segments:
      - [10, 90, 70, 90]
  N2:
    pins: []
    segments:
      - [130, 100, 200, 100]
      - [200, 100, 270, 100]
      - [200, 100, 200, 150]
    junctions:
      - [200, 100]
    auto_segments:
      - [130, 100, 200, 100]
      - [200, 100, 270, 100]
    auto_junctions:
      - [200, 100]
annotations: []
`;

const load = (): Page => parsePage(FIXTURE, 'fixture');
const clone = (p: Page): Page => JSON.parse(JSON.stringify(p));
function edit(page: Page, fn: (p: Page) => void) {
  const next = clone(page);
  fn(next);
  const res = applyHumanEdit(page, next);
  return { next, ...res };
}

test('stepStatus: brak sekcji / kroku / zła wartość = todo', () => {
  const p = load();
  assert.deepEqual([...STEP_ORDER], ['gates', 'text', 'wires', 'labels', 'nets']);
  assert.equal(stepStatus(p, 'gates'), 'approved');
  assert.equal(stepStatus(p, 'labels'), 'auto');
  assert.equal(stepStatus(p, 'nets'), 'todo');
  assert.equal(stepStatus({}, 'gates'), 'todo');
  assert.equal(stepStatus({ steps: { gates: { status: 'bogus' as never } } }, 'gates'), 'todo');
});

test('elementSrc / markEdited: brak pola = edited, markEdited usuwa pole', () => {
  const p = load();
  const g = p.gates[0]!;
  assert.equal(elementSrc(g), 'auto');
  assert.equal(elementSrc(g, 'text_src'), 'auto');
  assert.equal(elementSrc({}), 'edited');
  assert.equal(elementSrc({ src: 'edited' }), 'edited');
  assert.equal(markEdited(g, 'src'), true);
  assert.equal('src' in g, false);
  assert.equal(g.text_src, 'auto');
  assert.equal(markEdited(g, 'src'), false);
  assert.equal(markEdited(g), true);
  assert.equal('text_src' in g, false);
  const e: Record<string, unknown> = { src: 'edited' };
  assert.equal(markEdited(e), false); // już edited, ale pole i tak znika
  assert.deepEqual(e, {});
});

test('markStaleAfter: tylko późniejsze approved → stale, sam krok bez zmian', () => {
  const p = load();
  assert.deepEqual(markStaleAfter(p, 'gates', 'T'), ['text', 'wires']);
  assert.equal(p.steps!.gates!.status, 'approved');
  assert.deepEqual(p.steps!.text, { status: 'stale', run: 'r2', at: 'T' });
  assert.equal(p.steps!.labels!.status, 'auto');
  assert.deepEqual(markStaleAfter(p, 'gates'), []);
  assert.deepEqual(markStaleAfter({ ...p, steps: undefined }, 'gates'), []);
});

test('canRun: poprzedni approved, approved tylko z force, draft bez poprzednika', () => {
  const p = load();
  assert.deepEqual(canRun({}, 'gates'), { ok: true });
  assert.equal(canRun({}, 'text').ok, false);
  assert.equal(canRun({}, 'text', { draft: true }).ok, true);
  assert.equal(canRun(p, 'gates').ok, false);
  assert.equal(canRun(p, 'gates', { force: true }).ok, true);
  assert.equal(canRun(p, 'labels').ok, true); // wires approved, labels auto
  assert.equal(canRun(p, 'nets').ok, false); // labels tylko auto
  p.steps!.wires!.status = 'stale';
  assert.equal(canRun(p, 'labels').ok, false);
  assert.equal(canRun(p, 'nope' as never).ok, false);
});

test('nextRunnableStep', () => {
  const p = load();
  assert.equal(nextRunnableStep({}), 'gates');
  assert.equal(nextRunnableStep(p), 'labels');
  p.steps!.labels!.status = 'approved';
  assert.equal(nextRunnableStep(p), 'nets');
  p.steps!.nets = { status: 'approved' };
  assert.equal(nextRunnableStep(p), null);
  p.steps!.text!.status = 'stale';
  assert.equal(nextRunnableStep(p), 'text');
});

test('parse → serialize → parse: src, steps, auto_* bez strat', () => {
  const p = load();
  const text = serializePage(p);
  assert.deepEqual(parsePage(text), p);
  assert.match(text, /^steps:\n {2}gates:\n {4}status: approved\n {4}run: r1\n/m);
  assert.match(text, /text_src: auto/);
  assert.match(text, /net_src: auto/);
  assert.match(text, /auto_junctions:/);
  assert.deepEqual(autoSegmentMask(p.nets.N2!), [true, true, false]);
  // Kierunek odcinka bez znaczenia; krotność się liczy.
  assert.deepEqual(
    autoSegmentMask({
      pins: [],
      segments: [
        [1, 2, 3, 4],
        [1, 2, 3, 4],
        [5, 5, 6, 6],
      ],
      junctions: null,
      auto_segments: [
        [3, 4, 1, 2],
        [9, 9, 9, 9],
      ],
    }),
    [true, false, false],
  );
});

test('applyHumanEdit: kopia bez zmian = nic nie zmienia', () => {
  const p = load();
  const { next, stale } = edit(p, () => {});
  assert.deepEqual(next, p);
  assert.deepEqual(stale, []);
  // verified / note to nie treść kroku
  const r = edit(p, (q) => {
    q.gates[0]!.verified = true;
    q.gates[0]!.note = 'ok';
  });
  assert.deepEqual(r.stale, []);
  assert.equal(r.next.gates[0]!.src, 'auto');
});

test('applyHumanEdit: przesunięcie bramki — box edited, tekst i piny auto, późniejsze approved stale', () => {
  const p = load();
  const { next, stale } = edit(p, (q) => {
    const g = q.gates[0]!;
    g.x += 5;
    for (const pin of g.pins) pin.px += 5;
  });
  const g = next.gates[0]!;
  assert.equal(elementSrc(g), 'edited');
  assert.equal(g.text_src, 'auto');
  assert.deepEqual(
    g.pins.map((x) => [x.src, x.net_src]),
    [
      ['auto', 'auto'],
      ['auto', 'auto'],
    ],
  );
  assert.equal(next.gates[1]!.src, 'auto');
  assert.deepEqual(stale, ['text', 'wires']);
  assert.equal(next.steps!.gates!.status, 'approved');
  assert.equal(next.steps!.labels!.status, 'auto');
});

test('applyHumanEdit: tekst bramki, pin, net pinu', () => {
  const p = load();
  let r = edit(p, (q) => {
    q.gates[0]!.ref = 'M9';
  });
  assert.equal(r.next.gates[0]!.src, 'auto');
  assert.equal('text_src' in r.next.gates[0]!, false);
  assert.deepEqual(r.stale, ['wires']); // text zmieniony → późniejsze approved
  r = edit(p, (q) => {
    q.gates[0]!.pins[1]!.net = 'N7';
  });
  const pin = r.next.gates[0]!.pins[1]!;
  assert.equal(pin.src, 'auto');
  assert.equal('net_src' in pin, false);
  assert.deepEqual(r.stale, []); // nets to ostatni krok
  r = edit(p, (q) => {
    q.gates[0]!.pins[0]!.side = 'top';
  });
  assert.equal('src' in r.next.gates[0]!.pins[0]!, false);
  assert.equal(r.next.gates[0]!.pins[0]!.net_src, 'auto');
  assert.equal(r.next.gates[0]!.pins[1]!.src, 'auto');
});

test('applyHumanEdit: usunięcie bramki nie zdejmuje auto z pozostałych; dodana = edited', () => {
  const p = load();
  const r = edit(p, (q) => {
    q.gates.splice(0, 1);
  });
  assert.equal(r.next.gates[0]!.ref, 'M2');
  assert.equal(r.next.gates[0]!.src, 'auto');
  assert.equal(r.next.gates[0]!.pins[0]!.src, 'auto');
  assert.deepEqual(r.stale, ['text', 'wires']);
  // Duplikat bramki auto (np. kopiuj/wklej) jest dziełem człowieka.
  const d = edit(p, (q) => {
    q.gates.push(clone(q).gates[1]!);
  });
  assert.equal(d.next.gates[1]!.src, 'auto');
  assert.equal('src' in d.next.gates[2]!, false);
  assert.equal('text_src' in d.next.gates[2]!, false);
  assert.equal('src' in d.next.gates[2]!.pins[0]!, false);
});

test('applyHumanEdit: port / cross_ref / power', () => {
  const p = load();
  const r = edit(p, (q) => {
    q.ports![0]!.label = '-BLX';
    q.cross_refs![0]!.net = 'N9';
    q.power[0]!.x = 60;
  });
  assert.equal('src' in r.next.ports![0]!, false);
  assert.equal(r.next.ports![0]!.net_src, 'auto');
  assert.equal(r.next.cross_refs![0]!.src, 'auto');
  assert.equal('net_src' in r.next.cross_refs![0]!, false);
  assert.equal('src' in r.next.power[0]!, false);
  assert.equal(r.next.power[0]!.net_src, 'auto');
  assert.deepEqual(r.stale, []); // labels nie jest approved, nets todo
});

test('applyHumanEdit: druty — przesunięty odcinek edited, reszta auto, przeniesienie do innego netu zostaje auto', () => {
  const p = load();
  let r = edit(p, (q) => {
    q.nets.N2!.segments![1]![2] = 280;
  });
  assert.deepEqual(r.next.nets.N2!.auto_segments, [[130, 100, 200, 100]]);
  assert.deepEqual(r.next.nets.N2!.auto_junctions, [[200, 100]]);
  assert.deepEqual(r.next.nets.N1!.auto_segments, [[10, 90, 70, 90]]);
  assert.deepEqual(r.stale, []); // labels auto, nets todo
  // Scalenie N1 do N2 (krok nets): geometria bez zmian → nadal auto, bez sieroty w N1.
  r = edit(p, (q) => {
    q.nets.N2!.segments!.push(...q.nets.N1!.segments!);
    delete q.nets.N1;
  });
  assert.deepEqual(autoSegmentMask(r.next.nets.N2!), [true, true, false, true]);
  // Usunięcie odcinka: wpis auto znika, net bez auto bez pola.
  r = edit(p, (q) => {
    q.nets.N1!.segments = [];
  });
  assert.equal('auto_segments' in r.next.nets.N1!, false);
  // Zmiana drutu przy zatwierdzonym labels → labels stale.
  const p2 = load();
  p2.steps!.labels!.status = 'approved';
  r = edit(p2, (q) => {
    q.nets.N2!.junctions = [];
  });
  assert.deepEqual(r.stale, ['labels']);
  assert.equal('auto_junctions' in r.next.nets.N2!, false);
});

test('applyHumanEdit: strona bez src/steps (dane v1.1) — bez zmian', () => {
  const p = load();
  delete p.steps;
  for (const g of p.gates) {
    markEdited(g);
    g.pins.forEach((x) => markEdited(x));
  }
  for (const e of [...p.ports!, ...p.cross_refs!, ...p.power]) markEdited(e);
  for (const n of Object.values(p.nets)) {
    delete n.auto_segments;
    delete n.auto_junctions;
  }
  const r = edit(p, (q) => {
    q.gates[0]!.x = 1;
    q.nets.N2!.segments!.pop();
  });
  assert.deepEqual(r.stale, []);
  assert.equal(r.next.steps, undefined);
  assert.equal('src' in r.next.gates[0]!, false);
  assert.deepEqual(changedSteps(p, r.next), ['gates', 'text', 'wires', 'nets']);
});

test('validatePage: STEP_INVALID / SRC_INVALID tylko jako warn', () => {
  const ok = validatePage(load());
  assert.equal(
    ok.some((i) => i.code === 'STEP_INVALID' || i.code === 'SRC_INVALID'),
    false,
  );
  const p = load();
  (p.steps as Record<string, unknown>).foo = { status: 'auto' };
  (p.steps!.text as { status: string }).status = 'done';
  (p.gates[0] as unknown as Record<string, unknown>).src = 'human';
  const issues = validatePage(p).filter(
    (i) => i.code === 'STEP_INVALID' || i.code === 'SRC_INVALID',
  );
  assert.deepEqual(
    issues.map((i) => [i.level, i.code, i.ref]),
    [
      ['warn', 'STEP_INVALID', 'text'],
      ['warn', 'STEP_INVALID', 'foo'],
      ['warn', 'SRC_INVALID', undefined],
    ],
  );
});

test('applyHumanEdit: element auto wklejony na stronę bez auto = edited', () => {
  const src = load();
  const dst = load();
  dst.gates = [];
  dst.ports = [];
  dst.cross_refs = [];
  dst.power = [];
  dst.nets = {};
  delete dst.steps;
  const r = edit(dst, (q) => {
    q.gates.push(clone(src).gates[0]!);
    q.ports!.push(clone(src).ports![0]!);
    q.nets.N1 = clone(src).nets.N1!;
  });
  assert.equal('src' in r.next.gates[0]!, false);
  assert.equal('text_src' in r.next.gates[0]!, false);
  assert.equal('net_src' in r.next.gates[0]!.pins[0]!, false);
  assert.equal('src' in r.next.ports![0]!, false);
  assert.equal('auto_segments' in r.next.nets.N1!, false);
});

// --- poprawki po review: parowanie przy wielu elementach z tym samym kluczem ---

const blankPage = (extra: Partial<Page> = {}): Page => ({
  kronikarz: '1',
  page: 'x',
  package: 'P-T',
  scan_size: [1000, 800],
  gates: [],
  power: [],
  ports: [],
  cross_refs: [],
  nets: {},
  annotations: [],
  ...extra,
});
// Bramka z kroku ①: sama ramka, tekst pusty (ten sam klucz tekstu u wszystkich).
const boxGate = (i: number) => ({
  ref: '',
  gate: null,
  x: 100 * i,
  y: 50,
  rotation: 0 as const,
  pins: [],
  verified: false,
  note: null,
  src: 'auto' as const,
  text_src: 'auto' as const,
});
const srcs = (els: object[]) =>
  els.map((e) => {
    const o = e as Record<string, unknown>;
    return `${o.src ?? '-'}/${o.text_src ?? o.net_src ?? '-'}`;
  });

test('pairUp: usunięcie środkowej bramki z pustym tekstem nie zdejmuje auto z sąsiadów', () => {
  const p = blankPage({ gates: [0, 1, 2, 3, 4].map(boxGate) });
  const r = edit(p, (q) => {
    q.gates.splice(1, 1);
  });
  assert.deepEqual(
    r.next.gates.map((g) => g.x),
    [0, 200, 300, 400],
  );
  assert.deepEqual(srcs(r.next.gates), Array(4).fill('auto/auto'));
});

test('pairUp: nowa bramka wstawiona na początek — stare zostają auto, nowa edited', () => {
  const p = blankPage({ gates: [0, 1, 2].map(boxGate) });
  const r = edit(p, (q) => {
    q.gates.unshift({
      ref: '',
      gate: null,
      x: 999,
      y: 9,
      rotation: 0,
      pins: [],
      verified: false,
      note: null,
    });
  });
  assert.deepEqual(srcs(r.next.gates), ['-/-', 'auto/auto', 'auto/auto', 'auto/auto']);
});

test('pairUp: usunięcie portu 0 przy wspólnym necie "" nie zdejmuje auto z innych', () => {
  const port = (i: number) => ({
    connector: 'A',
    pin: 10 + i,
    label: 'L' + i,
    net: '',
    x: 10,
    y: 100 * i,
    side: 'left' as const,
    src: 'auto' as const,
    net_src: 'auto' as const,
  });
  const p = blankPage({ ports: [0, 1, 2].map(port) });
  const r = edit(p, (q) => {
    q.ports!.splice(0, 1);
  });
  assert.deepEqual(srcs(r.next.ports!), ['auto/auto', 'auto/auto']);
});

test('pairUp: ramka przesunięta na miejsce innej (identyczny box) — edited tylko ona', () => {
  const p = blankPage({ gates: [0, 1, 2].map(boxGate) });
  const r = edit(p, (q) => {
    q.gates[1]!.x = 200; // = box bramki 2
  });
  assert.deepEqual(srcs(r.next.gates), ['auto/auto', '-/auto', 'auto/auto']);
});

test('pin: poprawiony numer zdejmuje auto tylko z src, net_src zostaje', () => {
  const p = load();
  const r = edit(p, (q) => {
    q.gates[0]!.pins[1]!.num = 7;
  });
  const pins = r.next.gates[0]!.pins;
  assert.equal('src' in pins[1]!, false);
  assert.equal(pins[1]!.net_src, 'auto');
  assert.deepEqual([pins[0]!.src, pins[0]!.net_src], ['auto', 'auto']);
});

test('złe auto_segments / auto_junctions / segments: bez wyjątku, pomijane, AUTO_GEOM_INVALID', () => {
  for (const bad of [{ a: 1 }, [5], [[1, 2]], 'x', true, [[1, 2, 3, Infinity]], null]) {
    const p = blankPage({
      nets: {
        A: {
          pins: [],
          segments: [[0, 0, 1, 1]],
          junctions: [[0, 0]],
          auto_segments: bad as never,
          auto_junctions: bad as never,
        },
      },
    });
    const r = edit(p, (q) => {
      q.nets.A!.segments!.push([5, 5, 6, 6]);
    });
    assert.equal('auto_segments' in r.next.nets.A!, false, JSON.stringify(bad));
    assert.deepEqual(autoSegmentMask(p.nets.A!), [false]);
    assert.deepEqual(autoJunctionMask(p.nets.A!), [false]);
    const codes = validatePage(p).map((i) => i.code);
    assert.equal(codes.includes('AUTO_GEOM_INVALID'), true, JSON.stringify(bad));
  }
  // Złe wpisy obok dobrych: dobre działają, złe liczone w ostrzeżeniu.
  const p = blankPage({
    nets: {
      A: {
        pins: [],
        segments: [[0, 0, 1, 1], [1, 2] as never, 'q' as never],
        junctions: 'zz' as never,
        auto_segments: [[1, 1, 0, 0], [1, 2] as never],
      },
    },
  });
  assert.deepEqual(autoSegmentMask(p.nets.A!), [true, false, false]);
  const r = edit(p, (q) => {
    q.gates.push({ ...boxGate(0), src: undefined });
  });
  assert.deepEqual(r.next.nets.A!.auto_segments, [[0, 0, 1, 1]]);
  const w = validatePage(p).filter((i) => i.code === 'AUTO_GEOM_INVALID');
  assert.equal(w.length, 1);
  assert.equal(w[0]!.level, 'warn');
  assert.match(w[0]!.message, /^1 złych/);
  // Poprawne strony bez ostrzeżenia.
  assert.equal(
    validatePage(load()).some((i) => i.code === 'AUTO_GEOM_INVALID'),
    false,
  );
});

test('aspectEmpty: krok wypełnia tylko cały pusty aspekt', () => {
  const g = { ...boxGate(1), src: undefined, text_src: undefined };
  assert.equal(aspectEmpty('gate', g, 'text_src'), true);
  assert.equal(aspectEmpty('gate', g, 'src'), false);
  assert.equal(aspectEmpty('gate', { ...g, ref: '  ' }, 'text_src'), true);
  assert.equal(aspectEmpty('gate', { ...g, ref: 'M5' }, 'text_src'), false); // częściowo wypełniony
  assert.equal(aspectEmpty('gate', { ...g, value: '1k' }, 'text_src'), false);
  assert.equal(aspectEmpty('gate', { ...g, pins: [{ num: 1 }] }, 'text_src'), false);
  assert.equal(aspectEmpty('gate', {}, 'src'), true);
  assert.equal(aspectEmpty('pin', { num: 1, side: 'left', net: '' }, 'net_src'), true);
  assert.equal(
    aspectEmpty(
      'pin',
      { num: 1, side: 'left', net: '', cross: { page: '2', label: 'X' } },
      'net_src',
    ),
    false,
  );
  assert.equal(aspectEmpty('pin', { num: 1, side: 'left', net: 'N' }, 'net_src'), false);
  assert.equal(aspectEmpty('pin', { net: '' }, 'src'), true);
  assert.equal(aspectEmpty('pin', { num: 3 }, 'src'), false);
  assert.equal(aspectEmpty('port', { connector: '', label: '', net: '', x: 1, y: 2 }, 'src'), true);
  assert.equal(aspectEmpty('port', { connector: 'A', label: '', net: '' }, 'src'), false);
  assert.equal(aspectEmpty('port', { connector: '', pin: 5, label: '' }, 'src'), false);
  assert.equal(aspectEmpty('cross_ref', { label: '', pages: [], net: '' }, 'src'), true);
  assert.equal(aspectEmpty('cross_ref', { label: '', pages: ['3'] }, 'src'), false);
  assert.equal(aspectEmpty('cross_ref', { net: null }, 'net_src'), true);
  assert.equal(aspectEmpty('power', { type: '', net: 'VCC' }, 'src'), true);
  assert.equal(aspectEmpty('power', { type: 'VCC', net: 'VCC' }, 'net_src'), false);
  assert.equal(aspectEmpty('port', { label: '' }, 'text_src'), false); // aspekt nie istnieje
});
