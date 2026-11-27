// Run: npm test -w viewer (node --test --experimental-strip-types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Net, Page, Pin } from '@kronikarz/shared';
import { validatePage } from '@kronikarz/shared';
import {
  assignEndpointNet,
  connectPins,
  disconnectEndpoint,
  isNetLive,
  mergeDropsCross,
  moveNetPoint,
  planConnect,
  renameNeedsConfirm,
  netEndpoints,
  netExists,
  normalizeNetName,
  pruneNetIfDead,
  renameNet,
  uniqueNetName,
  withNetPointMoved,
} from './netOps.ts';

const pin = (num: number, net: string, px = num * 10, py = 0): Pin => ({ num, side: 'left', px, py, net });

// U1.A pins 1..3, U2 pins 1..2, one port, one cross_ref, one power symbol.
function mkPage(nets: Record<string, Net> = {}): Page {
  return {
    kronikarz: '1',
    page: '2-1',
    package: 'P-1',
    scan_size: [100, 100],
    gates: [
      { ref: 'U1', gate: 'A', x: 0, y: 0, w: 10, h: 10, rotation: 0, verified: false, note: null, pins: [pin(1, 'A'), pin(2, 'A'), pin(3, 'B')] },
      { ref: 'U2', gate: null, x: 0, y: 0, w: 10, h: 10, rotation: 0, verified: false, note: null, pins: [pin(1, 'B'), pin(2, '')] },
    ],
    power: [{ type: 'GND', x: 0, y: 0, net: 'A' }],
    ports: [{ connector: 'A', pin: 5, label: 'X', net: 'A', x: 0, y: 0, side: 'left' }],
    cross_refs: [{ net: 'B', label: 'B', pages: ['2'], x: 0, y: 0, side: 'left' }],
    nets,
    annotations: [],
    decorations: [],
  } as unknown as Page;
}
const seg = (...s: [number, number, number, number][]) => s;
const nets = (p: Page) => Object.keys(p.nets).sort();

test('normalizeNetName: trims, rejects empty/whitespace', () => {
  assert.equal(normalizeNetName('  X '), 'X');
  assert.equal(normalizeNetName(''), null);
  assert.equal(normalizeNetName('   '), null);
  assert.equal(normalizeNetName(undefined), null);
});

test('assignEndpointNet: changes only that pin, others of the old net stay', () => {
  const p = mkPage({ A: { pins: [], segments: seg([0, 0, 10, 0]), junctions: null } });
  const r = assignEndpointNet(p, { kind: 'pin', gateIdx: 0, pinIdx: 0 }, 'B');
  assert.deepEqual(r, { ok: true });
  assert.equal(p.gates[0]!.pins[0]!.net, 'B');
  assert.equal(p.gates[0]!.pins[1]!.net, 'A');
  assert.equal(p.ports![0]!.net, 'A');
  assert.equal(p.power[0]!.net, 'A');
  assert.deepEqual(nets(p), ['A'], 'no entry created for B, A kept');
  assert.deepEqual(p.nets.A!.pins, [], 'pins[] not written');
});

test('assignEndpointNet: port and cross_ref', () => {
  const p = mkPage();
  assert.equal(assignEndpointNet(p, { kind: 'port', idx: 0 }, 'NEW').ok, true);
  assert.equal(assignEndpointNet(p, { kind: 'cross_ref', idx: 0 }, ' NEW ').ok, true);
  assert.equal(p.ports![0]!.net, 'NEW');
  assert.equal(p.cross_refs![0]!.net, 'NEW');
  assert.equal(p.gates[0]!.pins[0]!.net, 'A');
  assert.deepEqual(nets(p), []);
});

test('assignEndpointNet: empty/whitespace rejected, nothing changes, no nets[""]', () => {
  const p = mkPage();
  const before = JSON.stringify(p);
  assert.deepEqual(assignEndpointNet(p, { kind: 'pin', gateIdx: 0, pinIdx: 0 }, ''), { ok: false, error: 'empty-name' });
  assert.deepEqual(assignEndpointNet(p, { kind: 'port', idx: 0 }, '  '), { ok: false, error: 'empty-name' });
  assert.equal(JSON.stringify(p), before);
  assert.ok(!('' in p.nets));
});

test('assignEndpointNet: missing endpoint → error', () => {
  const p = mkPage();
  assert.deepEqual(assignEndpointNet(p, { kind: 'pin', gateIdx: 9, pinIdx: 0 }, 'X'), { ok: false, error: 'no-endpoint' });
});

test('assignEndpointNet: last reference leaving drops a dead entry, keeps one with geometry', () => {
  const p = mkPage({
    B: { pins: [], segments: null, junctions: null },
  });
  // B has refs: U1.A.3, U2.1, cross_ref. Move them all away.
  assignEndpointNet(p, { kind: 'pin', gateIdx: 0, pinIdx: 2 }, 'C');
  assignEndpointNet(p, { kind: 'pin', gateIdx: 1, pinIdx: 0 }, 'C');
  assert.ok(p.nets.B, 'still referenced by cross_ref');
  assignEndpointNet(p, { kind: 'cross_ref', idx: 0 }, 'C');
  assert.ok(!p.nets.B, 'dead (no refs, no geometry) → dropped');

  const q = mkPage({ B: { pins: [], segments: seg([1, 1, 2, 1]), junctions: null } });
  assignEndpointNet(q, { kind: 'pin', gateIdx: 0, pinIdx: 2 }, 'C');
  assignEndpointNet(q, { kind: 'pin', gateIdx: 1, pinIdx: 0 }, 'C');
  assignEndpointNet(q, { kind: 'cross_ref', idx: 0 }, 'C');
  assert.deepEqual(q.nets.B!.segments, [[1, 1, 2, 1]], 'has segments → kept');
});

test('renameNet: without a nets entry rewrites every reference', () => {
  const p = mkPage();
  const r = renameNet(p, 'A', 'A2');
  assert.deepEqual(r, { ok: true, merged: false });
  assert.deepEqual(netEndpoints(p, 'A'), []);
  assert.equal(netEndpoints(p, 'A2').length, 4); // 2 pins + port + power
  assert.deepEqual(nets(p), [], 'no entry invented');
});

test('renameNet: with an entry moves the record', () => {
  const rec: Net = { pins: ['U1.A.1'], segments: seg([0, 0, 10, 0]), junctions: [[5, 0]] };
  const p = mkPage({ A: rec });
  assert.deepEqual(renameNet(p, 'A', 'Z'), { ok: true, merged: false });
  assert.deepEqual(nets(p), ['Z']);
  assert.deepEqual(p.nets.Z!.segments, [[0, 0, 10, 0]]);
  assert.equal(p.gates[0]!.pins[0]!.net, 'Z');
});

test('renameNet: merge into an existing net joins geometry and references', () => {
  const p = mkPage({
    A: { pins: [], segments: seg([0, 0, 10, 0]), junctions: [[5, 0]] },
    B: { pins: ['U2.1'], segments: seg([30, 0, 30, 10]), junctions: [[5, 0], [30, 5]] },
  });
  const r = renameNet(p, 'A', 'B');
  assert.deepEqual(r, { ok: true, merged: true });
  assert.deepEqual(nets(p), ['B']);
  assert.deepEqual(p.nets.B!.segments, [[30, 0, 30, 10], [0, 0, 10, 0]]);
  assert.deepEqual(p.nets.B!.junctions, [[5, 0], [30, 5]], 'duplicate junction not repeated');
  assert.deepEqual(p.nets.B!.pins, ['U2.1'], 'legacy pins kept, nothing added');
  assert.equal(netEndpoints(p, 'B').length, 7);
});

test('renameNet: merge into a net known only by references counts as merge', () => {
  const p = mkPage({ A: { pins: [], segments: seg([0, 0, 1, 0]), junctions: null } });
  assert.deepEqual(renameNet(p, 'A', 'B'), { ok: true, merged: true });
  assert.deepEqual(p.nets.B!.segments, [[0, 0, 1, 0]]);
});

test('renameNet: entries without pins[] do not crash', () => {
  const p = mkPage({
    A: { segments: seg([0, 0, 1, 0]), junctions: null } as unknown as Net,
    B: { segments: null, junctions: null } as unknown as Net,
  });
  assert.equal(renameNet(p, 'A', 'B').ok, true);
  assert.deepEqual(p.nets.B!.segments, [[0, 0, 1, 0]]);
});

test('renameNet: empty/whitespace new name rejected; empty old name rejected; unknown net', () => {
  const p = mkPage({ A: { pins: [], segments: null, junctions: null } });
  const before = JSON.stringify(p);
  assert.deepEqual(renameNet(p, 'A', ''), { ok: false, error: 'empty-name' });
  assert.deepEqual(renameNet(p, 'A', '   '), { ok: false, error: 'empty-name' });
  assert.deepEqual(renameNet(p, '', 'X'), { ok: false, error: 'no-net' });
  assert.deepEqual(renameNet(p, 'NOPE', 'X'), { ok: false, error: 'no-net' });
  assert.equal(JSON.stringify(p), before);
  assert.equal(p.gates[1]!.pins[1]!.net, '', 'unconnected pin untouched');
});

test('isNetLive / netExists / pruneNetIfDead', () => {
  const p = mkPage({
    A: { pins: [], segments: null, junctions: null },
    GEO: { pins: [], segments: seg([0, 0, 1, 0]), junctions: null },
    J: { pins: [], segments: null, junctions: [[1, 1]] },
    DEAD: { pins: ['U9.1'], segments: [], junctions: null },
  });
  assert.equal(isNetLive(p, 'A'), true, 'references');
  assert.equal(isNetLive(p, 'GEO'), true, 'segments');
  assert.equal(isNetLive(p, 'J'), true, 'junctions');
  assert.equal(isNetLive(p, 'DEAD'), false, 'legacy pins[] do not count');
  assert.equal(netExists(p, 'B'), true, 'by references only');
  assert.equal(netExists(p, 'Q'), false);
  for (const n of ['A', 'GEO', 'J']) assert.equal(pruneNetIfDead(p, n), false);
  assert.equal(pruneNetIfDead(p, 'DEAD'), true);
  assert.deepEqual(nets(p), ['A', 'GEO', 'J']);
});

test('uniqueNetName', () => {
  const p = mkPage();
  assert.equal(uniqueNetName(p, 'X'), 'X');
  assert.equal(uniqueNetName(p, 'A'), 'A_2');
});


// --- connectPins / planConnect -------------------------------------------

test('connectPins: b on another live net (refs + geometry) → merge plan, nothing changes without allowMerge', () => {
  const p = mkPage({
    A: { pins: [], segments: null, junctions: null },
    B: { pins: [], segments: seg([30, 0, 30, 10]), junctions: [[30, 5]] },
  });
  const a = { gateIdx: 0, pinIdx: 0 }; // U1.A.1 on A
  const b = { gateIdx: 0, pinIdx: 2 }; // U1.A.3 on B (B also: U2.1, cross_ref)
  assert.deepEqual(planConnect(p, a, b, 'NET_X'), { status: 'merge', from: 'B', into: 'A' });
  const before = JSON.stringify(p);
  const r = connectPins(p, a, b, 'NET_X');
  assert.equal(r.applied, false);
  assert.equal(JSON.stringify(p), before, 'no partial move');
});

test('connectPins: confirmed merge renames b\'s net into a\'s and adds the segment', () => {
  const p = mkPage({
    A: { pins: [], segments: null, junctions: null },
    B: { pins: [], segments: seg([30, 0, 30, 10]), junctions: [[30, 5]] },
  });
  const r = connectPins(p, { gateIdx: 0, pinIdx: 0 }, { gateIdx: 0, pinIdx: 2 }, 'NET_X', { allowMerge: true });
  assert.equal(r.applied, true);
  assert.deepEqual(netEndpoints(p, 'B'), []);
  assert.equal(p.gates[1]!.pins[0]!.net, 'A');
  assert.equal(p.cross_refs![0]!.net, 'A');
  assert.deepEqual(nets(p), ['A']);
  assert.deepEqual(p.nets.A!.segments, [[30, 0, 30, 10], [10, 0, 30, 0]]);
  assert.deepEqual(p.nets.A!.junctions, [[30, 5]]);
  assert.deepEqual(p.nets.A!.pins, [], 'pins[] not written');
});

test('connectPins: b\'s net with segments only (no other refs) is live → merge', () => {
  const p = mkPage({ C: { pins: [], segments: seg([0, 5, 9, 5]), junctions: null } });
  p.gates[1]!.pins[0]!.net = 'C';
  p.cross_refs![0]!.net = 'Z';
  p.gates[0]!.pins[2]!.net = 'Z';
  const a = { gateIdx: 0, pinIdx: 0 };
  const b = { gateIdx: 1, pinIdx: 0 };
  assert.equal(planConnect(p, a, b, 'X').status, 'merge');
  connectPins(p, a, b, 'X');
  assert.ok(p.nets.C, 'not deleted without confirmation');
  connectPins(p, a, b, 'X', { allowMerge: true });
  assert.ok(!p.nets.C);
  assert.deepEqual(p.nets.A!.segments, [[0, 5, 9, 5], [10, 0, 10, 0]]);
});

test('connectPins: b\'s net dead without b → join, old entry dropped', () => {
  const p = mkPage({ C: { pins: [], segments: null, junctions: null } });
  p.gates[1]!.pins[0]!.net = 'C';
  const r = connectPins(p, { gateIdx: 0, pinIdx: 0 }, { gateIdx: 1, pinIdx: 0 }, 'NET_X');
  assert.deepEqual(r, { status: 'join', net: 'A', applied: true });
  assert.equal(p.gates[1]!.pins[0]!.net, 'A');
  assert.ok(!p.nets.C);
});

test('connectPins: same net → noop, no duplicate segment', () => {
  const p = mkPage({ A: { pins: [], segments: seg([10, 0, 20, 0]), junctions: null } });
  const before = JSON.stringify(p);
  const r = connectPins(p, { gateIdx: 0, pinIdx: 0 }, { gateIdx: 0, pinIdx: 1 }, 'X', { allowMerge: true });
  assert.deepEqual(r, { status: 'noop', net: 'A', applied: false });
  assert.equal(JSON.stringify(p), before);
});

test('connectPins: a unconnected → uses b\'s net; both unconnected → unique fallback, never nets[""]', () => {
  const p = mkPage();
  p.gates[0]!.pins[0]!.net = '';
  assert.equal(connectPins(p, { gateIdx: 0, pinIdx: 0 }, { gateIdx: 0, pinIdx: 2 }, 'NET_X').status, 'join');
  assert.equal(p.gates[0]!.pins[0]!.net, 'B');

  const q = mkPage();
  q.gates[0]!.pins[0]!.net = '';
  q.gates[1]!.pins[1]!.net = '';
  assert.deepEqual(connectPins(q, { gateIdx: 0, pinIdx: 0 }, { gateIdx: 1, pinIdx: 1 }, 'A'), { status: 'join', net: 'A_2', applied: true });
  assert.equal(q.gates[0]!.pins[0]!.net, 'A_2');
  assert.equal(q.gates[1]!.pins[1]!.net, 'A_2');
  assert.ok(!('' in q.nets));
});

test('connectPins: missing pin → page untouched', () => {
  const p = mkPage();
  const before = JSON.stringify(p);
  assert.equal(connectPins(p, { gateIdx: 0, pinIdx: 0 }, { gateIdx: 5, pinIdx: 0 }, 'X').status, 'missing');
  assert.equal(JSON.stringify(p), before);
});

// --- signal-name rename (port / cross_ref field) -------------------------

test('port field scenario: wire pin→port on NET_U1_3, typing -RC renames the whole net', () => {
  const p = mkPage({ NET_U1_3: { pins: [], segments: seg([30, 0, 50, 0]), junctions: null } });
  p.gates[0]!.pins[2]!.net = 'NET_U1_3';
  p.ports![0]!.net = 'NET_U1_3';
  assert.equal(renameNeedsConfirm(p, 'NET_U1_3', '-RC'), false, 'new name → no confirm');
  assert.deepEqual(renameNet(p, 'NET_U1_3', '-RC'), { ok: true, merged: false });
  assert.equal(p.gates[0]!.pins[2]!.net, '-RC');
  assert.equal(p.ports![0]!.net, '-RC');
  assert.deepEqual(nets(p), ['-RC']);
});

test('renameNeedsConfirm: live target yes; dead empty entry / unknown / same / empty no', () => {
  const p = mkPage({
    A: { pins: [], segments: null, junctions: null },
    DEAD: { pins: [], segments: null, junctions: null },
    GEO: { pins: [], segments: seg([0, 0, 1, 0]), junctions: null },
  });
  assert.equal(renameNeedsConfirm(p, 'A', 'B'), true, 'B live by references');
  assert.equal(renameNeedsConfirm(p, 'A', 'GEO'), true, 'live by geometry');
  assert.equal(renameNeedsConfirm(p, 'A', 'DEAD'), false, 'dead entry → merge silently');
  assert.equal(renameNeedsConfirm(p, 'A', 'NEW'), false);
  assert.equal(renameNeedsConfirm(p, 'A', 'A'), false);
  assert.equal(renameNeedsConfirm(p, 'A', '  '), false);
  // and the merge into the dead entry works
  assert.deepEqual(renameNet(p, 'A', 'DEAD'), { ok: true, merged: true });
  assert.equal(p.ports![0]!.net, 'DEAD');
});

// --- disconnect ---------------------------------------------------------

test('disconnectEndpoint: only that endpoint → "", live old net kept', () => {
  const p = mkPage({ A: { pins: [], segments: null, junctions: null } });
  assert.deepEqual(disconnectEndpoint(p, { kind: 'pin', gateIdx: 0, pinIdx: 0 }), { ok: true });
  assert.equal(p.gates[0]!.pins[0]!.net, '');
  assert.equal(p.gates[0]!.pins[1]!.net, 'A');
  assert.ok(p.nets.A);
  assert.ok(!('' in p.nets));
});

test('disconnectEndpoint: last reference → dead entry dropped; with segments kept', () => {
  const p = mkPage({ B: { pins: [], segments: null, junctions: null } });
  disconnectEndpoint(p, { kind: 'pin', gateIdx: 0, pinIdx: 2 });
  disconnectEndpoint(p, { kind: 'pin', gateIdx: 1, pinIdx: 0 });
  assert.ok(p.nets.B);
  disconnectEndpoint(p, { kind: 'cross_ref', idx: 0 });
  assert.equal(p.cross_refs![0]!.net, '');
  assert.ok(!p.nets.B);

  const q = mkPage({ PORTNET: { pins: [], segments: seg([0, 0, 5, 0]), junctions: null } });
  q.ports![0]!.net = 'PORTNET';
  disconnectEndpoint(q, { kind: 'port', idx: 0 });
  assert.equal(q.ports![0]!.net, '');
  assert.ok(q.nets.PORTNET, 'geometry → kept');
});

test('disconnectEndpoint: already unconnected / missing endpoint', () => {
  const p = mkPage();
  const before = JSON.stringify(p);
  assert.deepEqual(disconnectEndpoint(p, { kind: 'pin', gateIdx: 1, pinIdx: 1 }), { ok: true });
  assert.deepEqual(disconnectEndpoint(p, { kind: 'port', idx: 7 }), { ok: false, error: 'no-endpoint' });
  assert.equal(JSON.stringify(p), before);
});

// --- merge details: legacy pins[], cross --------------------------------

test('merge: no pins field invented when neither record had ids; source ids carried over', () => {
  const p = mkPage({
    A: { segments: seg([0, 0, 1, 0]), junctions: null } as unknown as Net,
    B: { segments: null, junctions: null } as unknown as Net,
  });
  renameNet(p, 'A', 'B');
  assert.ok(!('pins' in p.nets.B!), 'pins not created');

  const q = mkPage({
    A: { pins: ['U1.A.1'], segments: null, junctions: null },
    B: { segments: null, junctions: null } as unknown as Net,
  });
  renameNet(q, 'A', 'B');
  assert.deepEqual(q.nets.B!.pins, ['U1.A.1']);
});

test('merge: both nets have cross → target\'s kept, mergeDropsCross names the dropped one', () => {
  const p = mkPage({
    A: { pins: [], segments: null, junctions: null, cross: { page: '2-5', label: 'XA' } },
    B: { pins: [], segments: null, junctions: null, cross: { page: '2-7', label: 'XB' } },
  });
  assert.deepEqual(mergeDropsCross(p, 'A', 'B'), { page: '2-5', label: 'XA' });
  assert.equal(mergeDropsCross(p, 'A', 'NEW'), null);
  renameNet(p, 'A', 'B');
  assert.deepEqual(p.nets.B!.cross, { page: '2-7', label: 'XB' });

  const q = mkPage({
    A: { pins: [], segments: null, junctions: null, cross: { page: '2-5', label: 'XA' } },
    B: { pins: [], segments: null, junctions: null },
  });
  assert.equal(mergeDropsCross(q, 'A', 'B'), null);
  renameNet(q, 'A', 'B');
  assert.deepEqual(q.nets.B!.cross, { page: '2-5', label: 'XA' }, 'only source has cross → carried');
});

test('validatePage: a nets entry without pins[] does not crash', () => {
  const p = mkPage({ A: { segments: null, junctions: null } as unknown as Net });
  assert.doesNotThrow(() => validatePage(p));
});

test('moveNetPoint: every segment end and junction at the point moves, nothing else', () => {
  const net: Net = {
    pins: [],
    segments: [[0, 0, 10, 0], [10, 0, 10, 10], [10, 0, 20, 0], [20, 0, 30, 0]],
    junctions: [[10, 0], [20, 0]],
  };
  moveNetPoint(net, { x: 10, y: 0 }, { x: 12, y: 3 });
  assert.deepEqual(net.segments, [[0, 0, 12, 3], [12, 3, 10, 10], [12, 3, 20, 0], [20, 0, 30, 0]]);
  assert.deepEqual(net.junctions, [[12, 3], [20, 0]]);
  const bare: Net = { pins: [], segments: null, junctions: null };
  moveNetPoint(bare, { x: 0, y: 0 }, { x: 1, y: 1 });
  assert.deepEqual(bare, { pins: [], segments: null, junctions: null });
});

test('withNetPointMoved: preview copy, the stored net is untouched', () => {
  const net: Net = { pins: ['U1.1'], segments: [[0, 0, 10, 0]], junctions: [[0, 0]] };
  const before = JSON.stringify(net);
  const moved = withNetPointMoved(net, { x: 0, y: 0 }, { x: 5, y: 5 });
  assert.equal(JSON.stringify(net), before);
  assert.deepEqual(moved.segments, [[5, 5, 10, 0]]);
  assert.deepEqual(moved.junctions, [[5, 5]]);
  assert.deepEqual(moved.pins, ['U1.1']);
  // Always from the drag-start point, not from the previous preview: passing
  // over another point of the net does not pick it up.
  const two: Net = { pins: [], segments: [[0, 0, 10, 0], [20, 0, 30, 0]], junctions: null };
  const p1 = withNetPointMoved(two, { x: 0, y: 0 }, { x: 20, y: 0 });
  const p2 = withNetPointMoved(two, { x: 0, y: 0 }, { x: 25, y: 5 });
  assert.deepEqual(p1.segments, [[20, 0, 10, 0], [20, 0, 30, 0]]);
  assert.deepEqual(p2.segments, [[25, 5, 10, 0], [20, 0, 30, 0]]);
});
