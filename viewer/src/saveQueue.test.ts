// Run: npm test -w viewer (node --test --experimental-strip-types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSaveQueue,
  rewriteOutcomeFor,
  type RewriteDeps,
  type RewriteOutcome,
  type SaveStatus,
  type SendOptions,
} from './saveQueue.ts';

// --- harness: manual timers + send() whose promises the test settles --------

interface FakeTimer { fn: () => void; ms: number; live: boolean }
interface Call {
  path: string;
  body: string;
  opts: SendOptions;
  resolve: () => void;
  reject: (e: Error) => void;
}

function harness(opts: { autoResolve?: boolean; failPaths?: Set<string> } = {}) {
  const timers: FakeTimer[] = [];
  const calls: Call[] = [];
  const statuses: Array<[SaveStatus, string | null]> = [];
  const q = createSaveQueue({
    send(path, body, o) {
      return new Promise<void>((resolve, reject) => {
        calls.push({ path, body, opts: o, resolve, reject });
        if (opts.failPaths?.has(path)) reject(new Error(`PUT ${path} → 500`));
        else if (opts.autoResolve) resolve();
      });
    },
    setTimer(fn, ms) {
      const t: FakeTimer = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer(h) {
      (h as FakeTimer).live = false;
    },
    delayMs: 500,
    onStatus: (s, e) => statuses.push([s, e]),
  });
  const liveTimers = () => timers.filter((t) => t.live);
  // "500 ms pass": fire every live timer once.
  const tick = () => {
    for (const t of liveTimers()) {
      t.live = false;
      t.fn();
    }
  };
  return { q, calls, timers, liveTimers, tick, statuses };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

// --- tests -------------------------------------------------------------------

test('nothing pending → flush resolves immediately, nothing sent', async () => {
  const h = harness();
  assert.equal(h.q.isDirty(), false);
  await h.q.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.q.status(), 'idle');
});

test('schedule debounces: nothing sent until the timer fires', async () => {
  const h = harness({ autoResolve: true });
  h.q.schedule('a.yaml', 'v1');
  await settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.liveTimers().length, 1);
  assert.equal(h.liveTimers()[0]!.ms, 500);
  h.tick();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.q.isDirty(), false);
});

test('two edits to one path within the debounce → one PUT with the latest body', async () => {
  const h = harness({ autoResolve: true });
  h.q.schedule('a.yaml', 'v1');
  h.q.schedule('a.yaml', 'v2');
  assert.equal(h.liveTimers().length, 1, 'first timer was cancelled');
  h.tick();
  await settle();
  assert.deepEqual(h.calls.map((c) => [c.path, c.body]), [['a.yaml', 'v2']]);
});

test('separate paths keep separate debounce timers', async () => {
  const h = harness({ autoResolve: true });
  h.q.schedule('a.yaml', 'A');
  h.q.schedule('b.yaml', 'B');
  assert.equal(h.liveTimers().length, 2);
  h.tick();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.body).sort(), ['A', 'B']);
});

test('flush sends the queued PUT immediately and cancels its timer', async () => {
  const h = harness({ autoResolve: true });
  h.q.schedule('a.yaml', 'v1');
  await h.q.flush();
  assert.deepEqual(h.calls.map((c) => c.body), ['v1']);
  assert.equal(h.liveTimers().length, 0, 'debounce timer cancelled');
  h.tick(); // even if a stale timer fired, nothing more is sent
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.q.isDirty(), false);
});

test('flush waits for a PUT already in flight', async () => {
  const h = harness();
  h.q.schedule('a.yaml', 'v1');
  h.tick(); // PUT in flight, unresolved
  await settle();
  assert.equal(h.calls.length, 1);
  let done = false;
  const f = h.q.flush().then(() => { done = true; });
  await settle();
  assert.equal(done, false, 'flush must not resolve while the PUT is in flight');
  h.calls[0]!.resolve();
  await f;
  assert.equal(done, true);
});

test('flush rejects when a PUT fails; status error; dirty until retried', async () => {
  const h = harness();
  h.q.schedule('a.yaml', 'v1');
  const f = h.q.flush();
  await settle();
  h.calls[0]!.reject(new Error('PUT a.yaml → 500'));
  await assert.rejects(f, /PUT a\.yaml → 500/);
  assert.equal(h.q.status(), 'error');
  assert.equal(h.q.isDirty(), true, 'failed body still counts as unsaved');
  assert.deepEqual(h.statuses.at(-1), ['error', 'PUT a.yaml → 500']);

  // next flush retries the failed body
  const f2 = h.q.flush();
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.body, 'v1');
  h.calls[1]!.resolve();
  await f2;
  assert.equal(h.q.isDirty(), false);
  assert.equal(h.q.status(), 'idle');
});

test('a newer edit supersedes a failed body', async () => {
  const h = harness();
  h.q.schedule('a.yaml', 'v1');
  h.tick();
  await settle();
  h.calls[0]!.reject(new Error('boom'));
  await settle();
  assert.equal(h.q.status(), 'error');
  h.q.schedule('a.yaml', 'v2');
  const f = h.q.flush();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.body), ['v1', 'v2']);
  h.calls[1]!.resolve();
  await f;
  assert.equal(h.q.isDirty(), false);
});

test('isDirty: true while pending and while in flight, false after', async () => {
  const h = harness();
  assert.equal(h.q.isDirty(), false);
  h.q.schedule('a.yaml', 'v1');
  assert.equal(h.q.isDirty(), true);
  assert.equal(h.q.status(), 'pending');
  h.tick();
  await settle();
  assert.equal(h.q.isDirty(), true);
  assert.equal(h.q.status(), 'saving');
  h.calls[0]!.resolve();
  await settle();
  assert.equal(h.q.isDirty(), false);
  assert.equal(h.q.status(), 'idle');
  assert.deepEqual(h.statuses.map((s) => s[0]), ['pending', 'saving', 'idle']);
});

test('PUTs to one path are serialised: second waits for the first', async () => {
  const h = harness();
  h.q.schedule('a.yaml', 'v1');
  h.tick();
  h.q.schedule('a.yaml', 'v2');
  h.tick();
  await settle();
  assert.equal(h.calls.length, 1, 'v2 not sent while v1 in flight');
  h.calls[0]!.resolve();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.body), ['v1', 'v2']);
  h.calls[1]!.resolve();
  await settle();
  assert.equal(h.q.isDirty(), false);
});

test('flushNow fires pending with keepalive and does not wait', async () => {
  const h = harness();
  h.q.schedule('a.yaml', 'v1');
  h.q.flushNow({ keepalive: true });
  await settle();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.opts, { keepalive: true });
  assert.equal(h.liveTimers().length, 0);
  assert.equal(h.q.isDirty(), true, 'still in flight');
  h.calls[0]!.resolve();
  await settle();
  assert.equal(h.q.isDirty(), false);
});

test('continuous edits during flush are flushed too, in order', async () => {
  const h = harness();
  h.q.schedule('a.yaml', 'v1');
  h.tick();
  let done = false;
  const f = h.q.flush().then(() => { done = true; });
  await settle();
  h.q.schedule('a.yaml', 'v2'); // edit while flush is waiting
  h.calls[0]!.resolve();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.body), ['v1', 'v2'], 'v2 sent by flush, not by the timer');
  assert.equal(done, false, 'flush still waits for v2');
  h.calls[1]!.resolve();
  await f;
  assert.equal(h.q.isDirty(), false);
});

test('failed + discard → not dirty, flush sends nothing', async () => {
  const h = harness({ failPaths: new Set(['a.yaml']) });
  h.q.schedule('a.yaml', 'v1');
  await assert.rejects(h.q.flush());
  assert.equal(h.q.isDirty(), true);
  h.q.discard('a.yaml');
  assert.equal(h.q.isDirty(), false);
  assert.equal(h.q.status(), 'idle');
  await h.q.flush();
  assert.equal(h.calls.length, 1, 'failed body not retried after discard');
});

test('discard drops a body chained behind an in-flight PUT', async () => {
  const h = harness();
  h.q.schedule('a.yaml', 'v1');
  h.tick(); // v1 in flight
  await settle();
  h.q.schedule('a.yaml', 'v2');
  h.tick(); // v2 chained after v1
  h.q.discard('a.yaml');
  assert.equal(h.calls.length, 1);
  h.calls[0]!.resolve();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.body), ['v1'], 'v2 never sent');
  assert.equal(h.q.isDirty(), false);
});

// --- fence / runRewrite ------------------------------------------------------

test('fence: flush does not send a newly scheduled body for the fenced path', async () => {
  const h = harness({ autoResolve: true });
  h.q.fence('page.yaml');
  h.q.schedule('page.yaml', 'stale');
  h.q.schedule('other.yaml', 'o1');
  await h.q.flush();
  assert.deepEqual(h.calls.map((c) => c.path), ['other.yaml']);
  h.tick();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.q.isDirty(), true, 'kept-aside body counts as unsaved');
  assert.deepEqual(h.q.dirtyPaths(), ['page.yaml']);
});

test('fence: flushNow (beforeunload keepalive) skips the fenced path', async () => {
  const h = harness({ autoResolve: true });
  h.q.fence('page.yaml');
  h.q.schedule('page.yaml', 'stale');
  h.q.schedule('other.yaml', 'o1');
  h.q.flushNow({ keepalive: true });
  await settle();
  assert.deepEqual(h.calls.map((c) => [c.path, c.opts.keepalive]), [['other.yaml', true]]);
});

test('rewriteOutcomeFor: 2xx+JSON ok, 4xx not applied, 5xx / bad JSON ambiguous', () => {
  assert.equal(rewriteOutcomeFor(200, true), 'ok');
  assert.equal(rewriteOutcomeFor(200, false), 'ambiguous');
  assert.equal(rewriteOutcomeFor(404, true), 'not-applied');
  assert.equal(rewriteOutcomeFor(400, false), 'not-applied');
  assert.equal(rewriteOutcomeFor(500, true), 'ambiguous');
  assert.equal(rewriteOutcomeFor(502, false), 'ambiguous');
});

function rewriteHarness(confirmAnswer = true) {
  let resolveAction: (o: RewriteOutcome) => void = () => {};
  let rejectAction: (e: Error) => void = () => {};
  const log = { reloads: 0, alerts: [] as string[], confirms: [] as string[], actionRuns: 0 };
  const deps: RewriteDeps = {
    name: 'Przywracanie .bak',
    action: () => {
      log.actionRuns++;
      return new Promise<RewriteOutcome>((res, rej) => { resolveAction = res; rejectAction = rej; });
    },
    reload: () => { log.reloads++; },
    alert: (m) => { log.alerts.push(m); },
    confirm: (m) => { log.confirms.push(m); return confirmAnswer; },
  };
  return {
    deps,
    log,
    outcome: (o: RewriteOutcome) => resolveAction(o),
    fail: () => rejectAction(new Error('network')),
  };
}

// Old behaviour (store.ts before kr-pfj.1): Toolbar.restoreBak POSTed
// /restore-bak and reloaded with the 500 ms timer still armed, and nothing
// stopped edits made during the POST from being sent — the edit's PUT fired
// AFTER the restore and overwrote it. On that code the "fenced" and final
// assertions fail: a 2nd PUT with a stale body goes out.
test('restore race: no stale page PUT can land after a successful rewrite', async () => {
  const h = harness({ autoResolve: true });
  const r = rewriteHarness();
  h.q.schedule('page.yaml', 'edit-1');
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  assert.deepEqual(h.calls.map((c) => c.body), ['edit-1'], 'pre-flush sent the edit');
  assert.equal(r.log.actionRuns, 1);
  h.q.schedule('page.yaml', 'edit-2'); // edit while the POST runs
  h.tick();
  await settle();
  assert.equal(h.calls.length, 1, 'fenced: nothing sent during the POST');
  r.outcome('ok');
  assert.equal(await run, 'reloaded');
  assert.equal(r.log.reloads, 1);
  assert.equal(r.log.confirms.length, 0);
  h.q.schedule('page.yaml', 'edit-3'); // edit between reload() and unload
  h.tick();
  await h.q.flush();
  h.q.flushNow({ keepalive: true });
  await settle();
  assert.equal(h.calls.length, 1, 'no PUT lands after the restore');
});

test('rewrite: pre-flush fails → alert, action not run, nothing fenced', async () => {
  const fail = new Set(['page.yaml']);
  const h = harness({ autoResolve: true, failPaths: fail });
  const r = rewriteHarness();
  h.q.schedule('page.yaml', 'edit-1');
  assert.equal(await h.q.runRewrite('page.yaml', r.deps), 'not-started');
  assert.equal(r.log.actionRuns, 0);
  assert.equal(r.log.alerts.length, 1);
  assert.match(r.log.alerts[0]!, /nie została uruchomiona/);
  fail.clear();
  await h.q.flush(); // not fenced: the failed body is retried normally
  assert.deepEqual(h.calls.map((c) => c.body), ['edit-1', 'edit-1']);
  assert.equal(h.q.isDirty(), false);
});

test('rewrite not applied (4xx) → fenced edit resumed, other path sent normally', async () => {
  const h = harness({ autoResolve: true });
  const r = rewriteHarness();
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  h.q.schedule('page.yaml', 'p1');
  h.q.schedule('other.yaml', 'o1');
  h.tick();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.path), ['other.yaml'], 'other path is not held');
  r.outcome('not-applied');
  assert.equal(await run, 'not-applied');
  assert.equal(r.log.reloads, 0);
  h.tick();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.body), ['o1', 'p1'], 'page edit resumed after unfence');
  assert.equal(h.q.isDirty(), false);
});

test('rewrite ambiguous (throw/5xx) → fenced path never resent, error shown, others resent', async () => {
  const h = harness({ autoResolve: true });
  const r = rewriteHarness();
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  h.q.schedule('page.yaml', 'p1');
  r.fail();
  assert.equal(await run, 'ambiguous');
  assert.equal(r.log.reloads, 0);
  h.q.schedule('page.yaml', 'p2');
  h.q.schedule('other.yaml', 'o1');
  h.tick();
  await h.q.flush();
  h.q.flushNow({ keepalive: true });
  await settle();
  assert.deepEqual(h.calls.map((c) => c.path), ['other.yaml']);
  assert.equal(h.q.status(), 'error');
  assert.deepEqual(h.statuses.at(-1), [
    'error',
    'Przywracanie .bak mogło się częściowo udać — przeładuj stronę; niezapisane zmiany tej strony nie zostały wysłane',
  ]);
  assert.equal(h.q.isDirty(), true, 'beforeunload warns: page edits unsent');
});

test('rewrite ok but another path fails to flush → confirm lists it, then reload', async () => {
  const fail = new Set<string>();
  const h = harness({ autoResolve: true, failPaths: fail });
  const r = rewriteHarness(true);
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  fail.add('other.yaml');
  h.q.schedule('other.yaml', 'o1');
  h.q.schedule('page.yaml', 'stale');
  r.outcome('ok');
  assert.equal(await run, 'reloaded');
  assert.equal(r.log.confirms.length, 1);
  assert.match(r.log.confirms[0]!, /other\.yaml/);
  assert.doesNotMatch(r.log.confirms[0]!, /page\.yaml/);
  assert.equal(r.log.reloads, 1);
  assert.equal(h.q.isDirty(), false, 'user accepted the loss → no 2nd beforeunload prompt');
  assert.ok(!h.calls.some((c) => c.path === 'page.yaml'), 'stale page never sent');
});

test('rewrite ok, other path fails, user stays → no reload, page stays fenced', async () => {
  const fail = new Set<string>();
  const h = harness({ autoResolve: true, failPaths: fail });
  const r = rewriteHarness(false);
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  fail.add('other.yaml');
  h.q.schedule('other.yaml', 'o1');
  r.outcome('ok');
  assert.equal(await run, 'reload-declined');
  assert.equal(r.log.reloads, 0);
  // reviewer scenario: the next edit of the (now stale) page must not be PUT
  h.q.schedule('page.yaml', 'stale-edit');
  h.tick();
  await h.q.flush().catch(() => {});
  h.q.flushNow({ keepalive: true });
  await settle();
  assert.ok(!h.calls.some((c) => c.path === 'page.yaml'), 'stale page never sent');
  assert.equal(h.q.status(), 'error');
  assert.match(h.statuses.at(-1)![1]!, /przeładuj stronę/);
});

test('re-entrancy: after an ambiguous rewrite a 2nd rewrite on the path is refused', async () => {
  const h = harness({ autoResolve: true });
  const r = rewriteHarness();
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  r.fail();
  assert.equal(await run, 'ambiguous');
  h.q.schedule('page.yaml', 'kept'); // edit against a possibly rewritten file
  const r2 = rewriteHarness();
  assert.equal(await h.q.runRewrite('page.yaml', r2.deps), 'not-started');
  assert.equal(r2.log.actionRuns, 0, 'a 4xx from a 2nd POST cannot unfence the kept body');
  assert.deepEqual(r2.log.alerts, ['Strona czeka na przeładowanie po poprzedniej operacji — przeładuj stronę.']);
  h.tick();
  await h.q.flush();
  assert.equal(h.calls.length, 0, 'kept body never sent');
});

test('re-entrancy: concurrent rewrites on one path → the 2nd is refused (pre-flush and POST phase)', async () => {
  const h = harness();
  h.q.schedule('page.yaml', 'edit-1');
  const r1 = rewriteHarness();
  const run1 = h.q.runRewrite('page.yaml', r1.deps); // pre-flush: PUT in flight, unresolved
  await settle();
  const r2 = rewriteHarness();
  assert.equal(await h.q.runRewrite('page.yaml', r2.deps), 'not-started', 'refused during pre-flush');
  h.calls[0]!.resolve();
  await settle();
  assert.equal(r1.log.actionRuns, 1);
  const r3 = rewriteHarness();
  assert.equal(await h.q.runRewrite('page.yaml', r3.deps), 'not-started', 'refused during the POST');
  assert.equal(r2.log.actionRuns + r3.log.actionRuns, 0);
  r1.outcome('not-applied');
  assert.equal(await run1, 'not-applied');
  // path is free again after a clean not-applied
  const r4 = rewriteHarness();
  const run4 = h.q.runRewrite('page.yaml', r4.deps);
  await settle();
  assert.equal(r4.log.actionRuns, 1);
  r4.outcome('not-applied');
  await run4;
});

test('status: a body kept aside on a fenced path is never reported idle', async () => {
  const h = harness({ autoResolve: true });
  const r = rewriteHarness();
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  assert.equal(h.q.status(), 'idle', 'fenced, nothing kept');
  h.q.schedule('page.yaml', 'kept');
  assert.equal(h.q.status(), 'pending');
  r.outcome('not-applied');
  await run;
  h.tick();
  await settle();
  assert.equal(h.q.status(), 'idle');
});

test('rewrite ok → before reload the page shows an error (user may "Stay" in beforeunload)', async () => {
  const h = harness({ autoResolve: true });
  const r = rewriteHarness();
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  r.outcome('ok');
  assert.equal(await run, 'reloaded');
  const stale = 'Przywracanie .bak: plik zmieniony na serwerze — przeładuj stronę; zmiany tej strony nie są zapisywane';
  assert.deepEqual(h.statuses.at(-1), ['error', stale]);
  assert.equal(h.q.isDirty(), false, 'nothing to warn about on our own reload');
  // user clicked "Stay" and keeps editing: not silent, not sent
  h.q.schedule('page.yaml', 'after-stay');
  h.tick();
  await h.q.flush();
  assert.equal(h.q.status(), 'error');
  assert.equal(h.calls.length, 0);
});

test('page edit during the post-rewrite flush (other PUT in flight) is not sent', async () => {
  const h = harness();
  const r = rewriteHarness();
  const run = h.q.runRewrite('page.yaml', r.deps);
  await settle();
  h.q.schedule('other.yaml', 'o1');
  r.outcome('ok');
  await settle();
  assert.deepEqual(h.calls.map((c) => c.path), ['other.yaml'], 'post-rewrite flush sends other.yaml');
  h.q.schedule('page.yaml', 'stale'); // while that PUT is in flight
  h.calls[0]!.resolve();
  assert.equal(await run, 'reloaded');
  assert.equal(r.log.reloads, 1);
  h.tick();
  h.q.flushNow({ keepalive: true });
  await settle();
  assert.ok(!h.calls.some((c) => c.path === 'page.yaml'), 'no page PUT');
  assert.equal(h.q.isDirty(), false, 'kept stale body discarded before reload');
});
