// Run: npm test -w viewer. Etapowy viewer (kr-9p8.20): czyste funkcje stepView.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Issue, Page } from '@kronikarz/shared';
import {
  FAINT_OPACITY,
  PROV_COLORS,
  approveStep,
  autoBody,
  autoOutcome,
  autoReplyMessage,
  blockingErrors,
  canApprove,
  countsLine,
  defaultStep,
  groupIssues,
  issueRelevant,
  issueStep,
  marksText,
  partLook,
  partRole,
  placeAllowed,
  provColor,
  reviewQueue,
  runNeeds,
  stepCounts,
  stepMarks,
  stepQueueIndex,
  toolAllowed,
  unapproveStep,
  wireFlags,
  aspectStep,
  canEditElement,
  editStepFor,
  freshStoredResult,
  pageActionAllowed,
  panelEditable,
  rubberBand,
  shouldRefreshPackage,
  fieldAspect,
  fieldEditable,
  STATUS_COLOR,
  STORED_RESULT_MAX_AGE_MS,
} from './stepView.ts';

function mkPage(over: Partial<Page> = {}): Page {
  return {
    kronikarz: '1',
    page: '2-1',
    package: 'P-1',
    scan_size: [1000, 1000],
    gates: [
      { ref: 'M1', gate: 'A', x: 100, y: 100, w: 60, h: 80, rotation: 0, verified: false, note: null, src: 'auto', pins: [] },
      { ref: 'M2', gate: 'B', x: 300, y: 100, rotation: 0, verified: false, note: null, pins: [] },
      {
        ref: 'M3',
        gate: 'A',
        x: 500,
        y: 100,
        rotation: 0,
        verified: false,
        note: null,
        text_src: 'auto',
        pins: [{ num: 1, side: 'left', px: 470, py: 100, net: 'N1', src: 'auto', net_src: 'auto' }],
      },
    ],
    power: [],
    ports: [],
    cross_refs: [],
    nets: {},
    annotations: [],
    ...over,
  } as Page;
}

// --- element → krok, wyszarzenie ---

test('partRole: części rysunku należą do kroków jak w steps.ts', () => {
  assert.equal(partRole('gateBox', 'gates'), 'own');
  assert.equal(partRole('gateText', 'gates'), 'other');
  assert.equal(partRole('pin', 'gates'), 'other');
  assert.equal(partRole('gateText', 'text'), 'own');
  assert.equal(partRole('pin', 'text'), 'own');
  assert.equal(partRole('gateBox', 'text'), 'context');
  assert.equal(partRole('wire', 'wires'), 'own');
  assert.equal(partRole('pin', 'wires'), 'context'); // druty dochodzą do pinów
  assert.equal(partRole('label', 'wires'), 'other');
  assert.equal(partRole('label', 'labels'), 'own');
  assert.equal(partRole('wire', 'labels'), 'context'); // etykiety na wolnych końcach
  assert.equal(partRole('pin', 'nets'), 'own'); // pin.net_src
  assert.equal(partRole('label', 'nets'), 'own'); // port/xref/power .net_src
  assert.equal(partRole('pinCross', 'nets'), 'own');
  assert.equal(partRole('decor', 'nets'), 'other');
  // bez kroku i w ⑥ — wszystko zwykłe
  for (const part of ['gateBox', 'gateText', 'pin', 'wire', 'label', 'pinCross', 'decor'] as const) {
    assert.equal(partRole(part, null), 'context');
    assert.equal(partRole(part, 'kicad'), 'context');
  }
});

test('partLook: inne kroki wyszarzone (bez interakcji) albo ukryte', () => {
  assert.deepEqual(partLook('wire', 'gates', 'faint'), { role: 'other', visible: true, opacity: FAINT_OPACITY, listening: false });
  assert.deepEqual(partLook('wire', 'gates', 'hidden'), { role: 'other', visible: false, opacity: FAINT_OPACITY, listening: false });
  assert.deepEqual(partLook('gateBox', 'gates', 'hidden'), { role: 'own', visible: true, opacity: 1, listening: true });
  assert.deepEqual(partLook('gateBox', 'wires', 'hidden'), { role: 'context', visible: true, opacity: 1, listening: true });
  assert.deepEqual(partLook('decor', null, 'hidden'), { role: 'context', visible: true, opacity: 1, listening: true });
});

test('provColor: zatwierdzony → zielony, inaczej auto niebieski / edited pomarańczowy', () => {
  assert.equal(provColor('approved', 'auto'), PROV_COLORS.approved);
  assert.equal(provColor('approved', 'edited'), PROV_COLORS.approved);
  assert.equal(provColor('auto', 'auto'), PROV_COLORS.auto);
  assert.equal(provColor('auto', 'edited'), PROV_COLORS.edited);
  assert.equal(provColor('stale', 'auto'), PROV_COLORS.auto);
  assert.equal(provColor('todo', 'edited'), PROV_COLORS.edited);
});

// --- narzędzia ---

test('toolAllowed / placeAllowed: narzędzia kroku', () => {
  for (const t of ['select', 'edit', 'roi', 'wire', 'zones'] as const) assert.equal(toolAllowed(null, t), true);
  assert.equal(toolAllowed('gates', 'edit'), true);
  assert.equal(toolAllowed('gates', 'wire'), false);
  assert.equal(toolAllowed('wires', 'wire'), true);
  assert.equal(toolAllowed('nets', 'wire'), true);
  assert.equal(toolAllowed('labels', 'wire'), false);
  assert.equal(toolAllowed('text', 'roi'), false);
  assert.equal(toolAllowed('wires', 'zones'), false);
  assert.equal(toolAllowed('kicad', 'edit'), false);
  assert.equal(toolAllowed('kicad', 'select'), true);
  assert.equal(placeAllowed(null, 'annotation'), true);
  assert.equal(placeAllowed('gates', 'gate'), true);
  assert.equal(placeAllowed('gates', 'port'), false);
  assert.equal(placeAllowed('labels', 'port'), true);
  assert.equal(placeAllowed('labels', 'cross_ref'), true);
  assert.equal(placeAllowed('labels', 'power'), true);
  assert.equal(placeAllowed('labels', 'gate'), false);
  assert.equal(placeAllowed('wires', 'decoration'), false);
});

// --- krok domyślny, znaczki ---

test('defaultStep: bez steps → null; pierwszy do przeglądu; potem następny do uruchomienia', () => {
  assert.equal(defaultStep({}), null);
  assert.equal(defaultStep({ steps: {} }), null);
  assert.equal(defaultStep({ steps: { gates: { status: 'approved' } } }), 'text');
  assert.equal(defaultStep({ steps: { gates: { status: 'approved' }, text: { status: 'approved' }, wires: { status: 'auto' } } }), 'wires');
  assert.equal(defaultStep({ steps: { gates: { status: 'auto' }, wires: { status: 'auto' } } }), 'gates');
  assert.equal(defaultStep({ steps: { gates: { status: 'approved' }, text: { status: 'stale' } } }), 'text');
  const all = { status: 'approved' as const };
  assert.equal(defaultStep({ steps: { gates: all, text: all, wires: all, labels: all, nets: all } }), null);
});

test('stepMarks / marksText: ✓ ● ◐ ○ per krok ①–⑤', () => {
  assert.equal(marksText(undefined), '○○○○○');
  assert.equal(marksText({ steps: { gates: { status: 'approved' }, text: { status: 'auto' }, wires: { status: 'stale' } } }), '✓●◐○○');
  const m = stepMarks({ steps: { gates: { status: 'approved' } } });
  assert.equal(m.length, 5);
  assert.equal(m[0]!.step, 'gates');
  assert.equal(m[0]!.status, 'approved');
  assert.equal(m[1]!.status, 'todo');
});

// --- walidacja ---

const iss = (code: string, level: Issue['level'] = 'err', extra: Partial<Issue> = {}): Issue => ({ code, level, message: code, ...extra });

test('issueStep: kody walidatora → kroki; nieznane / pakiet / projekt → null', () => {
  assert.equal(issueStep('GATES_UNVERIFIED'), 'gates');
  assert.equal(issueStep('GATE_UNKNOWN_REF'), 'text');
  assert.equal(issueStep('GATE_PIN_INVALID'), 'text');
  assert.equal(issueStep('NET_NO_SEGMENTS'), 'wires');
  assert.equal(issueStep('AUTO_GEOM_INVALID'), 'wires');
  assert.equal(issueStep('PORT_NOT_ON_BACKPLANE'), 'labels');
  assert.equal(issueStep('CROSS_REF_NO_RETURN'), 'nets'); // dopasowanie po cr.net
  assert.equal(issueStep('CROSS_REF_UNKNOWN_PAGE'), 'labels');
  assert.equal(issueStep('NET_EMPTY'), 'nets');
  assert.equal(issueStep('ENDPOINT_NET_MISMATCH'), 'nets');
  assert.equal(issueStep('GATE_UNUSED'), null);
  assert.equal(issueStep('BACKPLANE_SINGLE_ENDPOINT'), null);
  assert.equal(issueStep('STEP_INVALID'), null);
  assert.equal(issueStep('WHATEVER_NEW'), null);
  assert.equal(issueStep('toString'), null); // nie z prototypu
});

test('groupIssues: krok, „inne”, ukryte (inne kroki i inne strony); wszystkie bez filtra', () => {
  const list = [
    iss('GATE_UNKNOWN_REF'),
    iss('NET_EMPTY', 'warn'),
    iss('STEP_INVALID', 'warn'),
    iss('CROSS_REF_NO_RETURN', 'err', { page: '2-1' }),
    iss('CROSS_REF_NO_RETURN', 'err', { page: '2-9' }),
    iss('IC_UNKNOWN_SUFFIX', 'warn', { scope: 'package' }),
  ];
  const g = groupIssues(list, 'text', false, '2-1');
  assert.deepEqual(g.step.map((i) => i.code), ['GATE_UNKNOWN_REF']);
  assert.deepEqual(g.other.map((i) => i.code), ['STEP_INVALID', 'IC_UNKNOWN_SUFFIX']); // rejestr pakietu → inne
  assert.equal(g.hidden, 3);
  const l = groupIssues(list, 'nets', false, '2-1');
  assert.deepEqual(l.step.map((i) => i.page ?? i.code), ['NET_EMPTY', '2-1']);
  assert.equal(groupIssues(list, 'text', true, '2-1').step.length, 6);
  assert.equal(groupIssues(list, null, false, '2-1').step.length, 6);
  assert.equal(groupIssues(list, 'kicad', false, '2-1').step.length, 6);
  // IC_UNKNOWN_SUFFIX ze strony (bez scope) zostaje w ②
  assert.deepEqual(groupIssues([iss('IC_UNKNOWN_SUFFIX', 'warn')], 'text', false, '2-1').step.length, 1);
});

test('issueRelevant: kolory błędów na płótnie tylko z kodów bieżącego kroku', () => {
  assert.equal(issueRelevant(iss('GATE_UNKNOWN_REF'), 'gates'), false);
  assert.equal(issueRelevant(iss('GATE_UNKNOWN_REF'), 'text'), true);
  assert.equal(issueRelevant(iss('NET_FLOATING'), 'wires'), false);
  assert.equal(issueRelevant(iss('NET_FLOATING'), null), true);
  assert.equal(issueRelevant(iss('IC_UNKNOWN_SUFFIX', 'warn', { scope: 'package' }), 'text'), false);
});

test('blockingErrors / canApprove: ⑤ tylko bez błędów strony', () => {
  const p = mkPage({ steps: { nets: { status: 'auto' } } });
  const list = [iss('NET_FLOATING'), iss('NET_EMPTY', 'warn'), iss('BACKPLANE_UNKNOWN_PACKAGE'), iss('CROSS_REF_NO_RETURN', 'err', { page: '2-9' }), iss('GATE_PAGE_UNKNOWN', 'err', { scope: 'package' })];
  assert.deepEqual(blockingErrors(list, '2-1').map((i) => i.code), ['NET_FLOATING']);
  const r = canApprove(p, 'nets', list, '2-1');
  assert.equal(r.ok, false);
  assert.match(r.reason!, /1 err \(NET_FLOATING ⑤\)/);
  assert.equal(canApprove(p, 'nets', list.slice(1), '2-1').ok, true);
  assert.equal(canApprove(p, 'wires', list, '2-1').ok, true); // inne kroki bez blokady
  assert.equal(canApprove(mkPage({ steps: { gates: { status: 'approved' } } }), 'gates', [], '2-1').ok, false);
  // brak odsyłacza powrotnego na innej stronie nie blokuje tej strony (USER)
  assert.equal(canApprove(p, 'nets', [iss('CROSS_REF_NO_RETURN', 'err', { page: '2-1' })], '2-1').ok, true);
});

// --- zatwierdzanie ---

test('approveStep: status approved + at, run zostaje; ① oznacza bramki verified', () => {
  const p = mkPage({ steps: { gates: { status: 'auto', run: 'R1', at: 'x' } } });
  approveStep(p, 'gates', '2026-11-28T10:00:00Z');
  assert.deepEqual(p.steps!.gates, { status: 'approved', run: 'R1', at: '2026-11-28T10:00:00Z' });
  assert.ok(p.gates.every((g) => g.verified === true));
  const q = mkPage();
  approveStep(q, 'wires', 'T');
  assert.deepEqual(q.steps, { wires: { status: 'approved', at: 'T' } });
  assert.ok(q.gates.every((g) => g.verified === false)); // tylko ① rusza verified
});

test('unapproveStep: wraca do auto (był run) / todo; późniejsze zatwierdzone → stale', () => {
  const p = mkPage({
    steps: { gates: { status: 'approved', run: 'R1' }, text: { status: 'approved' }, wires: { status: 'auto' } },
  });
  unapproveStep(p, 'gates', 'T');
  assert.equal(p.steps!.gates!.status, 'auto');
  assert.equal(p.steps!.gates!.run, 'R1');
  assert.equal(p.steps!.text!.status, 'stale');
  assert.equal(p.steps!.wires!.status, 'auto');
  const q = mkPage({ steps: { text: { status: 'approved' } } });
  unapproveStep(q, 'text', 'T');
  assert.equal(q.steps!.text!.status, 'todo');
  const r = mkPage({ steps: { text: { status: 'auto' } } });
  unapproveStep(r, 'text', 'T'); // niezatwierdzony — bez zmian
  assert.deepEqual(r.steps, { text: { status: 'auto' } });
});

// --- uruchamianie ---

test('runNeeds: wymuś przy zatwierdzonym, szkic przy niezatwierdzonym poprzedniku', () => {
  assert.deepEqual(runNeeds({}, 'gates'), { needsForce: false, needsDraft: false, blocked: null });
  const p = { steps: { gates: { status: 'approved' as const } } };
  const n = runNeeds(p, 'gates');
  assert.equal(n.needsForce, true);
  assert.match(n.blocked!, /force/);
  assert.equal(runNeeds(p, 'gates', { force: true }).blocked, null);
  const w = runNeeds({ steps: { gates: { status: 'approved' } } }, 'wires');
  assert.equal(w.needsDraft, true);
  assert.match(w.blocked!, /text/);
  assert.equal(runNeeds({ steps: { gates: { status: 'approved' } } }, 'wires', { draft: true }).blocked, null);
  assert.equal(runNeeds({ steps: { gates: { status: 'approved' } } }, 'text').needsDraft, false);
});

test('autoBody: kształt żądania POST /auto; force nigdy z next', () => {
  assert.deepEqual(autoBody('P-R3-2', '2-62', 'gates', { draft: true }), {
    pkg: 'P-R3-2', page: '2-62', step: 'gates', force: false, draft: true, dryRun: false,
  });
  assert.equal(autoBody('P', 'all', 'next', { force: true }).force, false);
  assert.equal(autoBody('P', '2-1', 'wires', { force: true, dryRun: true }).dryRun, true);
});

// --- odpowiedź /auto → komunikat ---

const gatesCounts = { detected: 10, removed_auto: 0, added_auto: 2, kept: 10, kept_human: 10, kept_auto: 0, dropped_overlap: 8 };

test('autoReplyMessage 200: liczniki strony, zapisane strony', () => {
  const data = {
    package: 'P', page: '2-62', step: 'gates', exit: 0,
    pages: [{ page: '2-62', step: 'gates', status: 'ok', exit: 0, counts: gatesCounts, written: true, time_s: 0.41, stale: [] }],
  };
  const m = autoReplyMessage(200, data);
  assert.equal(m.kind, 'ok');
  assert.deepEqual(m.written, ['2-62']);
  assert.match(m.lines[0]!, /^2-62 ① gates: zapisano — wykryte 10, dodane auto 2/);
  assert.match(m.lines[0]!, /odrzucone na zostających 8; 0\.41 s$/);
  assert.equal(autoOutcome(200, m), 'ok');
});

test('autoReplyMessage 200 dry-run: nic nie zapisano', () => {
  const data = {
    dry_run: true, exit: 0,
    pages: [{ page: '2-62', step: 'wires', status: 'dry_run', exit: 0, written: false, counts: { detected_segments: 5, step5_nets: { X: 2 } } }],
  };
  const m = autoReplyMessage(200, data);
  assert.equal(m.kind, 'dry');
  assert.deepEqual(m.written, []);
  assert.match(m.lines[0]!, /podgląd \(nic nie zapisano\) — wykryte 5 odc\./);
  assert.match(m.lines[0]!, /usunięte auto z netów po ⑤: X/);
});

test('autoReplyMessage 409 busy: informacja o zadaniu', () => {
  const m = autoReplyMessage(409, { error: 'busy', job: { id: 7, kind: 'auto', step: 'wires', pkg: 'P', page: 'all', startedAt: '2026-11-28T10:00:00Z' } });
  assert.equal(m.kind, 'busy');
  assert.match(m.lines[0]!, /zadanie #7 auto wires P all od 2026-11-28T10:00:00Z/);
  assert.equal(autoOutcome(409, m), 'not-applied');
});

test('autoReplyMessage 409 refused: powody odmowy', () => {
  const m = autoReplyMessage(409, {
    error: 'refused',
    reasons: [{ page: '2-62', step: 'wires', status: 'refused', reason: 'poprzedni krok text nie jest zatwierdzony' }],
    result: { exit: 2, pages: [{ page: '2-62', step: 'wires', status: 'refused', exit: 2 }] },
  });
  assert.equal(m.kind, 'refused');
  assert.deepEqual(m.lines, ['2-62 ③ wires: poprzedni krok text nie jest zatwierdzony']);
  assert.equal(autoOutcome(409, m), 'not-applied');
});

test('autoReplyMessage 501: krok jeszcze niezaimplementowany', () => {
  const m = autoReplyMessage(501, {
    error: 'not_implemented', reasons: [],
    result: { exit: 3, reason: 'krok text nie jest jeszcze zaimplementowany (są: gates, wires)', pages: [] },
  });
  assert.equal(m.kind, 'not-implemented');
  assert.equal(m.title, 'Krok jeszcze niezaimplementowany');
  assert.deepEqual(m.lines, ['krok text nie jest jeszcze zaimplementowany (są: gates, wires)']);
  assert.equal(autoOutcome(501, m), 'not-applied');
});

test('autoReplyMessage 501 przy page=all: zapisane strony w tytule i liście', () => {
  const m = autoReplyMessage(501, {
    error: 'not_implemented', reasons: [{ page: '2-62', step: 'text', status: 'not_implemented', reason: 'krok text nie jest jeszcze zaimplementowany' }],
    result: { exit: 3, pages: [
      { page: '2-58', step: 'gates', status: 'ok', exit: 0, written: true, counts: gatesCounts },
      { page: '2-62', step: 'text', status: 'not_implemented', exit: 3, reason: 'krok text nie jest jeszcze zaimplementowany' },
    ] },
  });
  assert.equal(m.title, 'Zapisane strony: 1; na pozostałych krok jeszcze niezaimplementowany');
  assert.deepEqual(m.written, ['2-58']);
  assert.equal(m.lines.length, 2);
  assert.match(m.lines[0]!, /^2-62 ② text: niezaimplementowany/);
  assert.match(m.lines[1]!, /^2-58 ① gates: zapisano/);
  assert.equal(autoOutcome(501, m), 'ok');
});

test('autoReplyMessage 500: końcówka stderr; bez wyniku niepewne, z wynikiem bez zapisu nie', () => {
  const m = autoReplyMessage(500, { error: 'auto.py exit 1 without a matching JSON summary', stderr: 'a\nTraceback\nboom\n' });
  assert.equal(m.kind, 'error');
  assert.deepEqual(m.lines, ['stderr:', 'a', 'Traceback', 'boom']);
  assert.equal(m.uncertain, true);
  assert.equal(autoOutcome(500, m), 'ambiguous');
  const r = autoReplyMessage(500, {
    error: 'failed', reasons: [], stderr: '',
    result: { exit: 1, pages: [{ page: '2-62', step: 'gates', status: 'error', exit: 1, reason: 'brak skanu' }] },
  });
  assert.equal(r.uncertain, false);
  assert.deepEqual(r.lines, ['2-62 ① gates: BŁĄD — brak skanu']);
  assert.equal(autoOutcome(500, r), 'not-applied');
  // przy 'all' część stron mogła się zapisać mimo błędu → przeładuj
  const w = autoReplyMessage(500, {
    error: 'failed',
    result: { exit: 1, pages: [{ page: '2-1', status: 'ok', exit: 0, written: true, step: 'gates', counts: gatesCounts }, { page: '2-2', status: 'error', exit: 1, reason: 'x' }] },
  });
  assert.deepEqual(w.written, ['2-1']);
  assert.equal(autoOutcome(500, w), 'ok');
});

test('autoReplyMessage 504 / brak odpowiedzi → niepewne; 4xx → błąd żądania', () => {
  assert.equal(autoOutcome(504, autoReplyMessage(504, { error: 'timeout' })), 'ambiguous');
  assert.equal(autoOutcome(0, autoReplyMessage(0, { error: 'Failed to fetch' })), 'ambiguous');
  const b = autoReplyMessage(404, { error: 'unknown page 2-99 in P' });
  assert.equal(b.kind, 'error');
  assert.match(b.title, /404.*unknown page/);
  assert.equal(autoOutcome(404, b), 'not-applied');
  assert.equal(autoReplyMessage(500, null).kind, 'error');
});

test('countsLine: nieznany krok — liczby po kolei', () => {
  assert.equal(countsLine('labels', { a: 1, b: 'x', c: 2 }), 'a 1, c 2');
  assert.equal(countsLine('gates', undefined), '');
});

// --- kolejka przeglądu ---

test('reviewQueue ①: bramki z src auto; niepewne (problem kroku) najpierw', () => {
  const p = mkPage();
  p.gates.push({ ref: 'M9', gate: 'A', x: 700, y: 100, rotation: 0, verified: false, note: null, src: 'auto', pins: [] });
  const q = reviewQueue(p, 'gates', [iss('GATES_UNVERIFIED', 'info'), iss('GATE_UNKNOWN_REF', 'err', { ref: 'M9' })]);
  assert.deepEqual(q.map((i) => i.key), ['g0', 'g3']); // GATE_UNKNOWN_REF to ② — nie flaguje ①
  assert.deepEqual(q[0]!.select, { kind: 'gate', idx: 0 });
  assert.deepEqual(q[0]!.box, { x: 50, y: 40, w: 100, h: 120 });
  const t = reviewQueue(p, 'text', [iss('GATE_PIN_INVALID', 'err', { ref: 'M3.A' })]);
  assert.deepEqual(t.map((i) => i.key), ['g2']);
  assert.deepEqual(t[0]!.flags, ['GATE_PIN_INVALID']);
  assert.match(t[0]!.label, /M3\.A · piny auto: 1/);
});

test('reviewQueue ③: odcinki i kropki auto; krótkie i styk T bez kropki najpierw', () => {
  const p = mkPage({
    nets: {
      A: {
        pins: [],
        segments: [[0, 0, 100, 0], [50, 0, 50, 60], [200, 0, 205, 0], [300, 0, 400, 0]],
        junctions: [[300, 0]],
        auto_segments: [[0, 0, 100, 0], [50, 0, 50, 60], [200, 0, 205, 0]],
        auto_junctions: [[300, 0]],
      },
      B: { pins: [], segments: [[350, 0, 350, 50]], junctions: null },
    },
  });
  const q = reviewQueue(p, 'wires');
  assert.deepEqual(q.map((i) => i.key), ['s:A:1', 's:A:2', 's:A:0', 'j:A:0']);
  assert.match(q[0]!.flags[0]!, /styk T bez kropki \(50,0\)/);
  assert.match(q[1]!.flags[0]!, /krótki \(5 px\)/);
  assert.deepEqual(q[2]!.flags, []);
  assert.deepEqual(q[0]!.select, { kind: 'segment', netName: 'A', segmentIdx: 1 });
  assert.deepEqual(q[3]!.select, { kind: 'net', name: 'A' });
});

test('wireFlags: kropka przy styku zdejmuje flagę; koniec do końca to nie styk T', () => {
  const a: [number, number, number, number] = [0, 0, 100, 0];
  const b: [number, number, number, number] = [50, 0, 50, 60];
  assert.deepEqual(wireFlags(b, [a, b], [[50, 0]]), []);
  const c: [number, number, number, number] = [100, 0, 100, 50];
  assert.deepEqual(wireFlags(c, [a, c], []), []);
});

test('reviewQueue ④ / ⑤: etykiety po src, nety końcówek po net_src', () => {
  const p = mkPage({
    ports: [
      { connector: 'A', pin: 1, label: 'X', net: 'N1', x: 10, y: 10, side: 'left', src: 'auto' },
      { connector: 'B', pin: 2, label: 'Y', net: 'N2', x: 10, y: 50, side: 'left', net_src: 'auto' },
    ],
    cross_refs: [{ label: 'S', pages: ['3'], net: 'N1', x: 900, y: 10, side: 'right', src: 'auto' }],
    power: [{ type: '+5V', x: 5, y: 5, net: '+5V', src: 'auto', net_src: 'auto' }],
  } as Partial<Page>);
  assert.deepEqual(reviewQueue(p, 'labels', [iss('PORT_NOT_ON_BACKPLANE', 'warn', { ref: 'A1' })]).map((i) => [i.key, i.flags]), [
    ['o0', ['PORT_NOT_ON_BACKPLANE']],
    ['x0', []],
    ['w0', []],
  ]);
  assert.deepEqual(reviewQueue(p, 'nets', [iss('NET_FLOATING', 'err', { ref: 'N2' })]).map((i) => [i.key, i.flags]), [
    ['o1', ['NET_FLOATING']],
    ['p2:0', []],
    ['w0', []],
  ]);
});

test('stepCounts: elementy kroku, auto i ludzkie', () => {
  const p = mkPage({ nets: { A: { pins: [], segments: [[0, 0, 1, 0], [1, 0, 2, 0]], junctions: null, auto_segments: [[1, 0, 2, 0]] } } });
  assert.deepEqual(stepCounts(p, 'gates'), { total: 3, auto: 1, edited: 2 });
  assert.deepEqual(stepCounts(p, 'text'), { total: 4, auto: 2, edited: 2 });
  assert.deepEqual(stepCounts(p, 'wires'), { total: 2, auto: 1, edited: 1 });
  assert.deepEqual(stepCounts(p, 'nets'), { total: 1, auto: 1, edited: 0 });
});

test('stepQueueIndex: N / Shift+N z zawinięciem', () => {
  assert.equal(stepQueueIndex(0, -1, 1), -1);
  assert.equal(stepQueueIndex(3, -1, 1), 0);
  assert.equal(stepQueueIndex(3, -1, -1), 2);
  assert.equal(stepQueueIndex(3, 2, 1), 0);
  assert.equal(stepQueueIndex(3, 0, -1), 2);
});

// --- edycja w kroku (poprawki z przeglądu) ---

test('canEditElement: tylko aspekt bieżącego kroku; kontekst do odczytu; ⑥ nic; bez kroku wszystko', () => {
  assert.equal(canEditElement('gates', 'gate', 'box'), true);
  assert.equal(canEditElement('gates', 'gate'), true); // podstawowy aspekt bramki = ramka
  assert.equal(canEditElement('text', 'gate', 'box'), false); // ramka w ② to kontekst
  assert.equal(canEditElement('wires', 'gate', 'box'), false);
  assert.equal(canEditElement('text', 'gate', 'text'), true);
  assert.equal(canEditElement('text', 'pin'), true);
  assert.equal(canEditElement('wires', 'pin', 'text'), false); // pin w ③ to kontekst
  assert.equal(canEditElement('nets', 'pin', 'net'), true);
  assert.equal(canEditElement('wires', 'segment'), true);
  assert.equal(canEditElement('labels', 'segment'), false); // druty w ④ / ⑤ do odczytu
  assert.equal(canEditElement('nets', 'segment', 'geom'), false);
  assert.equal(canEditElement('labels', 'port'), true);
  assert.equal(canEditElement('nets', 'port'), false);
  assert.equal(canEditElement('nets', 'port', 'net'), true);
  assert.equal(canEditElement('gates', 'annotation'), false);
  assert.equal(canEditElement(null, 'annotation'), true);
  assert.equal(canEditElement(null, 'gate', 'box'), true);
  assert.equal(canEditElement('kicad', 'gate', 'box'), false);
  assert.equal(aspectStep('decoration'), null);
  assert.equal(aspectStep('cross_ref', 'net'), 'nets');
});

test('panelEditable / editStepFor: panel zaznaczenia i krok do przełączenia', () => {
  assert.equal(panelEditable('gates', 'gate'), true);
  assert.equal(panelEditable('text', 'gate'), true);
  assert.equal(panelEditable('wires', 'gate'), false);
  assert.equal(panelEditable('nets', 'gate'), true); // nety pinów
  assert.equal(panelEditable('labels', 'gate'), false);
  assert.equal(panelEditable('wires', 'segment'), true);
  assert.equal(panelEditable('nets', 'segment'), false);
  assert.equal(panelEditable('wires', 'net'), true);
  assert.equal(panelEditable('nets', 'net'), true);
  assert.equal(panelEditable('labels', 'net'), false);
  assert.equal(panelEditable('labels', 'port'), true);
  assert.equal(panelEditable('nets', 'cross_ref'), true);
  assert.equal(panelEditable('gates', 'power'), false);
  assert.equal(panelEditable('wires', 'annotation'), false);
  assert.equal(panelEditable(null, 'annotation'), true);
  assert.equal(panelEditable('kicad', 'net'), false);
  assert.equal(editStepFor('gate'), 'gates');
  assert.equal(editStepFor('segment'), 'wires');
  assert.equal(editStepFor('port'), 'labels');
  assert.equal(editStepFor('annotation'), null);
});

test('rubberBand: tylko elementy edytowalne w kroku; w ④ porty mimo bramek w prostokącie', () => {
  const p = mkPage({
    ports: [{ connector: 'A', pin: 1, label: 'X', net: '', x: 120, y: 120, side: 'left' }],
    cross_refs: [{ label: 'S', pages: [], net: '', x: 130, y: 130, side: 'left' }],
  } as Partial<Page>);
  const r = { x: 0, y: 0, w: 200, h: 200 };
  assert.deepEqual(rubberBand(p, r, null), { kind: 'gate', indices: [0] });
  assert.deepEqual(rubberBand(p, r, 'gates'), { kind: 'gate', indices: [0] });
  assert.deepEqual(rubberBand(p, r, 'labels'), { kind: 'port', indices: [0] });
  assert.equal(rubberBand(p, r, 'wires'), null);
  assert.equal(rubberBand(p, r, 'text'), null); // ramki w ② tylko do odczytu
  assert.deepEqual(rubberBand(mkPage({ cross_refs: [{ label: 'S', pages: [], net: '', x: 5, y: 5, side: 'left' }] } as Partial<Page>), { x: 0, y: 0, w: 10, h: 10 }, 'labels'), { kind: 'cross_ref', indices: [0] });
});

test('pageActionAllowed: cleanup w ③ / ⑤ / bez kroku; vision i .bak tylko bez kroku', () => {
  assert.equal(pageActionAllowed(null, 'vision'), true);
  assert.equal(pageActionAllowed(null, 'restore-bak'), true);
  assert.equal(pageActionAllowed('wires', 'cleanup'), true);
  assert.equal(pageActionAllowed('nets', 'cleanup'), true);
  assert.equal(pageActionAllowed('gates', 'cleanup'), false);
  assert.equal(pageActionAllowed('wires', 'make-bak'), false);
  assert.equal(pageActionAllowed('gates', 'vision'), false);
});

test('shouldRefreshPackage: tylko gdy nadal widok tego pakietu', () => {
  assert.equal(shouldRefreshPackage({ mode: 'package', pkg: 'P-R3-2' }, 'P-R3-2'), true);
  assert.equal(shouldRefreshPackage({ mode: 'package', pkg: 'P-A3-2' }, 'P-R3-2'), false);
  assert.equal(shouldRefreshPackage({ mode: 'page', pkg: 'P-R3-2', page: '2-58' }, 'P-R3-2'), false);
  assert.equal(shouldRefreshPackage({ mode: 'module' }, 'P-R3-2'), false);
});

test('freshStoredResult: ta sama strona i nie starszy niż 10 min', () => {
  const msg = autoReplyMessage(200, { pages: [] });
  const raw = (path: string, at: number) => JSON.stringify({ pagePath: path, step: 'gates', msg, at });
  const now = 1_000_000_000;
  assert.equal(freshStoredResult(raw('A', now - 1000), 'A', now)?.step, 'gates');
  assert.equal(freshStoredResult(raw('B', now - 1000), 'A', now), null);
  assert.equal(freshStoredResult(raw('A', now - STORED_RESULT_MAX_AGE_MS - 1), 'A', now), null);
  assert.equal(freshStoredResult(raw('A', now + 5000), 'A', now), null);
  assert.equal(freshStoredResult(JSON.stringify({ pagePath: 'A', step: 'gates', msg }), 'A', now), null); // bez `at` (stary format)
  assert.equal(freshStoredResult('{zły', 'A', now), null);
  assert.equal(freshStoredResult(null, 'A', now), null);
});

test('paleta: kolory stanów kroków z PROV_COLORS', () => {
  assert.equal(STATUS_COLOR.auto, PROV_COLORS.auto);
  assert.equal(STATUS_COLOR.approved, PROV_COLORS.approved);
  assert.equal(STATUS_COLOR.todo, PROV_COLORS.todo);
});

test('fieldEditable: pola panelu zaznaczenia per aspekt', () => {
  // bramka: ① tylko ramka (obrót); ② tekst i NC; ⑤ tylko nety pinów
  assert.equal(fieldEditable('gates', 'gate', 'rotation'), true);
  assert.equal(fieldEditable('gates', 'gate', 'ref'), false);
  assert.equal(fieldEditable('gates', 'gate', 'pinNet'), false);
  assert.equal(fieldEditable('text', 'gate', 'ref'), true);
  assert.equal(fieldEditable('text', 'gate', 'gate'), true);
  assert.equal(fieldEditable('text', 'gate', 'ic'), true);
  assert.equal(fieldEditable('text', 'gate', 'value'), true);
  assert.equal(fieldEditable('text', 'gate', 'rotation'), false);
  assert.equal(fieldEditable('text', 'gate', 'nc'), true); // NC = tekst pinu (pinTextKey)
  assert.equal(fieldEditable('nets', 'gate', 'pinNet'), true);
  assert.equal(fieldEditable('nets', 'gate', 'nc'), false);
  assert.equal(fieldEditable('nets', 'gate', 'ref'), false);
  // port / odsyłacz / zasilanie: ④ etykieta i usuń, ⑤ tylko net
  for (const k of ['port', 'cross_ref', 'power'] as const) {
    assert.equal(fieldEditable('labels', k, 'label'), true);
    assert.equal(fieldEditable('labels', k, 'delete'), true);
    assert.equal(fieldEditable('labels', k, 'net'), false);
    assert.equal(fieldEditable('nets', k, 'net'), true);
    assert.equal(fieldEditable('nets', k, 'label'), false);
    assert.equal(fieldEditable('nets', k, 'delete'), false);
  }
  assert.equal(fieldEditable('wires', 'segment', 'delete'), true);
  assert.equal(fieldEditable('nets', 'segment', 'delete'), false);
  assert.equal(fieldEditable(null, 'annotation', 'text'), true);
  assert.equal(fieldEditable('gates', 'annotation', 'text'), false);
  assert.equal(fieldAspect('gate', 'delete'), 'box');
  assert.equal(fieldAspect('annotation', 'text'), undefined);
});
