// runScript (kr-0sn.7) and POST /auto (kr-9p8.19).
// Run: npm test -w server
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn, spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createHash } from 'node:crypto';

import {
  createApp, parseLastJson, PARSE_LAST_JSON_TRIES, autoPageTimeout, SCRIPT_TIMEOUTS,
  defaultUvCacheDir, LLM_UV_CACHE, AUTO_VLM_WITH,
} from '../index.js';

const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
console.warn = () => {};
after(() => { console.log = origLog; console.warn = origWarn; });

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const H = { 'X-Kronikarz': '1', 'Content-Type': 'application/json' };
const PKG = 'P-T';
const PAGE_V = 'p1\n';
const sha1Tag = (s) => `"${createHash('sha1').update(s).digest('hex')}"`;

// --- fake child process -------------------------------------------------------

class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.written = [];
    this.stdin.write = (d) => { this.stdin.written.push(String(d)); return true; };
    this.stdin.end = () => {};
    this.killed = [];
    this.onKill = (sig) => this.close(null, sig); // default: dies on any signal
  }
  kill(sig) { this.killed.push(sig); this.onKill(sig); return true; }
  close(code, sig = null) { setImmediate(() => this.emit('close', code, sig)); }
  reply(stdout, code = 0, stderr = '') {
    setImmediate(() => {
      if (stderr) this.stderr.emit('data', Buffer.from(stderr));
      if (stdout) this.stdout.emit('data', Buffer.from(stdout));
      this.emit('close', code, null);
    });
  }
}

let calls; // [{cmd, args, opts, proc}]
let behave; // (proc, args) => void — what the next spawned "script" does
function fakeSpawn(cmd, args, opts) {
  const proc = new FakeProc();
  calls.push({ cmd, args, opts, proc });
  behave(proc, args);
  return proc;
}
const fakeUv = (args) => ({ cmd: 'fake-uv', args });
const replyWith = (stdout, code = 0, stderr = '') => (p) => p.reply(stdout, code, stderr);
const hang = () => {};

// --- fixture data root -------------------------------------------------------

let parent;
let root;
let server;
let base;

async function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function withServer(opts, fn) {
  const s = await listen(createApp({ root, spawn: fakeSpawn, uvCommand: fakeUv, killGraceMs: 50, ...opts }));
  try {
    return await fn(`http://127.0.0.1:${s.address().port}`);
  } finally {
    await new Promise((r) => s.close(r));
  }
}

const PROJECT = `kronikarz: "1"\nproject:\n  name: MJC-400\npackages:\n- id: ${PKG}\n  file: ${PKG}/package.yaml\n`;
const PACKAGE = `kronikarz: "1"
package:
  id: ${PKG}
  pages:
    - id: p1
      file: pages/p1.sch.yaml
      scan: scans/p1.jpg
      sheet: 1
    - id: p2
      file: pages/p2.sch.yaml
      scan: scans/p2.jpg
      sheet: 2
`;

before(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kronikarz-jobs-'));
  root = path.join(parent, 'data');
  await fs.mkdir(root);
  server = await listen(createApp({
    root, spawn: fakeSpawn, uvCommand: fakeUv, killGraceMs: 50,
    scriptTimeouts: { visionPage: 2000, autoPerPage: 2000, autoPerPageStep: { text: 2000 } },
  }));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(parent, { recursive: true, force: true });
});

beforeEach(async () => {
  calls = [];
  behave = replyWith('{"ok":true}');
  await fs.rm(path.join(root, 'MJC-400'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'OTHER'), { recursive: true, force: true });
  const pages = path.join(root, 'MJC-400', PKG, 'pages');
  await fs.mkdir(pages, { recursive: true });
  await fs.writeFile(path.join(root, 'MJC-400', 'project.yaml'), PROJECT);
  await fs.writeFile(path.join(root, 'MJC-400', PKG, 'package.yaml'), PACKAGE);
  await fs.writeFile(path.join(pages, 'p1.sch.yaml'), PAGE_V);
  await fs.writeFile(path.join(pages, 'p2.sch.yaml'), 'p2\n');
});

const pageFile = (p) => path.join(root, 'MJC-400', PKG, 'pages', `${p}.sch.yaml`);
const post = (u, body, b = base) => fetch(b + u, { method: 'POST', headers: H, body: JSON.stringify(body) });
const json = async (r) => ({ status: r.status, body: await r.json() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

// --- runScript: lock, timeout, abort, single reply, EPIPE ---------------------

test('runScript lock: second vision-page on the same page → 409 busy, no 2nd spawn, .bak untouched', async () => {
  behave = hang;
  const first = post('/vision-page', { package: PKG, page: 'p1' });
  await waitFor(() => calls.length === 1);
  const bak = pageFile('p1') + '.bak';
  assert.equal(await fs.readFile(bak, 'utf-8'), PAGE_V);
  await fs.writeFile(pageFile('p1'), 'changed meanwhile\n');

  const second = await json(await post('/vision-page', { package: PKG, page: 'p1' }));
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'busy');
  assert.equal(second.body.job.kind, 'vision-page');
  assert.equal(second.body.job.page, 'p1');
  assert.equal(calls.length, 1, 'no second process');
  assert.equal(await fs.readFile(bak, 'utf-8'), PAGE_V, 'refused click made no backup');

  // same page lock across kinds: /auto on p1 is refused too
  const viaAuto = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }));
  assert.equal(viaAuto.status, 409);
  assert.equal(viaAuto.body.job.kind, 'vision-page');

  calls[0].proc.reply('{"ok":true}');
  assert.equal((await first).status, 200);
  behave = replyWith('{"ok":true}');
  assert.equal((await post('/vision-page', { package: PKG, page: 'p1' })).status, 200, 'lock released');
});

test('runScript lock: different pages run in parallel', async () => {
  behave = hang;
  const a = post('/vision-page', { package: PKG, page: 'p1' });
  const b = post('/vision-page', { package: PKG, page: 'p2' });
  await waitFor(() => calls.length === 2);
  for (const c of calls) c.proc.reply('{"ok":true}');
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
});

test('runScript timeout: SIGTERM kills the process → 504, lock released', async () => {
  await withServer({ scriptTimeouts: { visionPage: 80 } }, async (b) => {
    behave = hang;
    const r = await json(await post('/vision-page', { package: PKG, page: 'p1' }, b));
    assert.equal(r.status, 504);
    assert.equal(r.body.error, 'timeout');
    assert.deepEqual(calls[0].proc.killed.slice(0, 1), ['SIGTERM']);
    behave = replyWith('{"ok":true}');
    assert.equal((await post('/vision-page', { package: PKG, page: 'p1' }, b)).status, 200);
  });
});

test('runScript timeout: process ignoring SIGTERM gets SIGKILL after the grace period', async () => {
  await withServer({ scriptTimeouts: { visionPage: 50 } }, async (b) => {
    behave = (p) => { p.onKill = (sig) => { if (sig === 'SIGKILL') p.close(null, 'SIGKILL'); }; };
    const r = await post('/vision-page', { package: PKG, page: 'p1' }, b);
    assert.equal(r.status, 504);
    assert.deepEqual(calls[0].proc.killed.slice(0, 2), ['SIGTERM', 'SIGKILL']);
  });
});

test('runScript timeout: a process that never exits is given up after SIGKILL + grace', async () => {
  await withServer({ scriptTimeouts: { visionPage: 30 } }, async (b) => {
    behave = (p) => { p.onKill = () => {}; };
    const r = await post('/vision-page', { package: PKG, page: 'p1' }, b);
    assert.equal(r.status, 504);
    assert.ok(calls[0].proc.killed.includes('SIGKILL'));
  });
});

test('runScript: client disconnect kills the process (SIGTERM, then SIGKILL to the group on exit), lock released', async () => {
  // Long timeout and grace: everything below must come from the abort alone.
  await withServer({ scriptTimeouts: { visionPage: 60_000 }, killGraceMs: 60_000 }, async (b) => {
    behave = hang;
    const ac = new AbortController();
    const t0 = Date.now();
    const p = fetch(`${b}/vision-page`, {
      method: 'POST', headers: H, body: JSON.stringify({ package: PKG, page: 'p1' }), signal: ac.signal,
    }).catch((e) => e);
    await waitFor(() => calls.length === 1);
    ac.abort();
    await p;
    await waitFor(() => calls[0].proc.killed.length >= 2);
    // SIGTERM from the abort; the fake dies on it; the SIGKILL is finish()'s
    // last shot at orphans of the group (not the grace timer: 60 s).
    assert.deepEqual(calls[0].proc.killed, ['SIGTERM', 'SIGKILL']);
    assert.ok(Date.now() - t0 < 5000);
    await sleep(20);
    const st = await json(await fetch(`${b}/auto/status`));
    assert.deepEqual(st.body, { running: false, jobs: [] });
    behave = replyWith('{"ok":true}');
    assert.equal((await post('/vision-page', { package: PKG, page: 'p1' }, b)).status, 200);
  });
});

test('runScript: a normal exit sends no extra signal', async () => {
  behave = replyWith('{"ok":true}');
  assert.equal((await post('/vision-page', { package: PKG, page: 'p1' })).status, 200);
  assert.deepEqual(calls[0].proc.killed, []);
});

test('runScript stuck: group still alive after SIGKILL + grace → 504 now, locks kept (stuck in status) until the group is gone', async () => {
  let alive = true;
  await withServer({ scriptTimeouts: { visionPage: 30 }, killGraceMs: 30, groupAlive: () => alive }, async (b) => {
    behave = (p) => { p.onKill = () => {}; }; // never exits
    const r = await json(await post('/vision-page', { package: PKG, page: 'p1' }, b));
    assert.equal(r.status, 504);
    assert.equal(r.body.stuck, true);
    const st = (await json(await fetch(`${b}/auto/status`))).body;
    assert.equal(st.running, true);
    assert.equal(st.jobs[0].stuck, true);
    const again = await json(await post('/vision-page', { package: PKG, page: 'p1' }, b));
    assert.equal(again.status, 409, 'locks kept while stuck');
    const put = await fetch(`${b}/files/MJC-400/${PKG}/pages/p1.sch.yaml`, { method: 'PUT', headers: { 'X-Kronikarz': '1' }, body: 'kronikarz: "1"\n' });
    assert.equal(put.status, 409, 'page still refused');
    alive = false; // the poll (every killGraceMs) sees the group gone
    await sleep(120);
    assert.deepEqual((await json(await fetch(`${b}/auto/status`))).body, { running: false, jobs: [] });
    behave = replyWith('{"ok":true}');
    assert.equal((await post('/vision-page', { package: PKG, page: 'p1' }, b)).status, 200);
  });
});

test('runScript stuck: released at once when the stuck process finally closes', async () => {
  await withServer({ scriptTimeouts: { visionPage: 30 }, killGraceMs: 30, groupAlive: () => true }, async (b) => {
    behave = (p) => { p.onKill = () => {}; };
    assert.equal((await post('/vision-page', { package: PKG, page: 'p1' }, b)).status, 504);
    assert.equal((await json(await fetch(`${b}/auto/status`))).body.running, true);
    calls[0].proc.emit('close', null, 'SIGKILL');
    await sleep(10);
    assert.equal((await json(await fetch(`${b}/auto/status`))).body.running, false);
  });
});

test('runScript: error followed by close → exactly one reply, server keeps running', async () => {
  behave = (p) => setImmediate(() => {
    p.emit('error', Object.assign(new Error('spawn fake-uv ENOENT'), { code: 'ENOENT' }));
    p.emit('close', -2, null);
  });
  const r = await json(await post('/vision-page', { package: PKG, page: 'p1' }));
  assert.equal(r.status, 500);
  assert.match(r.body.error, /^spawn: .*ENOENT/);
  await sleep(20);
  behave = replyWith('{"ok":true}');
  assert.equal((await post('/vision-page', { package: PKG, page: 'p1' })).status, 200, 'still alive, unlocked');
});

test('runScript: close followed by error (failed kill) → one reply', async () => {
  behave = (p) => setImmediate(() => {
    p.stdout.emit('data', Buffer.from('{"a":1}'));
    p.emit('close', 0, null);
    p.emit('error', new Error('kill EPERM'));
  });
  const r = await json(await post('/vision-page', { package: PKG, page: 'p1' }));
  assert.deepEqual(r, { status: 200, body: { a: 1 } });
  await sleep(20);
});

test('runScript: spawn throwing synchronously → 500, lock released', async () => {
  behave = () => { throw new Error('bad argv'); };
  const r = await json(await post('/vision-page', { package: PKG, page: 'p1' }));
  assert.equal(r.status, 500);
  assert.match(r.body.error, /bad argv/);
  behave = replyWith('{"ok":true}');
  assert.equal((await post('/vision-page', { package: PKG, page: 'p1' })).status, 200);
});

test('runScript: EPIPE on stdin of a dead child is absorbed; exit reported once', async () => {
  behave = (p) => {
    p.stdin.write = () => {
      process.nextTick(() => p.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      return false;
    };
    p.reply('', 1, 'died before reading stdin');
  };
  const r = await json(await post('/vision-page-zones', { package: PKG, page: 'p1', zones: [] }));
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'exit 1');
  assert.match(r.body.stderr, /died before reading/);
  await sleep(20);
});

test('runScript: stdin is passed and ended (ai-detect)', async () => {
  behave = replyWith('{"boxes":[]}');
  const r = await json(await post('/ai-detect', { package: PKG, page: 'p1', x: 1, y: 2, w: 3, h: 4 }));
  assert.deepEqual(r.body, { boxes: [] });
  assert.deepEqual(JSON.parse(calls[0].proc.stdin.written[0]), { package: PKG, page: 'p1', x: 1, y: 2, w: 3, h: 4 });
  assert.equal(calls[0].opts.detached, true, 'own process group');
});

test('runScript: stdout over the cap → 500 bad JSON (truncated), stderr keeps its tail', async () => {
  await withServer({ maxStdout: 10, maxStderr: 8 }, async (b) => {
    behave = replyWith('{"x":"0123456789"}', 0, 'AAAAAAAAAAtail1234');
    const r = await json(await post('/vision-page', { package: PKG, page: 'p1' }, b));
    assert.equal(r.status, 500);
    assert.equal(r.body.truncated, true);
    assert.equal(r.body.raw, '{"x":"0123');
    assert.equal(r.body.stderr, 'tail1234');
  });
});

test('/yolo-export: one export at a time', async () => {
  behave = hang;
  const a = post('/yolo-export', {});
  await waitFor(() => calls.length === 1);
  const b = await json(await post('/yolo-export', {}));
  assert.equal(b.status, 409);
  assert.equal(b.body.job.kind, 'yolo-export');
  calls[0].proc.reply('{"ok":true}');
  assert.equal((await a).status, 200);
});

test('runScript (real processes): timeout kills the whole group — child ignoring SIGTERM and its grandchild', async () => {
  const pidFile = path.join(parent, 'grandchild.pid');
  await fs.rm(pidFile, { force: true });
  // Child = stand-in for `uv run`: ignores SIGTERM, starts a grandchild (= python).
  const child = `
    process.on('SIGTERM', () => {});
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    setInterval(() => {}, 1000);`;
  let childPid;
  const spawnSpy = (cmd, args, opts) => { const p = realSpawn(cmd, args, opts); childPid = p.pid; return p; };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await withServer({
    spawn: spawnSpy, uvCommand: () => ({ cmd: process.execPath, args: ['-e', child] }),
    scriptTimeouts: { visionPage: 1500 }, killGraceMs: 300,
  }, async (b) => {
    const r = await post('/vision-page', { package: PKG, page: 'p1' }, b);
    assert.equal(r.status, 504);
    const gpid = Number(await fs.readFile(pidFile, 'utf-8'));
    await waitFor(() => !alive(gpid) && !alive(childPid), 3000);
  });
});

// --- POST /auto: validation ----------------------------------------------------

const BAD = ['../x', '..', 'a/b', '/etc/passwd', '', 'a\\b', '.hidden', 'a..b', '-rf', '--help', 'a'.repeat(129), 123, null, ['P-T']];

test('/auto: invalid pkg / page / step / flags → 400, no spawn', async () => {
  const ok = { pkg: PKG, page: 'p1', step: 'gates' };
  const bodies = [
    ...BAD.map((v) => ({ ...ok, pkg: v })),
    ...BAD.map((v) => ({ ...ok, page: v })),
    { ...ok, step: 'vision' }, { ...ok, step: '' }, { ...ok, step: undefined }, { ...ok, step: ['gates'] },
    { ...ok, force: 'yes' }, { ...ok, draft: 1 }, { ...ok, dryRun: 'true' },
    { ...ok, step: 'next', force: true },
  ];
  for (const b of bodies) {
    const r = await post('/auto', b);
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  for (const raw of ['', 'not json', '[1]', 'null']) {
    const r = await fetch(`${base}/auto`, { method: 'POST', headers: H, body: raw });
    assert.equal(r.status, 400, raw);
  }
  assert.equal(calls.length, 0);
});

test('/auto: without X-Kronikarz → 403', async () => {
  const r = await fetch(`${base}/auto`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ pkg: PKG, page: 'p1', step: 'gates' }) });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
});

test('/auto: unknown package / page → 404, package not listed in project.yaml → 404', async () => {
  let r = await json(await post('/auto', { pkg: 'P-NOPE', page: 'p1', step: 'gates' }));
  assert.equal(r.status, 404);
  r = await json(await post('/auto', { pkg: PKG, page: 'p9', step: 'gates' }));
  assert.equal(r.status, 404);
  // on disk, but the module's project.yaml does not list it
  await fs.mkdir(path.join(root, 'MJC-400', 'P-U'), { recursive: true });
  await fs.writeFile(path.join(root, 'MJC-400', 'P-U', 'package.yaml'), PACKAGE.replace(`id: ${PKG}`, 'id: P-U'));
  r = await json(await post('/auto', { pkg: 'P-U', page: 'p1', step: 'gates' }));
  assert.equal(r.status, 404);
  // a directory without project.yaml is not a module (like data/gold)
  await fs.mkdir(path.join(root, 'OTHER', 'P-V'), { recursive: true });
  await fs.writeFile(path.join(root, 'OTHER', 'P-V', 'package.yaml'), PACKAGE);
  r = await json(await post('/auto', { pkg: 'P-V', page: 'p1', step: 'gates' }));
  assert.equal(r.status, 404);
  assert.equal(calls.length, 0);
});

test('/auto: page file outside the data root (package.yaml or symlink) → 403, no spawn', async () => {
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'v.sch.yaml'), 'victim\n');
  const rel = path.relative(path.join(root, 'MJC-400', PKG), path.join(outside, 'v.sch.yaml'));
  await fs.writeFile(path.join(root, 'MJC-400', PKG, 'package.yaml'),
    PACKAGE.replace('file: pages/p2.sch.yaml', `file: ${rel}`));
  let r = await post('/auto', { pkg: PKG, page: 'p2', step: 'gates' });
  assert.equal(r.status, 403);
  r = await post('/auto', { pkg: PKG, page: 'all', step: 'gates' });
  assert.equal(r.status, 403, 'all: one bad page refuses the run');
  await fs.rm(pageFile('p1'));
  await fs.symlink(path.join(outside, 'v.sch.yaml'), pageFile('p1'));
  r = await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' });
  assert.equal(r.status, 403, 'symlinked page file');
  assert.equal(calls.length, 0);
  assert.equal(await fs.readFile(path.join(outside, 'v.sch.yaml'), 'utf-8'), 'victim\n');
});

test('/auto: argv for auto.py', async () => {
  behave = replyWith(JSON.stringify({ exit: 0, pages: [] }));
  await post('/auto', { pkg: PKG, page: 'p1', step: 'gates', draft: true, dryRun: true });
  await post('/auto', { pkg: PKG, page: 'all', step: 'wires', force: true });
  const script = path.join(REPO, 'scripts', 'auto.py');
  assert.deepEqual(calls[0].args, ['run', script, '--data', root, '--pkg', PKG, '--page', 'p1', '--step', 'gates', '--draft', '--dry-run', '--json']);
  assert.deepEqual(calls[1].args, ['run', script, '--data', root, '--pkg', PKG, '--page', 'all', '--step', 'wires', '--force', '--json']);
});

// --- POST /auto: exit-code mapping ----------------------------------------------

const autoOut = (exit, pages, extra = {}) =>
  JSON.stringify({ package: PKG, page: 'p1', step: 'gates', pages, exit, ...extra });

test('/auto: exit 0 → 200 with the JSON summary', async () => {
  const summary = { package: PKG, page: 'p1', step: 'gates', exit: 0, pages: [{ page: 'p1', step: 'gates', status: 'ok', exit: 0, counts: { detected: 3 } }] };
  behave = replyWith(JSON.stringify(summary));
  const r = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }));
  assert.deepEqual(r, { status: 200, body: summary });
});

test('/auto: exit 2 → 409 refused with reasons', async () => {
  behave = replyWith(autoOut(2, [{ page: 'p1', step: 'wires', status: 'refused', exit: 2, reason: 'krok gates nie jest zatwierdzony' }]), 2);
  const r = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'wires' }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'refused');
  assert.deepEqual(r.body.reasons, [{ page: 'p1', step: 'wires', status: 'refused', reason: 'krok gates nie jest zatwierdzony' }]);
  assert.equal(r.body.result.exit, 2);
});

test('/auto: exit 3 → 501 not implemented', async () => {
  behave = replyWith(autoOut(3, [], { step: 'text', reason: 'krok text nie jest jeszcze zaimplementowany' }), 3);
  const r = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'text' }));
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'not_implemented');
  assert.match(r.body.reasons[0].reason, /nie jest jeszcze zaimplementowany/);
});

test('/auto: exit 1 → 500 with reasons and stderr tail', async () => {
  behave = replyWith(autoOut(1, [
    { page: 'p1', step: 'gates', status: 'error', exit: 1, reason: 'strona zmieniła się w trakcie przebiegu' },
    { page: 'p2', step: 'gates', status: 'ok', exit: 0 },
  ]), 1, 'x'.repeat(5000) + 'TAIL');
  const r = await json(await post('/auto', { pkg: PKG, page: 'all', step: 'gates' }));
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'failed');
  assert.deepEqual(r.body.reasons.map((x) => x.page), ['p1']);
  assert.ok(r.body.stderr.endsWith('TAIL'));
  assert.ok(r.body.stderr.length < 4100);
});

test('/auto: exit code without matching JSON (uv itself failing) → 500, never "refused"', async () => {
  behave = replyWith('', 2, 'error: Failed to resolve dependencies');
  let r = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }));
  assert.equal(r.status, 500);
  assert.match(r.body.stderr, /Failed to resolve/);
  behave = replyWith(autoOut(0, []), 2);
  r = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }));
  assert.equal(r.status, 500, 'JSON exit disagrees with process exit');
  behave = (p) => p.close(null, 'SIGSEGV');
  r = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }));
  assert.equal(r.status, 500);
});

// nix-develop fallback: the shellHook banner lands on stdout before the JSON.
const BANNER = '\n  KRONIKARZ — srodowisko deweloperskie\n  =====\n  node:    v22\n  {not json}\n\n';

test('parseLastJson: whole text, last top-level value after a banner, none', () => {
  assert.deepEqual(parseLastJson('{"a":1}\n'), { a: 1 });
  assert.deepEqual(parseLastJson(`${BANNER}${JSON.stringify({ a: { b: [1] } }, null, 1)}\n`), { a: { b: [1] } });
  assert.deepEqual(parseLastJson('{"old":1}\n{"new":2}\n'), { new: 2 });
  assert.equal(parseLastJson(BANNER), undefined);
  assert.equal(parseLastJson(''), undefined);
});

test('parseLastJson: tries only the last PARSE_LAST_JSON_TRIES line starts (no quadratic parse)', () => {
  // A result whose own lines start with `{` at column 0 (array of objects,
  // one per line) costs one try per such line: found within the limit only.
  const arr = (n) => `[\n${Array.from({ length: n }, (_, i) => `{"i":${i}}`).join(',\n')}\n]`;
  const N = PARSE_LAST_JSON_TRIES;
  assert.equal(parseLastJson(`banner\n${arr(N - 1)}`).length, N - 1, 'within the limit');
  assert.equal(parseLastJson(`banner\n${arr(N)}`), undefined, 'beyond the limit');
  // big stdout: 20 000 `{` lines of 1 KiB before the result — fast
  const big = Array.from({ length: 20_000 }, () => `{${'x'.repeat(1024)}`).join('\n');
  const t0 = Date.now();
  assert.deepEqual(parseLastJson(`${big}\n${JSON.stringify({ ok: 1 }, null, 1)}`), { ok: 1 });
  assert.equal(parseLastJson(big), undefined);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test('JSON endpoints read the result after a devShell banner (vision, /auto)', async () => {
  behave = replyWith(`${BANNER}{"ok":true,"gates":3}\n`);
  let r = await json(await post('/vision-page', { package: PKG, page: 'p1' }));
  assert.deepEqual(r, { status: 200, body: { ok: true, gates: 3 } });
  const summary = { package: PKG, page: 'p1', step: 'gates', exit: 2, pages: [{ page: 'p1', step: 'gates', status: 'refused', exit: 2, reason: 'nope' }] };
  behave = replyWith(`${BANNER}${JSON.stringify(summary, null, 1)}\n`, 2);
  r = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'refused');
});

test('/auto timeout per page × pages is capped at autoMax', async () => {
  await withServer({ scriptTimeouts: { autoPerPage: 1000, autoMax: 1500 } }, async (b) => {
    behave = hang;
    const job = post('/auto', { pkg: PKG, page: 'all', step: 'gates' }, b);
    await waitFor(() => calls.length === 1);
    assert.equal((await json(await fetch(`${b}/auto/status`))).body.jobs[0].timeoutMs, 1500);
    calls[0].proc.reply(autoOut(0, []));
    await job;
  });
});

test('/auto timeout per page depends on the step (text: slow local VLM; next: the largest)', async () => {
  assert.equal(SCRIPT_TIMEOUTS.autoPerPageStep.text, 600_000);
  assert.equal(autoPageTimeout('gates'), SCRIPT_TIMEOUTS.autoPerPage);
  assert.equal(autoPageTimeout('text'), 600_000);
  assert.equal(autoPageTimeout('next'), 600_000);
  assert.equal(autoPageTimeout('wires', { autoPerPage: 7 }), 7);
  assert.equal(autoPageTimeout('text', { autoPerPage: 7, autoPerPageStep: { text: 9 } }), 9);
  assert.equal(autoPageTimeout('next', { autoPerPage: 70, autoPerPageStep: { text: 9 } }), 70);
  await withServer({ scriptTimeouts: { autoPerPage: 1000, autoPerPageStep: { text: 1300 }, autoMax: 2000 } }, async (b) => {
    behave = hang;
    for (const [step, page, want] of [['text', 'p1', 1300], ['gates', 'p1', 1000], ['next', 'p1', 1300], ['text', 'all', 2000]]) {
      const job = post('/auto', { pkg: PKG, page, step }, b);
      await waitFor(() => calls.length === 1);
      assert.equal((await json(await fetch(`${b}/auto/status`))).body.jobs[0].timeoutMs, want, `${step} ${page}`);
      calls[0].proc.reply(autoOut(0, []));
      await job;
      calls.length = 0;
    }
  });
});

test('/auto text/next: uv run --with mlx-vlm only for steps that load the model', async () => {
  behave = replyWith(autoOut(0, []));
  for (const [step, vlm] of [['text', true], ['next', true], ['gates', false], ['wires', false]]) {
    calls.length = 0;
    const r = await json(await post('/auto', { pkg: PKG, page: 'p1', step, draft: step === 'wires' }));
    assert.equal(r.status, 200, step);
    const args = calls[0].args;
    const at = args.findIndex((a) => a.endsWith('scripts/auto.py'));
    assert.deepEqual(args.slice(0, at), vlm ? ['run', '--with', AUTO_VLM_WITH] : ['run'], step);
    assert.equal(args[args.indexOf('--step') + 1], step);
  }
  assert.equal(AUTO_VLM_WITH, 'mlx-vlm==0.8.1');
});

test('/auto text/next: one model-loading job at a time (virtual lock), other steps unaffected', async () => {
  behave = hang;
  const a = post('/auto', { pkg: PKG, page: 'p1', step: 'text' });
  await waitFor(() => calls.length === 1);
  for (const body of [{ page: 'p2', step: 'text' }, { page: 'p2', step: 'next' }]) {
    const r = await json(await post('/auto', { pkg: PKG, ...body }));
    assert.equal(r.status, 409, body.step);
    assert.equal(r.body.error, 'busy');
    assert.equal(r.body.job.step, 'text');
    assert.deepEqual(r.body.job.pages, ['p1']);
    assert.ok(r.body.job.locks.includes(path.join('.auto', 'vlm')), JSON.stringify(r.body.job.locks));
  }
  const g = post('/auto', { pkg: PKG, page: 'p2', step: 'gates' });
  await waitFor(() => calls.length === 2);
  for (const c of calls) c.proc.reply(autoOut(0, []));
  assert.equal((await a).status, 200);
  assert.equal((await g).status, 200);
  // po zakończeniu blokada zwolniona
  behave = replyWith(autoOut(0, []));
  assert.equal((await json(await post('/auto', { pkg: PKG, page: 'p2', step: 'text' }))).status, 200);
});

test('uv runs with UV_CACHE_DIR on the model disk (env wins; none → uv default)', async () => {
  assert.equal(defaultUvCacheDir({ UV_CACHE_DIR: '/x/c' }, () => true), '/x/c');
  assert.equal(defaultUvCacheDir({}, (p) => p === LLM_UV_CACHE), LLM_UV_CACHE);
  assert.equal(defaultUvCacheDir({}, () => false), null);
  assert.equal(LLM_UV_CACHE, '/Volumes/Dane/llm/uv-cache');
  behave = replyWith(autoOut(0, []));
  await withServer({ uvCacheDir: '/tmp/uvc-test' }, async (b) => {
    calls.length = 0;
    await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }, b));
    assert.equal(calls[0].opts.env.UV_CACHE_DIR, '/tmp/uvc-test');
    assert.equal(calls[0].opts.env.PATH, process.env.PATH);
  });
  await withServer({ uvCacheDir: null }, async (b) => {
    calls.length = 0;
    await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }, b));
    assert.equal(calls[0].opts.env, process.env);
  });
});

// --- POST /auto: locks ---------------------------------------------------------

test('/auto vs /auto: same page → 409 busy (job info); other page runs; status shows both', async () => {
  behave = hang;
  const a = post('/auto', { pkg: PKG, page: 'p1', step: 'gates' });
  await waitFor(() => calls.length === 1);
  const b = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'wires', draft: true }));
  assert.equal(b.status, 409);
  assert.equal(b.body.error, 'busy');
  assert.equal(b.body.job.kind, 'auto');
  assert.equal(b.body.job.step, 'gates');
  assert.deepEqual(b.body.job.pages, ['p1']);
  assert.deepEqual(b.body.job.locks, [path.join('MJC-400', PKG, 'pages', 'p1.sch.yaml')]);

  const c = post('/auto', { pkg: PKG, page: 'p2', step: 'gates' });
  await waitFor(() => calls.length === 2);
  const st = await json(await fetch(`${base}/auto/status`));
  assert.equal(st.body.running, true);
  assert.deepEqual(st.body.jobs.map((j) => j.pages[0]).sort(), ['p1', 'p2']);

  for (const x of calls) x.proc.reply(autoOut(0, []));
  assert.equal((await a).status, 200);
  assert.equal((await c).status, 200);
  assert.deepEqual((await json(await fetch(`${base}/auto/status`))).body, { running: false, jobs: [] });
});

test('/auto all locks every page of the package: single page refused while it runs, and vice versa', async () => {
  behave = hang;
  const all = post('/auto', { pkg: PKG, page: 'all', step: 'next' });
  await waitFor(() => calls.length === 1);
  for (const page of ['p1', 'p2']) {
    const r = await json(await post('/auto', { pkg: PKG, page, step: 'gates' }));
    assert.equal(r.status, 409, page);
    assert.equal(r.body.job.page, 'all');
  }
  const st = (await json(await fetch(`${base}/auto/status`))).body;
  assert.equal(st.jobs.length, 1);
  assert.equal(st.jobs[0].timeoutMs, 2 * 2000, 'timeout = per page × pages');
  calls[0].proc.reply(autoOut(0, []));
  assert.equal((await all).status, 200);

  const one = post('/auto', { pkg: PKG, page: 'p2', step: 'gates' });
  await waitFor(() => calls.length === 2);
  const r = await json(await post('/auto', { pkg: PKG, page: 'all', step: 'gates' }));
  assert.equal(r.status, 409);
  calls[1].proc.reply(autoOut(0, []));
  assert.equal((await one).status, 200);
});

const putPage = (rel, body = 'kronikarz: "1"\nmine: 1\n', headers = {}, b = base) =>
  fetch(`${b}/files/${rel}`, { method: 'PUT', headers: { 'X-Kronikarz': '1', ...headers }, body });
const P1_REL = `MJC-400/${PKG}/pages/p1.sch.yaml`;

// Every write to a page held by a writing job: 409 busy at once, file untouched.
async function assertPageWritesBusy(kind) {
  const t0 = Date.now();
  const checks = [
    ['PUT', () => putPage(P1_REL, undefined, { 'If-Match': sha1Tag(PAGE_V) })],
    ['PUT no If-Match', () => putPage(P1_REL)],
    ['DELETE', () => fetch(`${base}/files/${P1_REL}`, { method: 'DELETE', headers: { 'X-Kronikarz': '1' } })],
    ['make-bak', () => post('/make-bak', { package: PKG, page: 'p1' })],
    ['restore-bak', () => post('/restore-bak', { package: PKG, page: 'p1' })],
  ];
  for (const [name, f] of checks) {
    const r = await json(await f());
    assert.equal(r.status, 409, `${kind}: ${name}`);
    assert.equal(r.body.error, 'busy', `${kind}: ${name}`);
    assert.equal(r.body.job.kind, kind);
  }
  assert.ok(Date.now() - t0 < 1000, 'answered at once, not queued');
  assert.equal(await fs.readFile(pageFile('p1'), 'utf-8'), PAGE_V);
  // other pages are free
  assert.equal((await putPage(`MJC-400/${PKG}/pages/p2.sch.yaml`, 'kronikarz: "1"\n')).status, 200);
}

test('PUT/DELETE/make-bak/restore-bak of a page under /auto → 409 busy at once', async () => {
  behave = hang;
  const job = post('/auto', { pkg: PKG, page: 'p1', step: 'gates' });
  await waitFor(() => calls.length === 1);
  await fs.writeFile(pageFile('p1') + '.bak', 'bak\n');
  await assertPageWritesBusy('auto');
  calls[0].proc.reply(autoOut(0, []));
  assert.equal((await job).status, 200);
  assert.equal((await putPage(P1_REL)).status, 200, 'free again after the run');
});

test('PUT/DELETE/make-bak/restore-bak of a page under /vision-page → 409 busy at once', async () => {
  behave = hang;
  const job = post('/vision-page', { package: PKG, page: 'p1' });
  await waitFor(() => calls.length === 1);
  await assertPageWritesBusy('vision-page');
  calls[0].proc.reply('{"ok":true}');
  assert.equal((await job).status, 200);
});

test('lock keys are canonical: PUT through a symlinked dir / other letter case hits the busy page', async () => {
  const alias = path.join(root, 'alias');
  await fs.rm(alias, { force: true });
  // to the package dir (a link to the module would make a second module)
  await fs.symlink(path.join(root, 'MJC-400', PKG), alias); // inside the root: allowed
  behave = hang;
  const job = post('/auto', { pkg: PKG, page: 'p1', step: 'gates' });
  await waitFor(() => calls.length === 1);
  try {
    let r = await json(await putPage('alias/pages/p1.sch.yaml'));
    assert.equal(r.status, 409, 'via symlinked directory');
    assert.equal(r.body.error, 'busy');
    r = await json(await putPage(`MJC-400/./${PKG}/pages/../pages/p1.sch.yaml`));
    assert.equal(r.status, 409, 'via ./ and ..');
    // case-insensitive file system (macOS default): another spelling, same file
    const upper = path.join(root, 'MJC-400', PKG.toLowerCase());
    if (existsSync(upper) && (await fs.stat(upper)).ino === (await fs.stat(path.join(root, 'MJC-400', PKG))).ino) {
      r = await json(await putPage(`mjc-400/${PKG.toLowerCase()}/pages/P1.SCH.YAML`));
      assert.equal(r.status, 409, 'other letter case');
      const v = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'wires', draft: true }));
      assert.equal(v.status, 409);
    }
    assert.equal(await fs.readFile(pageFile('p1'), 'utf-8'), PAGE_V);
  } finally {
    calls[0].proc.reply(autoOut(0, []));
    await job;
    await fs.rm(alias, { force: true });
  }
});

test('withFileLock uses the canonical key: PUTs of one file via symlink / other case are serialised', async () => {
  const alias = path.join(root, 'alias');
  await fs.rm(alias, { force: true });
  await fs.symlink(path.join(root, 'MJC-400', PKG), alias);
  const spellings = ['alias/pages/p1.sch.yaml'];
  const lower = path.join(root, 'mjc-400', PKG.toLowerCase());
  if (existsSync(lower) && (await fs.stat(lower)).ino === (await fs.stat(path.join(root, 'MJC-400', PKG))).ino) {
    spellings.push(`mjc-400/${PKG.toLowerCase()}/pages/P1.SCH.YAML`); // case-insensitive FS
  }
  try {
    for (const other of spellings) {
      let release;
      let renames = 0;
      const gate = new Promise((r) => { release = r; });
      await withServer({ rename: async (a, b) => { if (++renames === 1) await gate; return fs.rename(a, b); } }, async (b) => {
        const first = putPage(P1_REL, 'kronikarz: "1"\nfirst: 1\n', {}, b);
        await waitFor(() => renames === 1);
        const second = putPage(other, 'kronikarz: "1"\nsecond: 1\n', {}, b);
        await sleep(150);
        assert.equal(renames, 1, `${other}: second PUT held behind the first`);
        release();
        assert.equal((await first).status, 200);
        assert.equal((await second).status, 200);
        assert.equal(await fs.readFile(pageFile('p1'), 'utf-8'), 'kronikarz: "1"\nsecond: 1\n', 'arrival order');
      });
    }
  } finally {
    await fs.rm(alias, { force: true });
  }
});

test('/auto waits for a PUT in progress before starting the script', async () => {
  // A PUT inside its commit step holds the file lock; gate it via a slow rename.
  let release;
  const gate = new Promise((r) => { release = r; });
  let renames = 0;
  await withServer({ rename: async (a, b) => { renames++; await gate; return fs.rename(a, b); } }, async (b) => {
    const put = fetch(`${b}/files/MJC-400/${PKG}/pages/p1.sch.yaml`, { method: 'PUT', headers: { 'X-Kronikarz': '1' }, body: 'kronikarz: "1"\n' });
    await waitFor(() => renames === 1);
    behave = replyWith(autoOut(0, []));
    const job = post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }, b);
    await sleep(100);
    assert.equal(calls.length, 0, 'script not started during the PUT');
    release();
    assert.equal((await put).status, 200);
    assert.equal((await job).status, 200);
    assert.equal(calls.length, 1);
  });
});

test('/auto dryRun holds the job lock but not the file lock (PUT goes through)', async () => {
  behave = hang;
  const job = post('/auto', { pkg: PKG, page: 'p1', step: 'gates', dryRun: true });
  await waitFor(() => calls.length === 1);
  const r = await fetch(`${base}/files/MJC-400/${PKG}/pages/p1.sch.yaml`, { method: 'PUT', headers: { 'X-Kronikarz': '1' }, body: 'kronikarz: "1"\n' });
  assert.equal(r.status, 200);
  assert.equal((await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' })).status, 409);
  calls[0].proc.reply(autoOut(0, []));
  assert.equal((await job).status, 200);
});

test('/auto timeout: process killed → 504, lock released', async () => {
  await withServer({ scriptTimeouts: { autoPerPage: 60 } }, async (b) => {
    behave = hang;
    const r = await json(await post('/auto', { pkg: PKG, page: 'p1', step: 'gates' }, b));
    assert.equal(r.status, 504);
    assert.equal(calls[0].proc.killed[0], 'SIGTERM');
    const st = (await json(await fetch(`${b}/auto/status`))).body;
    assert.equal(st.running, false);
  });
});

// --- integration: the real auto.py --dry-run on a synthetic data root ------------

function uvAvailable() {
  const r = spawnSync('uv', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

// Binary PGM (cv2.imread reads it whatever the extension): white page with
// two rectangles and a wire between them.
function syntheticScan(w = 400, h = 300) {
  const px = Buffer.alloc(w * h, 255);
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 0;
  };
  const box = (x, y, bw, bh, t = 3) => {
    fill(x, y, x + bw, y + t); fill(x, y + bh - t, x + bw, y + bh);
    fill(x, y, x + t, y + bh); fill(x + bw - t, y, x + bw, y + bh);
  };
  box(60, 80, 70, 90);
  box(260, 80, 70, 90);
  fill(130, 124, 260, 127);
  return Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), px]);
}

test('integration: real auto.py --dry-run via POST /auto (synthetic data root)', { timeout: 300_000 }, async (t) => {
  if (!uvAvailable()) { t.skip('uv not on PATH — skipping the real auto.py run'); return; }
  const iroot = path.join(parent, 'idata');
  const pkgDir = path.join(iroot, 'MOD', 'P-I');
  await fs.mkdir(path.join(pkgDir, 'pages'), { recursive: true });
  await fs.mkdir(path.join(pkgDir, 'scans'), { recursive: true });
  await fs.writeFile(path.join(iroot, 'MOD', 'project.yaml'), 'kronikarz: "1"\nproject:\n  name: MOD\npackages:\n- id: P-I\n  file: P-I/package.yaml\n');
  await fs.writeFile(path.join(pkgDir, 'package.yaml'),
    'kronikarz: "1"\npackage:\n  id: P-I\n  pages:\n    - id: s1\n      file: pages/s1.sch.yaml\n      scan: scans/s1.pgm\n      sheet: 1\n');
  const pageText = 'kronikarz: "1"\npage: s1\npackage: P-I\ngates: []\nports: []\ncross_refs: []\npower: []\nnets: {}\nannotations: []\ndecorations: []\n';
  await fs.writeFile(path.join(pkgDir, 'pages', 's1.sch.yaml'), pageText);
  await fs.writeFile(path.join(pkgDir, 'scans', 's1.pgm'), syntheticScan());

  const s = await listen(createApp({
    root: iroot, spawn: realSpawn, uvCommand: (args) => ({ cmd: 'uv', args }),
    scriptTimeouts: { autoPerPage: 280_000 },
  }));
  try {
    const b = `http://127.0.0.1:${s.address().port}`;
    const r = await json(await post('/auto', { pkg: 'P-I', page: 's1', step: 'gates', dryRun: true }, b));
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 2000));
    assert.equal(r.body.exit, 0);
    assert.equal(r.body.dry_run, true);
    assert.equal(r.body.pages.length, 1);
    const p = r.body.pages[0];
    assert.equal(p.status, 'dry_run');
    assert.equal(p.written, false);
    assert.equal(typeof p.counts.detected, 'number');
    assert.equal(await fs.readFile(path.join(pkgDir, 'pages', 's1.sch.yaml'), 'utf-8'), pageText, 'dry run wrote nothing');
    assert.equal(existsSync(path.join(iroot, '.auto')), false, 'no snapshot');

    // (krok text nie tutaj: --with mlx-vlm zbudowałoby ciężkie środowisko — argumenty
    // i odmowę kroku sprawdzają testy z fałszywym spawn i scripts/test_auto_text.py)
    const nf = await json(await post('/auto', { pkg: 'P-I', page: 's1', step: 'labels', dryRun: true }, b));
    assert.equal(nf.status, 501);
  } finally {
    await new Promise((r) => s.close(r));
  }
});
