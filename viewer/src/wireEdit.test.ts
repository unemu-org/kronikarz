// Run: npm test -w viewer (node --test --experimental-strip-types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Net, Page, Pin } from '@kronikarz/shared';
import { validatePage } from '@kronikarz/shared';
import {
  alignTee,
  combineWireSel,
  commitWire,
  cutSegment,
  deleteSegment,
  deleteWires,
  hitSegment,
  junctionCandidate,
  addJunction,
  removeJunction,
  resolveMerge,
  movePointTo,
  netPieces,
  nextAutoNetName,
  planMerge,
  routeTo,
  snapPoint,
  wireNets,
  wireSelHas,
  wiresInBox,
  type Seg,
} from './wireEdit.ts';

const pin = (num: number, net: string, px: number, py: number): Pin => ({
  num,
  side: 'left',
  px,
  py,
  net,
});
const net = (segments: Seg[], junctions: Array<[number, number]> | null = null): Net => ({
  pins: [],
  segments,
  junctions,
});

// U1 pins at (0,0) [1], (200,0) [2], (100,100) [3]; U2 pin (300,300) [1].
function mkPage(
  nets: Record<string, Net>,
  pins?: { a?: string; b?: string; c?: string; d?: string },
): Page {
  return {
    kronikarz: '1',
    page: '2-1',
    package: 'P-1',
    scan_size: [1000, 1000],
    gates: [
      {
        ref: 'U1',
        gate: 'A',
        x: 500,
        y: 500,
        w: 10,
        h: 10,
        rotation: 0,
        verified: false,
        note: null,
        pins: [
          pin(1, pins?.a ?? '', 0, 0),
          pin(2, pins?.b ?? '', 200, 0),
          pin(3, pins?.c ?? '', 100, 100),
        ],
      },
      {
        ref: 'U2',
        gate: null,
        x: 600,
        y: 600,
        w: 10,
        h: 10,
        rotation: 0,
        verified: false,
        note: null,
        pins: [pin(1, pins?.d ?? '', 300, 300)],
      },
    ],
    power: [],
    ports: [],
    cross_refs: [],
    nets,
    annotations: [],
    decorations: [],
  } as unknown as Page;
}

const codes = (p: Page) =>
  validatePage(p)
    .filter((i) => i.level === 'err')
    .map((i) => i.code);

test('hitSegment: nearest segment within tolerance, projection rounded', () => {
  const p = mkPage({ A: net([[0, 0, 100, 0]]), B: net([[0, 10, 100, 10]]) });
  assert.deepEqual(hitSegment(p, { x: 50, y: 3 }, 6), {
    net: 'A',
    idx: 0,
    at: { x: 50, y: 0 },
    d: 3,
  });
  assert.equal(hitSegment(p, { x: 50, y: 7 }, 6)?.net, 'B');
  assert.equal(hitSegment(p, { x: 50, y: 40 }, 6), null);
});

test('snapPoint: pin before segment end before segment interior; exclude skips the moved point', () => {
  const p = mkPage(
    {
      A: net([
        [0, 0, 100, 0],
        [100, 0, 100, 80],
      ]),
    },
    { a: 'A' },
  );
  assert.equal(snapPoint(p, { x: 3, y: 2 }, 10)?.kind, 'endpoint');
  const e = snapPoint(p, { x: 97, y: 4 }, 10);
  assert.deepEqual(e, { kind: 'point', x: 100, y: 0, net: 'A' });
  const s = snapPoint(p, { x: 50, y: 6 }, 10);
  assert.deepEqual(s, { kind: 'segment', x: 50, y: 0, net: 'A', idx: 0 });
  assert.equal(snapPoint(p, { x: 50, y: 30 }, 10), null);
  // Dragging (100,0): its own ends and the segments ending there do not attract.
  const ex = snapPoint(p, { x: 98, y: 2 }, 10, { net: 'A', at: { x: 100, y: 0 } });
  assert.equal(ex, null);
});

test('deleteSegment: removing an end branch splits nothing', () => {
  // pin1 (0,0) —— (100,0) —[deleted]— (200,0) pin2 ; (100,0) — (100,100) pin3
  const p = mkPage(
    {
      X: net([
        [0, 0, 100, 0],
        [100, 0, 200, 0],
        [100, 0, 100, 100],
      ]),
    },
    { a: 'X', b: 'X', c: 'X' },
  );
  const r = deleteSegment(p, 'X', 1);
  assert.deepEqual(r, { ok: true, split: [] });
  assert.deepEqual(p.nets.X!.segments, [
    [0, 0, 100, 0],
    [100, 0, 100, 100],
  ]);
  // The deleted segment ended at pin2: pin2 has no wire left but stays on X (a pin on no piece is not moved).
  assert.equal(p.gates[0]!.pins[1]!.net, 'X');
});

test('deleteSegment: middle of a chain splits two pieces; validator clean afterwards', () => {
  // pin1 (0,0) —— (100,0) —[x]— (150,0) —— (200,0) pin2, plus pin3 hanging off (100,0)
  const p = mkPage(
    {
      X: net([
        [0, 0, 100, 0],
        [100, 0, 150, 0],
        [150, 0, 200, 0],
        [100, 0, 100, 100],
      ]),
    },
    { a: 'X', b: 'X', c: 'X' },
  );
  assert.deepEqual(codes(p), []);
  const r = deleteSegment(p, 'X', 1);
  assert.deepEqual(r.split, ['NET_AUTO_1']);
  assert.deepEqual(p.nets.X!.segments, [
    [0, 0, 100, 0],
    [100, 0, 100, 100],
  ]);
  assert.deepEqual(p.nets.NET_AUTO_1!.segments, [[150, 0, 200, 0]]);
  assert.equal(p.gates[0]!.pins[0]!.net, 'X');
  assert.equal(p.gates[0]!.pins[2]!.net, 'X');
  assert.equal(p.gates[0]!.pins[1]!.net, 'NET_AUTO_1');
  assert.ok(!codes(p).includes('NET_DISCONNECTED'));
});

test('deleteSegment: a T stub deleted drops the dot that joined it; last segment of a dead net prunes the net', () => {
  const p = mkPage({
    X: net(
      [
        [0, 50, 100, 50],
        [100, 50, 200, 50],
        [100, 50, 100, 100],
      ],
      [[100, 50]],
    ),
    D: net([[500, 500, 600, 500]]),
  });
  deleteSegment(p, 'X', 2);
  assert.equal(p.nets.X!.junctions, null);
  assert.deepEqual(p.nets.X!.segments, [
    [0, 50, 100, 50],
    [100, 50, 200, 50],
  ]);
  deleteSegment(p, 'D', 0);
  assert.equal(p.nets.D, undefined);
});

test('deleteSegment: a piece that was already disconnected before is not split off', () => {
  // X has two separate pieces already (validator flags it); deleting an end segment of piece 1 changes nothing else.
  const p = mkPage({
    X: net([
      [0, 0, 100, 0],
      [100, 0, 100, 50],
      [400, 400, 500, 400],
    ]),
  });
  const r = deleteSegment(p, 'X', 1);
  assert.deepEqual(r.split, []);
  assert.equal(netPieces(p, 'X').length, 2);
});

test('cutSegment: leaves a 12 px gap, far side split off with its pin', () => {
  const p = mkPage({ X: net([[0, 0, 200, 0]]) }, { a: 'X', b: 'X' });
  const r = cutSegment(p, 'X', 0, { x: 120, y: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.split.length, 1);
  const all = [...(p.nets.X!.segments ?? []), ...(p.nets[r.split[0]!]!.segments ?? [])];
  assert.deepEqual(
    all.sort(),
    [
      [0, 0, 114, 0],
      [126, 0, 200, 0],
    ].sort(),
  );
  assert.notEqual(p.gates[0]!.pins[0]!.net, p.gates[0]!.pins[1]!.net);
  assert.ok(!codes(p).includes('NET_DISCONNECTED'));
  // Too short to cut.
  const q = mkPage({ Y: net([[0, 0, 10, 0]]) });
  assert.equal(cutSegment(q, 'Y', 0, { x: 5, y: 0 }).ok, false);
});

test('junction at a crossing: candidate add, addJunction splits both wires and merges the nets', () => {
  const p = mkPage(
    { H: net([[0, 50, 200, 50]]), NET_AUTO_3: net([[100, 0, 100, 100]]) },
    { c: 'NET_AUTO_3' },
  );
  const c = junctionCandidate(p, { x: 103, y: 52 }, 8);
  assert.deepEqual(c, { kind: 'add', at: { x: 100, y: 50 }, nets: ['H', 'NET_AUTO_3'] });
  const plan = planMerge(p, c!.nets)!;
  assert.deepEqual(plan, { into: 'H', from: ['NET_AUTO_3'], confirm: false, suspicious: false });
  addJunction(p, c!.at, plan.into, plan.from);
  assert.equal(p.nets.NET_AUTO_3, undefined);
  assert.equal(p.nets.H!.segments!.length, 4);
  assert.deepEqual(p.nets.H!.junctions, [[100, 50]]);
  assert.equal(netPieces(p, 'H').length, 1);
  assert.equal(p.gates[0]!.pins[2]!.net, 'H');
});

test('junction at a T without a dot (end inside a wire): add splits the through wire', () => {
  const p = mkPage({
    A: net([
      [0, 50, 200, 50],
      [100, 50, 100, 100],
    ]),
  });
  assert.equal(netPieces(p, 'A').length, 2); // T without dot = not connected
  const c = junctionCandidate(p, { x: 100, y: 48 }, 8)!;
  assert.deepEqual(c, { kind: 'add', at: { x: 100, y: 50 }, nets: ['A'] });
  addJunction(p, c.at, 'A', []);
  assert.deepEqual(p.nets.A!.segments, [
    [0, 50, 100, 50],
    [100, 50, 200, 50],
    [100, 50, 100, 100],
  ]);
  assert.equal(netPieces(p, 'A').length, 1);
});

test('removeJunction at a crossing with a dot: two whole wires, split into two nets', () => {
  const p = mkPage(
    {
      X: net(
        [
          [0, 50, 100, 50],
          [100, 50, 200, 50],
          [100, 0, 100, 50],
          [100, 50, 100, 100],
        ],
        [[100, 50]],
      ),
    },
    { c: 'X' },
  );
  const c = junctionCandidate(p, { x: 101, y: 51 }, 8)!;
  assert.equal(c.kind, 'remove');
  const r = removeJunction(p, c.at);
  assert.equal(r.ok, true);
  assert.equal(r.split.length, 1);
  const other = r.split[0]!;
  const lines = [...p.nets.X!.segments!, ...p.nets[other]!.segments!]
    .map((s) => s.join(','))
    .sort();
  assert.deepEqual(lines, ['0,50,200,50', '100,0,100,100']);
  // pin3 (100,100) is on the vertical wire, the vertical wire has it → it kept the name X.
  assert.deepEqual(p.nets.X!.segments, [[100, 0, 100, 100]]);
  assert.equal(p.gates[0]!.pins[2]!.net, 'X');
  assert.equal(p.nets.X!.junctions, null);
});

test('removeJunction at a T (auto dot, three ends): through wire joined, stub split off', () => {
  const p = mkPage(
    {
      X: net([
        [0, 50, 100, 50],
        [100, 50, 200, 50],
        [100, 50, 100, 100],
      ]),
    },
    { c: 'X' },
  );
  const c = junctionCandidate(p, { x: 100, y: 50 }, 8)!;
  assert.deepEqual(c, { kind: 'remove', at: { x: 100, y: 50 }, nets: ['X'] });
  const r = removeJunction(p, c.at);
  assert.equal(r.split.length, 1);
  // stub has pin3 → keeps X; through wire becomes the new net.
  assert.deepEqual(p.nets.X!.segments, [[100, 50, 100, 100]]);
  assert.deepEqual(p.nets[r.split[0]!]!.segments, [[0, 50, 200, 50]]);
  // and back: j again adds the dot and merges (placeholder → into X, no confirm)
  const back = junctionCandidate(p, { x: 100, y: 50 }, 8)!;
  assert.equal(back.kind, 'add');
  const plan = planMerge(p, back.nets)!;
  assert.equal(plan.confirm, false);
  addJunction(p, back.at, plan.into, plan.from);
  assert.equal(netPieces(p, plan.into).length, 1);
});

test('planMerge: real name wins over placeholders; two real names ask; placeholders by weight', () => {
  const p = mkPage({
    A: net([[0, 0, 10, 0]]),
    B: net([[0, 20, 10, 20]]),
    NET_AUTO_1: net([[0, 40, 10, 40]]),
    NET_AUTO_2: net([
      [0, 60, 10, 60],
      [10, 60, 20, 60],
    ]),
  });
  assert.deepEqual(planMerge(p, ['NET_AUTO_1', 'A']), {
    into: 'A',
    from: ['NET_AUTO_1'],
    confirm: false,
    suspicious: false,
  });
  assert.deepEqual(planMerge(p, ['A', 'B']), {
    into: 'A',
    from: ['B'],
    confirm: true,
    suspicious: false,
  });
  assert.deepEqual(planMerge(p, ['NET_AUTO_1', 'NET_AUTO_2']), {
    into: 'NET_AUTO_2',
    from: ['NET_AUTO_1'],
    confirm: false,
    suspicious: false,
  });
  assert.equal(planMerge(p, ['A', 'A', '']), null);
  assert.equal(nextAutoNetName(p), 'NET_AUTO_3');
});

test('routeTo: off-axis ≤ 8 px stays one segment; L corner avoids landing inside a wire', () => {
  const p = mkPage({ W: net([[200, -50, 200, 50]]) });
  assert.deepEqual(routeTo(p, { x: 0, y: 0 }, { x: 300, y: 5 }, true), [{ x: 300, y: 5 }]);
  // corner (200,100)? no: c1 = (end.x,last.y) = (200,0) is inside W → c2 (0,100)
  assert.deepEqual(routeTo(p, { x: 0, y: 0 }, { x: 200, y: 100 }, true), [
    { x: 0, y: 100 },
    { x: 200, y: 100 },
  ]);
  assert.deepEqual(routeTo(p, { x: 0, y: 0 }, { x: 200, y: 100 }, false), [{ x: 200, y: 100 }]);
});

test('commitWire: pin → middle of a wire makes a T with a dot, pin joins, nets merge', () => {
  const p = mkPage({ H: net([[0, 200, 400, 200]]) });
  const start = snapPoint(p, { x: 2, y: 1 }, 10); // pin1 (0,0)
  const end = snapPoint(p, { x: 100, y: 196 }, 10); // H interior (100,200)
  assert.equal(start?.kind, 'endpoint');
  assert.equal(end?.kind, 'segment');
  const { names, fallback } = wireNets(p, start, end);
  assert.deepEqual(names, ['H']);
  assert.equal(fallback, 'NET_AUTO_1');
  const pts = [{ x: 0, y: 0 }, ...routeTo(p, { x: 0, y: 0 }, { x: end!.x, y: end!.y }, true)];
  assert.equal(pts.length, 3); // L corner
  assert.ok(commitWire(p, pts, 'H', [], start, end));
  assert.equal(p.gates[0]!.pins[0]!.net, 'H');
  assert.deepEqual(p.nets.H!.junctions, [[end!.x, 200]]);
  assert.equal(netPieces(p, 'H').length, 1);
  assert.ok(!codes(p).includes('NET_DISCONNECTED'));
});

test('commitWire: two pins on two placeholder nets merge silently', () => {
  const p = mkPage(
    {
      NET_AUTO_1: net([[0, 0, 0, 50]]),
      NET_AUTO_2: net([
        [200, 0, 200, 50],
        [200, 50, 250, 50],
      ]),
    },
    { a: 'NET_AUTO_1', b: 'NET_AUTO_2' },
  );
  const s = snapPoint(p, { x: 0, y: 0 }, 5);
  const e = snapPoint(p, { x: 200, y: 0 }, 5);
  const plan = planMerge(p, wireNets(p, s, e).names)!;
  assert.deepEqual(plan, {
    into: 'NET_AUTO_2',
    from: ['NET_AUTO_1'],
    confirm: false,
    suspicious: false,
  });
  commitWire(
    p,
    [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ],
    plan.into,
    plan.from,
    s,
    e,
  );
  assert.equal(p.nets.NET_AUTO_1, undefined);
  assert.equal(p.gates[0]!.pins[0]!.net, 'NET_AUTO_2');
  assert.equal(netPieces(p, 'NET_AUTO_2').length, 1);
});

test('movePointTo: drag a segment end onto a pin — the pin joins the net', () => {
  const p = mkPage({ X: net([[50, 300, 290, 300]]) });
  const t = snapPoint(p, { x: 296, y: 303 }, 10, { net: 'X', at: { x: 290, y: 300 } });
  assert.equal(t?.kind, 'endpoint');
  movePointTo(p, 'X', { x: 290, y: 300 }, { x: t!.x, y: t!.y }, t, 'X', []);
  assert.deepEqual(p.nets.X!.segments, [[50, 300, 300, 300]]);
  assert.equal(p.gates[1]!.pins[0]!.net, 'X');
});

test('wiresInBox: inside vs touching (Alt); junctions; Shift toggles', () => {
  const p = mkPage({
    A: net(
      [
        [10, 10, 40, 10],
        [40, 10, 90, 10],
      ],
      [[40, 10]],
    ),
    B: net([[0, 50, 30, 50]]),
  });
  const r = { x: 0, y: 0, w: 50, h: 60 };
  const inside = wiresInBox(p, r);
  assert.deepEqual(
    inside.segs.map((e) => e.seg),
    [
      [10, 10, 40, 10],
      [0, 50, 30, 50],
    ],
  );
  assert.deepEqual(inside.juncs, [{ net: 'A', x: 40, y: 10 }]);
  const touch = wiresInBox(p, r, true);
  assert.equal(touch.segs.length, 3);
  assert.ok(wireSelHas(touch, 'A', [90, 10, 40, 10])); // direction does not matter
  const t = combineWireSel(touch, inside, true)!;
  assert.deepEqual(
    t.segs.map((e) => e.seg),
    [[40, 10, 90, 10]],
  );
  assert.deepEqual(t.juncs, []);
  assert.equal(combineWireSel(null, { segs: [], juncs: [] }, false), null);
});

test('deleteWires: several segments of several nets and a dot in one call, split policy per net', () => {
  const p = mkPage(
    {
      X: net(
        [
          [0, 0, 100, 0],
          [100, 0, 150, 0],
          [150, 0, 200, 0],
        ],
        [[150, 0]],
      ),
      Y: net([[300, 300, 300, 400]]),
    },
    { a: 'X', b: 'X', d: 'Y' },
  );
  const sel = combineWireSel(
    null,
    {
      segs: [
        { net: 'X', seg: [150, 0, 100, 0] },
        { net: 'Y', seg: [300, 300, 300, 400] },
      ],
      juncs: [{ net: 'X', x: 150, y: 0 }],
    },
    false,
  )!;
  const r = deleteWires(p, sel);
  assert.equal(r.ok, true);
  assert.equal(r.split.length, 1);
  assert.deepEqual(p.nets.X!.segments, [[0, 0, 100, 0]]);
  assert.equal(p.nets.X!.junctions, null);
  assert.deepEqual(p.nets[r.split[0]!]!.segments, [[150, 0, 200, 0]]);
  assert.equal(p.gates[0]!.pins[1]!.net, r.split[0]);
  // Y keeps its pin reference, so the entry stays (segments empty).
  assert.deepEqual(p.nets.Y!.segments, []);
});

test('resolveMerge: no confirm passes through; letters pick, other text renames, empty cancels', () => {
  const plan = { into: 'A', from: ['B'], confirm: true, suspicious: false };
  assert.deepEqual(
    resolveMerge({ ...plan, confirm: false }, () => {
      throw new Error('asked');
    }),
    { into: 'A', from: ['B'] },
  );
  assert.deepEqual(
    resolveMerge(plan, () => 'b'),
    { into: 'B', from: ['A'] },
  );
  assert.deepEqual(
    resolveMerge(plan, () => ' +ZER '),
    { into: '+ZER', from: ['A', 'B'] },
  );
  assert.equal(
    resolveMerge(plan, () => null),
    null,
  );
  assert.equal(
    resolveMerge(plan, () => '  '),
    null,
  );
});

test('alignTee: a T slides to the anchor axis when it stays on the wire', () => {
  const p = mkPage({ H: net([[0, 200, 400, 200]]) });
  const t = snapPoint(p, { x: 103, y: 196 }, 10)!;
  assert.deepEqual(alignTee(p, t, { x: 100, y: 0 }), {
    kind: 'segment',
    x: 100,
    y: 200,
    net: 'H',
    idx: 0,
  });
  // anchor beyond the wire's ends: stays where it snapped
  assert.deepEqual(alignTee(p, t, { x: 500, y: 0 }), t);
  // other targets untouched
  const e = snapPoint(p, { x: 2, y: 199 }, 10);
  assert.deepEqual(alignTee(p, e, { x: 100, y: 0 }), e);
});

// --- review round (kr-9p8.25) ---

const xref = (label: string, net: string, x: number, y: number) => ({
  net,
  label,
  pages: ['2'],
  x,
  y,
  side: 'left' as const,
});

test('J twice at a crossing of two labelled nets round-trips the names (-RA / -RB)', () => {
  const p = mkPage({ '-RA': net([[0, 50, 200, 50]]), '-RB': net([[100, 0, 100, 100]]) });
  p.cross_refs = [xref('-RA', '-RA', 0, 50), xref('-RB', '-RB', 100, 0)];
  const add = junctionCandidate(p, { x: 100, y: 50 }, 8)!;
  const plan = planMerge(p, add.nets)!;
  assert.equal(plan.confirm, true); // two real names: the user picks
  addJunction(p, add.at, '-RA', ['-RB']);
  assert.equal(p.cross_refs[1]!.net, '-RA');
  const r = removeJunction(p, { x: 100, y: 50 });
  assert.deepEqual(r.split, ['-RB']);
  assert.deepEqual(p.nets['-RA']!.segments, [[0, 50, 200, 50]]);
  assert.deepEqual(p.nets['-RB']!.segments, [[100, 0, 100, 100]]);
  assert.equal(p.cross_refs[0]!.net, '-RA');
  assert.equal(p.cross_refs[1]!.net, '-RB');
});

test('cut next to a power symbol: the power piece keeps GND, the 2-pin piece gets NET_AUTO_1', () => {
  // GND symbol at (0,0) — wire — pins 1 (0,0)? no: pins 2 (200,0) and 3 (100,100) on the far side.
  const p = mkPage(
    {
      GND: net([
        [0, 0, 60, 0],
        [60, 0, 200, 0],
        [100, 0, 100, 100],
      ]),
    },
    { b: 'GND', c: 'GND' },
  );
  p.gates[0]!.pins[0]!.disconnected = true; // pin 1 sits at (0,0) too — out of the way
  p.power = [{ type: 'GND', x: 0, y: 0, net: 'GND' }];
  const r = cutSegment(p, 'GND', 0, { x: 30, y: 0 });
  assert.deepEqual(r.split, ['NET_AUTO_1']);
  assert.equal(p.power[0]!.net, 'GND');
  assert.equal(p.gates[0]!.pins[1]!.net, 'NET_AUTO_1');
});

test('a split-off piece with a port / power label is named after it (made unique)', () => {
  const p = mkPage(
    {
      X: net([
        [0, 0, 100, 0],
        [100, 0, 200, 0],
      ]),
    },
    { a: 'X' },
  );
  p.power = [{ type: '+5V', x: 200, y: 0, net: 'X' }];
  // pin side has 1 endpoint, power side 1 labelled → power side keeps X? labelled wins: X stays with +5V
  const r = deleteSegment(p, 'X', 1);
  assert.deepEqual(r.split, []); // the power side is only the removed segment's end, no piece left there
  const q = mkPage(
    {
      X: net([
        [0, 0, 100, 0],
        [100, 0, 150, 0],
        [150, 0, 200, 0],
      ]),
    },
    { a: 'X' },
  );
  q.cross_refs = [xref('-ZER', 'X', 200, 0), xref('-ZER', 'X', 0, 0)];
  q.nets['-ZER'] = net([[500, 500, 600, 500]]); // name already used → -ZER_2
  const r2 = deleteSegment(q, 'X', 1);
  assert.deepEqual(r2.split, ['-ZER_2']);
});

test('W from a pin on NET_AUTO_3 to a power symbol on no net: the net becomes the power type', () => {
  const p = mkPage({ NET_AUTO_3: net([[0, 0, 0, 80]]) }, { a: 'NET_AUTO_3' });
  p.power = [{ type: 'GND', x: 300, y: 0, net: '' }];
  const s = snapPoint(p, { x: 1, y: 1 }, 5);
  const e = snapPoint(p, { x: 299, y: 2 }, 5);
  const { names } = wireNets(p, s, e);
  assert.deepEqual(names, ['NET_AUTO_3', 'GND']);
  const plan = planMerge(p, names)!;
  assert.deepEqual(plan, { into: 'GND', from: ['NET_AUTO_3'], confirm: false, suspicious: false });
  commitWire(
    p,
    [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ],
    plan.into,
    plan.from,
    s,
    e,
  );
  assert.equal(p.power[0]!.net, 'GND');
  assert.equal(p.gates[0]!.pins[0]!.net, 'GND');
});

test('planMerge: two nets with ≥ 2 endpoints each merge without asking but are suspicious', () => {
  const p = mkPage(
    { NET_AUTO_1: net([[0, 0, 200, 0]]), NET_AUTO_2: net([[100, 100, 300, 300]]) },
    { a: 'NET_AUTO_1', b: 'NET_AUTO_1', c: 'NET_AUTO_2', d: 'NET_AUTO_2' },
  );
  assert.deepEqual(planMerge(p, ['NET_AUTO_1', 'NET_AUTO_2']), {
    into: 'NET_AUTO_1',
    from: ['NET_AUTO_2'],
    confirm: false,
    suspicious: true,
  });
});

test('W start T on a skewed wire (slope 0.3) is kept from the click, not re-snapped', () => {
  const p = mkPage({ S: net([[0, 0, 400, 120]]) });
  // The draft keeps this target; the commit must not depend on snapping its point again.
  const startT = snapPoint(p, { x: 101, y: 33 }, 10)!;
  assert.equal(startT.kind, 'segment');
  const start = { x: startT.x, y: startT.y };
  commitWire(p, [start, { x: start.x, y: 200 }], 'S', [], startT, null);
  assert.equal(netPieces(p, 'S').length, 1);
  assert.deepEqual(p.nets.S!.junctions, [[start.x, start.y]]);
});

test('cut on a 45° wire leaves a gap the connectivity check sees; too short = no-op', () => {
  const p = mkPage({ D: net([[0, 0, 100, 100]]) }, { a: 'D' });
  const r = cutSegment(p, 'D', 0, { x: 50, y: 50 });
  assert.equal(r.ok, true);
  assert.equal(netPieces(p, 'D').length + r.split.length, 2);
  const [a, b] = [...(p.nets.D!.segments ?? []), ...(p.nets[r.split[0]!]?.segments ?? [])] as Seg[];
  const gap = Math.max(Math.abs(a![2] - b![0]), Math.abs(a![3] - b![1]));
  assert.ok(gap > 8, `gap ${gap}`);
  const q = mkPage({ E: net([[0, 0, 12, 12]]) });
  const before = JSON.stringify(q.nets);
  assert.equal(cutSegment(q, 'E', 0, { x: 6, y: 6 }).ok, false);
  assert.equal(JSON.stringify(q.nets), before);
});

test('resolveMerge: a letter outside the list asks again; an existing third net needs a confirm', () => {
  const plan = { into: 'A', from: ['B'], confirm: true, suspicious: false };
  const answers = ['C', 'b'];
  assert.deepEqual(
    resolveMerge(plan, () => answers.shift()!),
    { into: 'B', from: ['A'] },
  );
  const asked: string[] = [];
  const ans2 = ['ZZ', 'ZZ'];
  const confirms = [false, true];
  assert.deepEqual(
    resolveMerge(plan, () => ans2.shift()!, {
      exists: (n) => n === 'ZZ',
      confirm: (m) => (asked.push(m), confirms.shift()!),
    }),
    { into: 'ZZ', from: ['A', 'B'] },
  );
  assert.equal(asked.length, 2);
  assert.equal(
    resolveMerge(plan, () => 'Q'),
    null,
  ); // three wrong letters → cancelled
});

test('commitWire: a wire drawn again between two points of the same net is not doubled', () => {
  const p = mkPage({ L: net([[0, 300, 100, 300]]) });
  const s0 = snapPoint(p, { x: 1, y: 301 }, 5);
  const e0 = snapPoint(p, { x: 99, y: 299 }, 5);
  commitWire(
    p,
    [
      { x: 0, y: 300 },
      { x: 100, y: 300 },
    ],
    'L',
    [],
    s0,
    e0,
  );
  assert.deepEqual(p.nets.L!.segments, [[0, 300, 100, 300]]);
});

test('planMerge: a real name never loses to a labelled placeholder; label sets must be compatible', () => {
  // started on the placeholder NET_AUTO_2 that carries a -RA cross_ref
  const p = mkPage({ '-RA': net([[0, 0, 10, 0]]), NET_AUTO_2: net([[0, 20, 10, 20]]) });
  p.cross_refs = [xref('-RA', 'NET_AUTO_2', 10, 20)];
  assert.deepEqual(planMerge(p, ['NET_AUTO_2', '-RA']), {
    into: '-RA',
    from: ['NET_AUTO_2'],
    confirm: false,
    suspicious: false,
  });
  // GND: real power net vs a placeholder with a GND symbol
  const g = mkPage({ GND: net([[0, 0, 10, 0]]), NET_AUTO_2: net([[0, 20, 10, 20]]) });
  g.power = [
    { type: 'GND', x: 0, y: 0, net: 'GND' },
    { type: 'GND', x: 10, y: 20, net: 'NET_AUTO_2' },
  ];
  assert.deepEqual(planMerge(g, ['NET_AUTO_2', 'GND']), {
    into: 'GND',
    from: ['NET_AUTO_2'],
    confirm: false,
    suspicious: false,
  });
  // +ZER without labels vs a placeholder labelled +ZER: compatible (one empty) → silent
  const z = mkPage({ '+ZER': net([[0, 0, 10, 0]]), NET_AUTO_2: net([[0, 20, 10, 20]]) });
  z.cross_refs = [xref('+ZER', 'NET_AUTO_2', 10, 20)];
  assert.equal(planMerge(z, ['NET_AUTO_2', '+ZER'])!.confirm, false);
  assert.equal(planMerge(z, ['NET_AUTO_2', '+ZER'])!.into, '+ZER');
  // labelled placeholder with another label than the real net's labels → ask
  const q = mkPage({ '-RA': net([[0, 0, 10, 0]]), NET_AUTO_2: net([[0, 20, 10, 20]]) });
  q.cross_refs = [xref('-RA', '-RA', 0, 0), xref('-RB', 'NET_AUTO_2', 10, 20)];
  assert.deepEqual(planMerge(q, ['NET_AUTO_2', '-RA']), {
    into: '-RA',
    from: ['NET_AUTO_2'],
    confirm: true,
    suspicious: false,
  });
  // a net with two labels {-RA, -RB} vs {-RA}: not equal → ask
  q.cross_refs.push(xref('-RA', 'NET_AUTO_2', 10, 20));
  assert.equal(planMerge(q, ['NET_AUTO_2', '-RA'])!.confirm, true);
  // two real names with the same label set → silent, the first wins
  const r = mkPage({ '-RA': net([[0, 0, 10, 0]]), '-RA_2': net([[0, 20, 10, 20]]) });
  r.cross_refs = [xref('-RA', '-RA', 0, 0), xref('-RA', '-RA_2', 10, 20)];
  assert.deepEqual(planMerge(r, ['-RA_2', '-RA']), {
    into: '-RA_2',
    from: ['-RA'],
    confirm: false,
    suspicious: false,
  });
});

test('commitWire along its own collinear wire adds nothing (no split, no dot)', () => {
  const p = mkPage({ H: net([[0, 200, 400, 200]]) });
  const s0 = snapPoint(p, { x: 100, y: 202 }, 5)!;
  const e0 = snapPoint(p, { x: 300, y: 198 }, 5)!;
  assert.equal(s0.kind, 'segment');
  const before = JSON.stringify(p.nets);
  assert.equal(
    commitWire(
      p,
      [
        { x: 100, y: 200 },
        { x: 300, y: 200 },
      ],
      'H',
      [],
      s0,
      e0,
    ),
    false,
  );
  assert.equal(JSON.stringify(p.nets), before);
});
