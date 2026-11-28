import express from 'express';
import { promises as fs, createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import yaml from 'js-yaml';

// Repo root: server/ → ..
const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Load .env from repo root if present (CLI only — called from main()).
function loadDotEnv() {
  const envFile = path.join(REPO, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Detect uv binary location. If not in PATH, fall back to running through
// `nix develop` (devshell) so users who started the server outside devshell
// still get uv.
let UV_RESOLVED = null;
function resolveUv() {
  if (UV_RESOLVED !== null) return UV_RESOLVED;
  const candidates = [
    process.env.UV_PATH,
    'uv',
    `${process.env.HOME}/.local/bin/uv`,
    `${process.env.HOME}/.cargo/bin/uv`,
    '/run/current-system/sw/bin/uv',
  ].filter(Boolean);
  for (const p of candidates) {
    const r = spawnSync(p, ['--version'], { stdio: 'ignore' });
    if (r.status === 0) { UV_RESOLVED = { cmd: p, prefix: [] }; return UV_RESOLVED; }
  }
  // Fallback: nix develop (slow but works if uv is in flake devShell)
  const r = spawnSync('nix', ['develop', '--command', 'uv', '--version'], { stdio: 'ignore', cwd: REPO });
  if (r.status === 0) {
    UV_RESOLVED = { cmd: 'nix', prefix: ['develop', '--command', 'uv'] };
    return UV_RESOLVED;
  }
  UV_RESOLVED = { cmd: null, prefix: [] };
  return UV_RESOLVED;
}

function uvCommand(scriptArgs) {
  const r = resolveUv();
  if (!r.cmd) return { cmd: null, args: [] };
  return { cmd: r.cmd, args: [...r.prefix, ...scriptArgs] };
}

// Note: global express.raw middleware already consumed body into a Buffer.
// Parse JSON manually instead of stacking another body parser.
function parseJsonBody(req) {
  if (!req.body) return null;
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString('utf-8')); }
    catch { return null; }
  }
  return req.body;
}

// The script's JSON result: the whole stdout, else the last top-level JSON
// value starting at the beginning of a line — anything printed before it
// (e.g. the `nix develop` shellHook banner of the uv fallback) is ignored.
// Returns undefined when there is none.
// Only the last PARSE_LAST_JSON_TRIES line starts are tried (no quadratic
// parse of a large stdout full of `{` lines).
export const PARSE_LAST_JSON_TRIES = 8;
export function parseLastJson(s) {
  const text = s.trim();
  try { return JSON.parse(text); } catch { /* search below */ }
  let tries = 0;
  for (let i = text.length; tries < PARSE_LAST_JSON_TRIES && i > 0;) {
    const nl = text.lastIndexOf('\n', i - 1); // a start is 0 or just after a newline
    const start = nl + 1;
    if (text[start] === '{' || text[start] === '[') {
      tries++;
      try { return JSON.parse(text.slice(start)); } catch { /* earlier line */ }
    }
    if (nl < 0) break;
    i = nl;
  }
  return undefined;
}

// Bind loopback only by default: the viewer reaches the server through the
// Vite dev proxy, nothing else on the LAN should be able to talk to it.
export const DEFAULT_HOST = '127.0.0.1';

// DNS-rebinding guard: a hostile page whose domain resolves to 127.0.0.1 is
// same-origin to the browser, so it could send X-Kronikarz. It cannot fake
// the Host header though, so only loopback names are accepted. (The Vite
// proxy keeps the original `Host: localhost:5173`.)
const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// CSRF guard: every state-changing request must carry this header. Browsers
// refuse to send a custom header cross-origin without a CORS preflight, and
// this server answers preflights without any Access-Control-Allow-* headers.
export const CSRF_HEADER = 'x-kronikarz';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Allowed shape for request fields that become path segments / argv
// (package id, page id). No separators, no leading dot, no `..`.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export function isSafeSegment(s) {
  return typeof s === 'string' && s.length <= 128 && SEGMENT_RE.test(s) && !s.includes('..');
}

function isoStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

// Timestamped backup `<file>.<ISO>.bak`; returns its path.
async function timestampedBackup(yamlPath, ms) {
  const tsPath = `${yamlPath}.${isoStamp(ms)}.bak`;
  await fs.copyFile(yamlPath, tsPath);
  return tsPath;
}

// Rolling `<file>.bak` + timestamped backup.
async function backupPage(yamlPath, ms) {
  const bakPath = `${yamlPath}.bak`;
  await fs.copyFile(yamlPath, bakPath);
  const tsPath = await timestampedBackup(yamlPath, ms);
  return { bakPath, tsPath };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Delete all but the newest `keep` timestamped backups `<file>.<ISO>.bak` of
// `filePath` (ISO stamps sort lexically = chronologically).
async function pruneTimestamped(filePath, keep) {
  const re = new RegExp(`^${escapeRe(path.basename(filePath))}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.bak$`);
  const dir = path.dirname(filePath);
  const all = (await fs.readdir(dir)).filter((f) => re.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) {
    await fs.rm(path.join(dir, f), { force: true });
  }
}

// Strong ETag = quoted sha1 of the content (data files are small; a content
// hash, unlike mtime+size, does not change on a no-op rewrite and has no
// timestamp-granularity blind spot).
export function etagOf(buf) {
  return `"${createHash('sha1').update(buf).digest('hex')}"`;
}

// If-Match: `*` or a comma-separated list of strong tags (a weak `W/` tag
// never matches — RFC 9110 strong comparison).
function ifMatchOk(header, currentTag) {
  if (currentTag === null) return false;
  return header.split(',').map((t) => t.trim()).some((t) => t === '*' || t === currentTag);
}

// YAML files the viewer loads must stay loadable. Rule per file name:
//   *.sch.yaml, package.yaml, project.yaml -> mapping with `kronikarz: "1"`
//   ic_map.yaml, *.zones.yaml              -> mapping (real files have no key)
// Anything else is not checked. Returns an error message or null.
const VERSIONED_YAML = (name) => name.endsWith('.sch.yaml') || name === 'package.yaml' || name === 'project.yaml';
const PLAIN_YAML = (name) => name === 'ic_map.yaml' || name.endsWith('.zones.yaml');
export function yamlBodyError(name, buf) {
  if (!VERSIONED_YAML(name) && !PLAIN_YAML(name)) return null;
  let doc;
  try {
    doc = yaml.load(buf.toString('utf-8'));
  } catch (e) {
    return `invalid YAML: ${e.message.split('\n')[0]}`;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'YAML top level must be a mapping';
  if (VERSIONED_YAML(name) && doc.kronikarz !== '1') return 'missing or wrong `kronikarz: "1"`';
  return null;
}

// Autosave backups (CLAUDE.md "Backups"): a PUT writes only a timestamped
// `<file>.<ISO>.bak`, at most one per file per window; after each one the
// newest BACKUP_KEEP of them are kept. The rolling `<file>.bak` is the last
// manual checkpoint (/make-bak, or before /vision-page*) — never autosave.
export const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
export const BACKUP_KEEP = 50;

// Script timeouts (ms). Each Vite proxy timeout (viewer/vite.config.ts) is
// this + 2 × killGraceMs + margin, so the client gets the server's 504 rather
// than a proxy abort (which would also kill the job). /auto: per page of the
// request (autoPerPage, or autoPerPageStep[step] for slow steps — `text` runs
// a local VLM on every gate crop, ~3 min/sheet plus model load, `labels` on
// every free wire end, ~1–2 min/sheet; `next` may land on any step, so it gets
// the largest), capped at autoMax (proxy: 3600 s).
export const SCRIPT_TIMEOUTS = {
  aiDetect: 110_000,
  visionPage: 230_000,
  visionZones: 290_000,
  yoloExport: 110_000,
  autoPerPage: 120_000,
  autoPerPageStep: { text: 600_000, labels: 600_000 },
  autoMax: 3_000_000,
};

// Heavy Python environments (mlx-vlm for step `text`, ~0.8 GB) belong on the
// model disk, never in ~/.cache (maintainer rule): every `uv` the server runs
// gets UV_CACHE_DIR = $UV_CACHE_DIR, else LLM_UV_CACHE when that directory
// exists, else uv's default. createApp({uvCacheDir}) overrides (tests).
export const LLM_UV_CACHE = '/Volumes/Dane/llm/uv-cache';
export function defaultUvCacheDir(env = process.env, exists = existsSync) {
  if (env.UV_CACHE_DIR) return env.UV_CACHE_DIR;
  return exists(LLM_UV_CACHE) ? LLM_UV_CACHE : null;
}

// Steps `text` and `labels` (and `next`, which may land on them) need mlx-vlm;
// auto.py does not declare it (gates / wires stay light), the server adds it per run.
export const AUTO_VLM_WITH = 'mlx-vlm==0.8.1';
export const AUTO_VLM_STEPS = new Set(['text', 'labels', 'next']);
export const autoNeedsVlm = (step) => AUTO_VLM_STEPS.has(step);

// Per-page /auto timeout for a step (ms).
export function autoPageTimeout(step, timeouts = SCRIPT_TIMEOUTS) {
  const per = { ...SCRIPT_TIMEOUTS.autoPerPageStep, ...(timeouts.autoPerPageStep ?? {}) };
  const base = timeouts.autoPerPage ?? SCRIPT_TIMEOUTS.autoPerPage;
  if (step === 'next') return Math.max(base, ...Object.values(per));
  return per[step] ?? base;
}

export function createApp({
  root,
  spawn: spawnFn = spawn,
  uvCommand: uvCmd = uvCommand,
  rename: renameFn = (from, to) => fs.rename(from, to),
  now = () => Date.now(),
  backupIntervalMs = BACKUP_INTERVAL_MS,
  backupKeep = BACKUP_KEEP,
  scriptTimeouts: timeoutsOpt = {},
  killGraceMs = 5000,
  maxStdout = 16 * 1024 * 1024,
  maxStderr = 64 * 1024,
  groupAlive: groupAliveOpt = null,
  uvCacheDir = defaultUvCacheDir(),
} = {}) {
const ROOT = path.resolve(root ?? path.join(REPO, 'data'));
const SPAWN_ENV = uvCacheDir ? { ...process.env, UV_CACHE_DIR: uvCacheDir } : process.env;
const TIMEOUTS = { ...SCRIPT_TIMEOUTS, ...timeoutsOpt };
const groupAlive = groupAliveOpt ?? defaultGroupAlive;

// Canonical lock key of a path: realpath of its nearest existing ancestor
// directory (case as on disk, symlinks resolved) + the rest, lower-cased on
// a case-insensitive file system. Sync on purpose: callers take locks before
// any await so arrival order holds.
let caseInsensitiveFs = null;
function isCaseInsensitiveFs() {
  if (caseInsensitiveFs === null) {
    try {
      const real = realpathSync.native(ROOT);
      const swapped = real.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      const a = statSync(real);
      const b = statSync(swapped, { throwIfNoEntry: false });
      caseInsensitiveFs = !!b && swapped !== real && a.ino === b.ino && a.dev === b.dev;
    } catch {
      return false; // root missing (yet): decide later
    }
  }
  return caseInsensitiveFs;
}
function lockKeyOf(abs) {
  let dir = path.dirname(abs);
  const rest = [path.basename(abs)];
  for (;;) {
    try {
      const key = path.join(realpathSync.native(dir), ...rest).normalize('NFC');
      return isCaseInsensitiveFs() ? key.toLowerCase() : key;
    } catch {
      if (path.dirname(dir) === dir) return abs;
      rest.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
}

// Per-file write lock: writes to one file run one at a time, in the order
// their handlers started (= order the full request was received).
const writeChains = new Map();
function withFileLock(abs, fn) {
  const key = lockKeyOf(abs);
  const prev = writeChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  writeChains.set(key, tail);
  tail.then(() => { if (writeChains.get(key) === tail) writeChains.delete(key); });
  return run;
}

// A running script job that rewrites this file (vision, /auto without
// dryRun), or null. Writes to such a file are refused at once (409 busy)
// instead of queueing behind a job that may take minutes.
function writingJobOn(abs) {
  const j = runningJobs.get(lockKeyOf(abs));
  return j && j.writes.has(lockKeyOf(abs)) ? j : null;
}
function busyOr(res, abs) {
  const j = writingJobOn(abs);
  if (j) res.status(409).json({ error: 'busy', job: jobView(j) });
  return !!j;
}

// The same lock on several paths (sorted, so two multi-path holders always
// take them in one order), held while `fn` runs.
function withFileLocks(paths, fn) {
  const byKey = new Map(paths.map((p) => [lockKeyOf(p), p]));
  return [...byKey.keys()].sort().reduceRight((inner, k) => () => withFileLock(byKey.get(k), inner), fn)();
}

// Last-resort error reply for a handler whose promise rejected.
function fail500(res, e) {
  if (!res.headersSent) res.status(500).json({ error: e.message });
}

// --- Script jobs: runScript (kr-0sn.7) --------------------------------------
//
// Every POST that runs a Python script goes through runScript:
//  - per-key job lock (canonical keys, lockKeyOf): a second job whose lockKey
//    overlaps a running one is refused at once (status 'busy' → 409
//    {error:'busy', job}). Page-writing jobs lock the page file.
//  - fileLocks: files the job rewrites. It holds withFileLock on them for the
//    whole run (it starts only after a PUT in progress has finished), and
//    PUT/DELETE/make-bak/restore-bak of them are refused with 409 busy while
//    it runs (writingJobOn).
//  - timeout: SIGTERM, SIGKILL after killGraceMs → 'timeout' (504).
//  - signal (client disconnect): same kill sequence → 'aborted', no reply.
//  - the process runs in its own process group (detached) and is killed as a
//    group, so `uv run` / `nix develop` and the Python child under it die too.
//    After a kill, SIGKILL goes to the group once more on exit (orphans).
//  - no exit killGraceMs after SIGKILL: the client gets its 504 now, but while
//    the process group still exists the job keeps its locks, marked `stuck`
//    (in /auto/status); released once the group is gone.
//  - resolves exactly once; stdin errors (EPIPE of a dead child) are absorbed;
//    stdout (head) and stderr (tail) are capped.
const runningJobs = new Map(); // canonical lock key -> job
const runningProcs = new Set();
let jobSeq = 0;

const jobView = (j) => ({
  id: j.id, kind: j.kind, ...j.info, startedAt: j.startedAt, timeoutMs: j.timeoutMs, ...(j.stuck ? { stuck: true } : {}),
});
const relPath = (p) => (path.isAbsolute(p) ? path.relative(ROOT, p) : p);

const isRealChild = (proc) => proc instanceof ChildProcess && Number.isInteger(proc.pid);

function killGroup(proc, sig) {
  // Group kill only for a real child spawned detached; test fakes get kill().
  if (isRealChild(proc)) {
    try { process.kill(-proc.pid, sig); return; } catch { /* fall back */ }
  }
  try { proc.kill?.(sig); } catch { /* already gone */ }
}

// Does the process group still exist (signal 0)? Injectable for tests.
function defaultGroupAlive(proc) {
  if (!isRealChild(proc)) return false;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function runScript(args, {
  stdin = null, timeoutMs = 120000, lockKey = null, fileLocks = [], signal = null,
  before = null, kind = 'script', info = {},
} = {}) {
  const paths = [...new Set([lockKey].flat().filter(Boolean))];
  const keys = [...new Set(paths.map(lockKeyOf))];
  for (const k of keys) {
    const held = runningJobs.get(k);
    if (held) return Promise.resolve({ status: 'busy', job: jobView(held) });
  }
  const job = {
    id: ++jobSeq, kind, info: { ...info, locks: paths.map(relPath) },
    startedAt: new Date(now()).toISOString(), timeoutMs, stuck: false,
    writes: new Set(fileLocks.map(lockKeyOf)),
  };
  for (const k of keys) runningJobs.set(k, job);
  const release = () => { for (const k of keys) if (runningJobs.get(k) === job) runningJobs.delete(k); };

  let deliver;
  const result = new Promise((r) => { deliver = r; });
  const inner = async () => {
    if (signal?.aborted) return { status: 'aborted' };
    if (before) {
      const early = await before();
      if (early) return early;
    }
    if (signal?.aborted) return { status: 'aborted' };
    return spawnAndWait(args, { stdin, timeoutMs, signal, job });
  };
  // The reply goes out as soon as the result is known; the locks (job and
  // file) stay until `gone` — later than the reply only for a stuck process.
  const body = async () => {
    const r = await inner();
    deliver(r);
    if (r.gone) await r.gone;
  };
  (fileLocks.length ? withFileLocks(fileLocks, body) : body())
    .catch((e) => deliver({ status: 'error', error: e.message }))
    .finally(release);
  return result;
}

function spawnAndWait(args, { stdin, timeoutMs, signal, job }) {
  const { cmd, args: argv } = uvCmd(args);
  if (!cmd) return Promise.resolve({ status: 'no-uv' });
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnFn(cmd, argv, { cwd: REPO, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: SPAWN_ENV });
    } catch (e) {
      return resolve({ status: 'spawn-error', error: e.message });
    }
    runningProcs.add(proc);
    const out = [];
    let outLen = 0;
    let outTruncated = false;
    let err = Buffer.alloc(0);
    let errTruncated = false;
    let killing = null; // 'timeout' | 'aborted'
    let settled = false;
    let closed = false;
    const timers = [];

    const finish = (r, gone = null) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      if (!gone) runningProcs.delete(proc);
      // Orphans of a killed group (python under a dead uv) get no second chance.
      if (killing && !gone) killGroup(proc, 'SIGKILL');
      resolve({
        stdout: Buffer.concat(out).toString('utf-8'), stdoutTruncated: outTruncated,
        stderr: err.toString('utf-8'), stderrTruncated: errTruncated, ...r, ...(gone ? { gone, stuck: true } : {}),
      });
    };
    // No exit after SIGKILL + grace. Group gone → release now; else keep the
    // locks (job marked stuck) until 'close' or the group disappears.
    const giveUp = (why) => {
      if (closed || !groupAlive(proc)) {
        console.warn(`job ${job.id}: no exit ${killGraceMs} ms after SIGKILL; process group gone, releasing`);
        return finish({ status: why, code: null, signal: 'SIGKILL' });
      }
      console.warn(`job ${job.id}: process group still alive after SIGKILL; job stuck, locks kept`);
      job.stuck = true;
      const gone = new Promise((done) => {
        const end = () => { clearInterval(poll); runningProcs.delete(proc); done(); };
        const poll = setInterval(() => {
          killGroup(proc, 'SIGKILL');
          if (!groupAlive(proc)) end();
        }, killGraceMs);
        proc.once('close', end);
      });
      finish({ status: why, code: null, signal: 'SIGKILL' }, gone);
    };
    const kill = (why) => {
      if (killing || settled) return;
      killing = why;
      killGroup(proc, 'SIGTERM');
      timers.push(setTimeout(() => {
        killGroup(proc, 'SIGKILL');
        timers.push(setTimeout(() => giveUp(why), killGraceMs));
      }, killGraceMs));
    };
    function onAbort() { kill('aborted'); }

    proc.stdout?.on('data', (b) => {
      if (outLen + b.length > maxStdout) {
        out.push(b.subarray(0, Math.max(0, maxStdout - outLen)));
        outLen = maxStdout;
        outTruncated = true;
      } else {
        out.push(b);
        outLen += b.length;
      }
    });
    proc.stderr?.on('data', (b) => {
      err = Buffer.concat([err, b]);
      if (err.length > maxStderr) { err = err.subarray(err.length - maxStderr); errTruncated = true; }
    });
    proc.stdout?.on('error', () => {});
    proc.stderr?.on('error', () => {});
    proc.on('error', (e) => {
      // Not spawned at all (ENOENT …): no 'close' is guaranteed — answer now.
      // A running child that errors (e.g. a failed kill) still ends in 'close'.
      if (!Number.isInteger(proc.pid)) finish({ status: 'spawn-error', error: e.message });
    });
    proc.on('close', (code, sig) => {
      closed = true;
      finish(killing ? { status: killing, code, signal: sig } : { status: 'exit', code, signal: sig });
    });

    timers.push(setTimeout(() => kill('timeout'), timeoutMs));
    if (signal) {
      if (signal.aborted) kill('aborted');
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (proc.stdin) {
      proc.stdin.on?.('error', () => {}); // EPIPE: child exited before reading
      try {
        if (stdin != null) proc.stdin.write(stdin);
        proc.stdin.end();
      } catch { /* destroyed stream; 'close' reports the exit */ }
    }
  });
}

// Signal that aborts when the client goes away before the reply is sent.
// (res 'close', not req 'close': the latter fires once the body is read.)
function clientGone(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  return ac.signal;
}

const tail = (s, n = 4000) => (s.length > n ? `…${s.slice(-n)}` : s);


// Default reply for a successful exit: stdout must be JSON.
function replyJson(res, r) {
  if (r.code !== 0) return res.status(500).json({ error: `exit ${r.code ?? r.signal}`, stderr: tail(r.stderr) });
  const out = parseLastJson(r.stdout);
  if (out === undefined) {
    return res.status(500).json({ error: 'bad JSON from script', raw: r.stdout.slice(0, 500), truncated: r.stdoutTruncated, stderr: tail(r.stderr) });
  }
  res.json(out);
}

// Map a runScript result to the (single) HTTP reply.
function replyScript(res, r, onExit = replyJson) {
  if (r.status === 'aborted') {
    console.log(`${res.req?.method} ${res.req?.url} → aborted by client, job killed`);
    if (!res.writableEnded) res.end();
    return;
  }
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  switch (r.status) {
    case 'busy': return res.status(409).json({ error: 'busy', job: r.job });
    case 'timeout': return res.status(504).json({ error: 'timeout', ...(r.stuck ? { stuck: true } : {}), stderr: tail(r.stderr ?? '') });
    case 'no-uv': return res.status(500).json({ error: 'uv not found; start server inside `nix develop` or install uv' });
    case 'spawn-error': return res.status(500).json({ error: `spawn: ${r.error}` });
    case 'error': return res.status(r.httpStatus ?? 500).json({ error: r.error });
    case 'exit': return onExit(res, r);
    default: return res.status(500).json({ error: `unexpected job state ${r.status}` });
  }
}

// Kill every running script (server shutdown).
function killJobs(sig = 'SIGTERM') {
  for (const p of runningProcs) killGroup(p, sig);
}

// abs path -> time of the last autosave backup of it. In memory only: after
// a restart the next PUT of a file simply backs it up again.
const lastBackupAt = new Map();
const backupDue = (abs) => !lastBackupAt.has(abs) || now() - lastBackupAt.get(abs) >= backupIntervalMs;

const app = express();
app.set('etag', false);

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} → ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

app.use((req, res, next) => {
  if (!LOOPBACK_HOST_RE.test(req.headers.host ?? '')) {
    return res.status(403).json({ error: 'forbidden host' });
  }
  next();
});

app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get(CSRF_HEADER) !== '1') {
    return res.status(403).json({ error: `missing ${CSRF_HEADER}: 1 header` });
  }
  next();
});

// Every request body is raw bytes whatever its Content-Type, also without
// one (a '*/*' matcher skips those and leaves req.body = {} -> kr-0sn.11).
app.use(express.raw({ type: () => true, limit: '50mb' }));

function safeResolve(rel) {
  const resolved = path.resolve(ROOT, rel);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

// Symlink guard: `abs` (or, if it does not exist yet, its nearest existing
// ancestor) must realpath to somewhere inside realpath(ROOT). Dangling
// symlinks are refused outright.
async function isConfined(abs) {
  const realRoot = await fs.realpath(ROOT).catch(() => ROOT);
  for (let p = abs; ; p = path.dirname(p)) {
    try {
      const real = await fs.realpath(p);
      return real === realRoot || real.startsWith(realRoot + path.sep);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      if (await fs.lstat(p).then(() => true, () => false)) return false; // dangling link
      if (path.dirname(p) === p) return false;
    }
  }
}

// safeResolve + symlink guard; null if the path escapes the data root.
async function resolveInside(rel) {
  const abs = safeResolve(rel);
  if (!abs) return null;
  return (await isConfined(abs)) ? abs : null;
}

// Path of a page yaml from untrusted {package, page}; null if invalid.
function pageYamlPath(pkg, page) {
  if (!isSafeSegment(pkg) || !isSafeSegment(page)) return null;
  return safeResolve(path.join('MJC-400', pkg, 'pages', `${page}.sch.yaml`));
}

// Validated + confined page yaml path, or null after sending 400/403.
async function pageYamlOr(res, pkg, page) {
  const yamlPath = pageYamlPath(pkg, page);
  if (!yamlPath) { res.status(400).json({ error: 'invalid package/page' }); return null; }
  if (!(await isConfined(yamlPath))) { res.status(403).json({ error: 'path escapes data root' }); return null; }
  return yamlPath;
}

app.get('/health', (_req, res) => res.json({ ok: true, root: ROOT }));

app.get('/files/*', async (req, res) => {
  const abs = await resolveInside(req.params[0]);
  if (!abs) return res.status(403).json({ error: 'path traversal' });
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is a directory' });
    if (abs.endsWith('.yaml')) {
      // Small data files: read whole, send with an ETag for If-Match on PUT.
      const data = await fs.readFile(abs);
      res.setHeader('ETag', etagOf(data));
      res.setHeader('Content-Length', data.length);
      return res.end(data);
    }
    res.setHeader('Content-Length', stat.size);
    createReadStream(abs).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/files/*', (req, res) => {
  const key = safeResolve(req.params[0]);
  if (!key) return res.status(403).json({ error: 'path traversal' });
  if (busyOr(res, key)) return;
  // Lock taken synchronously, before any await, so arrival order holds.
  return withFileLock(key, () => putFile(req, res)).catch((e) => fail500(res, e));
});

// PUT /files/*: validate, check If-Match, back up, write atomically.
async function putFile(req, res) {
  const abs = await resolveInside(req.params[0]);
  if (!abs) return res.status(403).json({ error: 'path traversal' });
  if (abs === ROOT) return res.status(400).json({ error: 'need a file path' });
  // No body at all (no Content-Length / Transfer-Encoding) is a client bug;
  // refusing it beats truncating the file. An explicit empty body is a Buffer.
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'missing request body' });
  const body = req.body;
  let tmp = null;
  try {
    const st = await fs.stat(abs).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (st?.isDirectory()) return res.status(400).json({ error: 'is a directory' });
    const yamlErr = yamlBodyError(path.basename(abs), body);
    if (yamlErr) return res.status(422).json({ error: yamlErr });
    const newTag = etagOf(body);
    const ifMatch = req.get('If-Match');
    if (ifMatch !== undefined) {
      const curTag = st ? etagOf(await fs.readFile(abs)) : null;
      if (!ifMatchOk(ifMatch, curTag)) {
        // Retry of a PUT that did land (response lost): old tag, same body.
        // Nothing to write; report success.
        if (curTag === newTag) {
          res.setHeader('ETag', newTag);
          return res.json({ ok: true, bytes: body.length, unchanged: true });
        }
        return res.status(409).json({ error: 'conflict', etag: curTag });
      }
    }
    if (st && abs.endsWith('.yaml') && backupDue(abs)) {
      const t = now();
      try {
        await timestampedBackup(abs, t);
      } catch (e) {
        return res.status(500).json({ error: `backup failed: ${e.message}` });
      }
      lastBackupAt.set(abs, t);
      // The backup exists; a failed cleanup must not cost the user the save.
      await pruneTimestamped(abs, backupKeep).catch((e) => console.warn(`prune ${abs}: ${e.message}`));
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, body);
    await renameFn(tmp, abs);
    tmp = null;
    res.setHeader('ETag', newTag);
    res.json({ ok: true, bytes: body.length });
  } catch (err) {
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
}

app.delete('/files/*', (req, res) => {
  const key = safeResolve(req.params[0]);
  if (!key) return res.status(403).json({ error: 'path traversal' });
  if (busyOr(res, key)) return;
  return withFileLock(key, () => deleteFile(req, res)).catch((e) => fail500(res, e));
});

async function deleteFile(req, res) {
  const abs = await resolveInside(req.params[0]);
  if (!abs) return res.status(403).json({ error: 'path traversal' });
  if (abs === ROOT) return res.status(400).json({ error: 'need a file path' });
  try {
    if ((await fs.lstat(abs)).isDirectory()) return res.status(400).json({ error: 'is a directory' });
    await fs.unlink(abs);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: err.message });
  }
}

async function listDir(rel, res) {
  const abs = await resolveInside(rel);
  if (!abs) return res.status(403).json({ error: 'path traversal' });
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const files = [];
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      (e.isDirectory() ? dirs : files).push(e.name);
    }
    files.sort();
    dirs.sort();
    res.json({ path: rel, files, dirs });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'not a directory' });
    res.status(500).json({ error: err.message });
  }
}

app.get('/list', (req, res) => listDir('', res));
app.get('/list/*', (req, res) => listDir(req.params[0], res));

// --- AI-assisted ROI detection ----------------------------------------------

// Read-only (writes no page): no job lock — two ROI detections may run at once.
app.post('/ai-detect', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page, x, y, w, h } = body || {};
  if (!pkg || !page || ![x, y, w, h].every((n) => Number.isFinite(n))) {
    return res.status(400).json({ error: 'need {package, page, x, y, w, h}', got: body });
  }
  if (!(await pageYamlOr(res, pkg, page))) return;
  const script = path.join(REPO, 'scripts/ai-detect-roi.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'detect script missing' });
  const r = await runScript(['run', script], {
    stdin: JSON.stringify({ package: pkg, page, x, y, w, h }),
    timeoutMs: TIMEOUTS.aiDetect, signal: clientGone(res), kind: 'ai-detect', info: { pkg, page },
  });
  replyScript(res, r);
});

// --- Vision page digitalization --------------------------------------------

// Page-rewriting script: job lock + file lock on the page; the rolling .bak
// is made under both, so a refused second click never touches it.
function runPageRewrite(res, { yamlPath, script, args, stdin = null, timeoutMs, kind, info }) {
  return runScript(['run', script, ...args], {
    stdin, timeoutMs, kind, info, lockKey: yamlPath, fileLocks: [yamlPath], signal: clientGone(res),
    before: async () => {
      // Backup BEFORE running vision — rolling .bak + timestamped (only if file exists).
      if (!existsSync(yamlPath)) return null;
      try {
        await backupPage(yamlPath, now());
        return null;
      } catch (e) {
        return { status: 'error', error: `backup failed: ${e.message}` };
      }
    },
  });
}

app.post('/vision-page', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page } = body || {};
  if (!pkg || !page) return res.status(400).json({ error: 'need {package, page}' });
  const yamlPath = await pageYamlOr(res, pkg, page);
  if (!yamlPath) return;
  const script = path.join(REPO, 'scripts/vision-page.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'vision-page script missing' });
  const r = await runPageRewrite(res, {
    yamlPath, script, args: [pkg, page], timeoutMs: TIMEOUTS.visionPage, kind: 'vision-page', info: { pkg, page },
  });
  replyScript(res, r);
});

// --- Vision per-zone digitalization ----------------------------------------

app.post('/vision-page-zones', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page, zones } = body || {};
  if (!pkg || !page || !Array.isArray(zones)) return res.status(400).json({ error: 'need {package, page, zones[]}' });
  const yamlPath = await pageYamlOr(res, pkg, page);
  if (!yamlPath) return;
  const script = path.join(REPO, 'scripts/vision-zones.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'vision-zones script missing' });
  const r = await runPageRewrite(res, {
    yamlPath, script, args: [pkg, page], stdin: JSON.stringify({ zones }),
    timeoutMs: TIMEOUTS.visionZones, kind: 'vision-page-zones', info: { pkg, page },
  });
  replyScript(res, r);
});

// --- Manual backup ----------------------------------------------------------

// Page yaml path for a lock key (sync), or null after sending 400.
function pageKeyOr(res, pkg, page) {
  const yamlPath = pageYamlPath(pkg, page);
  if (!yamlPath) res.status(400).json({ error: 'invalid package/page' });
  return yamlPath;
}

app.post('/make-bak', (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page } = body || {};
  if (!pkg || !page) return res.status(400).json({ error: 'need {package, page}' });
  const yamlPath = pageKeyOr(res, pkg, page);
  if (!yamlPath) return;
  if (busyOr(res, yamlPath)) return;
  // Per-file lock (as PUT): the copy never sees a half-finished write.
  return withFileLock(yamlPath, () => makeBak(res, yamlPath)).catch((e) => fail500(res, e));
});

async function makeBak(res, yamlPath) {
  if (!(await isConfined(yamlPath))) return res.status(403).json({ error: 'path escapes data root' });
  if (!existsSync(yamlPath)) return res.status(404).json({ error: 'page yaml not found' });
  try {
    const { bakPath, tsPath } = await backupPage(yamlPath, now());
    res.json({ ok: true, bak: bakPath, timestamped: tsPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post('/restore-bak', (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page } = body || {};
  if (!pkg || !page) return res.status(400).json({ error: 'need {package, page}' });
  const yamlPath = pageKeyOr(res, pkg, page);
  if (!yamlPath) return;
  if (busyOr(res, yamlPath)) return;
  // Same per-file lock as PUT, taken before any await: a restore never
  // interleaves with a write.
  return withFileLock(yamlPath, () => restoreBak(res, yamlPath)).catch((e) => fail500(res, e));
});

async function restoreBak(res, yamlPath) {
  if (!(await isConfined(yamlPath))) return res.status(403).json({ error: 'path escapes data root' });
  const bakPath = `${yamlPath}.bak`;
  if (!existsSync(bakPath)) return res.status(404).json({ error: 'no .bak file' });
  if (!(await isConfined(bakPath))) return res.status(403).json({ error: 'path escapes data root' });
  let backup = null;
  let tmp = null;
  try {
    // Read the .bak first: an unreadable .bak must not leave a stray backup.
    const data = await fs.readFile(bakPath);
    // Keep the current state recoverable: timestamped backup first (not the
    // rolling .bak — that is what we are restoring from).
    backup = existsSync(yamlPath) ? await timestampedBackup(yamlPath, now()) : null;
    // Atomic restore: write tmp in the same dir, then rename over.
    tmp = `${yamlPath}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, data);
    await renameFn(tmp, yamlPath);
    tmp = null;
    res.json({ ok: true, restored: bakPath, backup });
  } catch (e) {
    // Page is unchanged (rename is atomic) → drop tmp and the now-redundant backup.
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
    if (backup) await fs.rm(backup, { force: true }).catch(() => {});
    res.status(500).json({ error: e.message });
  }
}

// --- YOLO dataset -----------------------------------------------------------

const YOLO_DIR = path.join(ROOT, '.yolo-dataset');
const CLASSES_FILE = path.join(YOLO_DIR, 'classes.txt');

async function readClasses() {
  try {
    const txt = await fs.readFile(CLASSES_FILE, 'utf-8');
    return txt.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

app.post('/yolo-export', async (req, res) => {
  const allFlag = req.query.all === '1';
  const script = path.join(REPO, 'scripts/export-yolo-from-yamls.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'export script missing' });
  const args = ['run', script];
  if (allFlag) args.push('--all');
  // Rewrites the whole dataset dir: one export at a time.
  const r = await runScript(args, {
    timeoutMs: TIMEOUTS.yoloExport, lockKey: YOLO_DIR, signal: clientGone(res), kind: 'yolo-export', info: { all: allFlag },
  });
  replyScript(res, r);
});

app.get('/yolo-stats', async (_req, res) => {
  try {
    const classes = await readClasses();
    const labelsDir = path.join(YOLO_DIR, 'labels');
    let total = 0;
    const perClass = Object.fromEntries(classes.map((c) => [c, 0]));
    if (existsSync(labelsDir)) {
      const files = await fs.readdir(labelsDir);
      for (const f of files) {
        if (!f.endsWith('.txt')) continue;
        const lines = (await fs.readFile(path.join(labelsDir, f), 'utf-8')).split('\n').filter(Boolean);
        total += lines.length;
        for (const ln of lines) {
          const id = Number(ln.split(' ')[0]);
          const name = classes[id];
          if (name) perClass[name]++;
        }
      }
    }
    res.json({ classes, total, perClass });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Pipeline step: POST /auto (kr-9p8.19) -----------------------------------
//
// Body {pkg, page: <id>|'all', step, force?, draft?, dryRun?} → scripts/auto.py
// --json. Lock = every page file the run may write (for 'all': all pages of
// the package), the same keys as a single-page job and as PUT's withFileLock,
// so 'all' and a single page of that package exclude each other directly.
// A real run also holds withFileLock on those pages (it starts after a PUT in
// progress) and PUT/DELETE/make-bak/restore-bak of them get 409 busy while it
// runs. A dry run writes nothing → job lock only.
// Exit: 0 → 200, 2 → 409 refused, 3 → 501, 1 (or no JSON) → 500.

const AUTO_SCRIPT = path.join(REPO, 'scripts/auto.py');
const AUTO_STEPS = new Set(['gates', 'text', 'wires', 'labels', 'nets', 'next']);

// Cost hook for paid VLM steps. `text` and `labels` run a local model (auto.py
// default, no cost) and the server never passes --model / --allow-paid, so
// nothing here can spend money; `nets` is not implemented (exit 3 → 501). If a paid model
// is ever wired in (auto.py paid_model_refusal): estimate the cost (dry run),
// require an explicit confirmation field in the body and a budget limit here,
// and refuse (e.g. 402) without them — docs/auto-digitalizacja.md „Uruchamianie”.
function paidStepRefusal(_body) {
  return null;
}

const isFile = (p) => fs.stat(p).then((s) => s.isFile(), () => false);

// The package as auto.py's find_package sees it: <ROOT>/<module>/<pkg>/
// package.yaml next to <module>/project.yaml, which must also list it.
// Returns {pkgDir, pages: [{id, abs}]} or {status, error}.
async function findAutoPackage(pkg) {
  const hits = [];
  for (const m of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (m.name.startsWith('.')) continue;
    const proj = path.join(ROOT, m.name, 'project.yaml');
    const pkgYaml = path.join(ROOT, m.name, pkg, 'package.yaml');
    if ((await isFile(proj)) && (await isFile(pkgYaml))) hits.push({ proj, pkgYaml });
  }
  if (hits.length === 0) return { status: 404, error: `unknown package ${pkg}` };
  if (hits.length > 1) return { status: 500, error: `package ${pkg} found in several modules` };
  const { proj, pkgYaml } = hits[0];
  if (!(await isConfined(pkgYaml))) return { status: 403, error: 'path escapes data root' };
  let projDoc;
  let pkgDoc;
  try {
    projDoc = yaml.load(await fs.readFile(proj, 'utf-8'));
    pkgDoc = yaml.load(await fs.readFile(pkgYaml, 'utf-8'));
  } catch (e) {
    return { status: 500, error: `cannot read project/package: ${e.message.split('\n')[0]}` };
  }
  const listed = Array.isArray(projDoc?.packages) && projDoc.packages.some((p) => String(p?.id) === pkg);
  if (!listed) return { status: 404, error: `package ${pkg} is not listed in ${path.relative(ROOT, proj)}` };
  const entries = pkgDoc?.package?.pages;
  if (!Array.isArray(entries)) return { status: 500, error: `${path.relative(ROOT, pkgYaml)}: no package.pages` };
  const pkgDir = path.dirname(pkgYaml);
  // Same defaults as auto.py run_page.
  const pages = entries
    .filter((e) => e && typeof e === 'object' && e.id != null)
    .map((e) => {
      const id = String(e.id);
      return { id, abs: path.resolve(pkgDir, String(e.file || `pages/${id}.sch.yaml`)) };
    });
  return { pkgDir, pages };
}

app.post('/auto', (req, res) => postAuto(req, res).catch((e) => fail500(res, e)));

async function postAuto(req, res) {
  const body = parseJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'need JSON {pkg, page, step, force?, draft?, dryRun?}' });
  }
  const { pkg, page, step, force = false, draft = false, dryRun = false } = body;
  if (!isSafeSegment(pkg)) return res.status(400).json({ error: 'invalid pkg' });
  if (page !== 'all' && !isSafeSegment(page)) return res.status(400).json({ error: 'invalid page' });
  if (!AUTO_STEPS.has(step)) return res.status(400).json({ error: 'invalid step', steps: [...AUTO_STEPS] });
  for (const [k, v] of Object.entries({ force, draft, dryRun })) {
    if (typeof v !== 'boolean') return res.status(400).json({ error: `${k} must be a boolean` });
  }
  if (step === 'next' && force) return res.status(400).json({ error: 'force with step next is ambiguous — name the step' });
  const paid = paidStepRefusal(body);
  if (paid) return res.status(paid.status).json(paid.body);

  const found = await findAutoPackage(pkg);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const targets = page === 'all' ? found.pages : found.pages.filter((p) => p.id === page);
  if (page !== 'all' && targets.length === 0) return res.status(404).json({ error: `unknown page ${page} in ${pkg}` });
  for (const t of targets) {
    if (!t.abs.startsWith(ROOT + path.sep) || !(await isConfined(t.abs))) {
      return res.status(403).json({ error: `page ${t.id}: path escapes data root` });
    }
  }
  if (!existsSync(AUTO_SCRIPT)) return res.status(500).json({ error: 'auto script missing' });

  const keys = targets.map((t) => t.abs);
  // One local-model job at a time (each loads ~17 GB): a virtual lock key
  // shared by every text / labels / next run, whatever the package or page.
  const vlm = autoNeedsVlm(step);
  const jobKeys = vlm ? [...keys, path.join(ROOT, '.auto', 'vlm')] : keys;
  const args = ['run', ...(vlm ? ['--with', AUTO_VLM_WITH] : []), AUTO_SCRIPT,
    '--data', ROOT, '--pkg', pkg, '--page', page, '--step', step];
  if (force) args.push('--force');
  if (draft) args.push('--draft');
  if (dryRun) args.push('--dry-run');
  args.push('--json');
  const r = await runScript(args, {
    lockKey: jobKeys,
    fileLocks: dryRun ? [] : keys,
    timeoutMs: Math.min(autoPageTimeout(step, TIMEOUTS) * Math.max(1, targets.length), TIMEOUTS.autoMax),
    signal: clientGone(res),
    kind: 'auto',
    info: { pkg, page, step, dryRun, pages: targets.map((t) => t.id) },
  });
  replyScript(res, r, replyAuto);
}

const AUTO_EXIT = { 0: [200, null], 1: [500, 'failed'], 2: [409, 'refused'], 3: [501, 'not_implemented'] };

function replyAuto(res, r) {
  const out = parseLastJson(r.stdout);
  // Exit code and JSON must agree: `uv` itself also exits 1/2 on its own errors.
  const mapped = AUTO_EXIT[r.code];
  if (!mapped || !out || typeof out !== 'object' || out.exit !== r.code) {
    return res.status(500).json({
      error: `auto.py exit ${r.code ?? r.signal} without a matching JSON summary`,
      stderr: tail(r.stderr), raw: r.stdout.slice(0, 500),
    });
  }
  const [status, error] = mapped;
  if (!error) return res.json(out);
  const reasons = [
    ...(out.reason ? [{ page: out.page, step: out.step, reason: out.reason }] : []),
    ...(Array.isArray(out.pages) ? out.pages : [])
      .filter((p) => p.exit !== 0)
      .map((p) => ({ page: p.page, step: p.step, status: p.status, reason: p.reason })),
  ];
  const reply = { error, reasons, result: out };
  if (r.code === 1) reply.stderr = tail(r.stderr);
  res.status(status).json(reply);
}

// Running script jobs (all kinds), so the viewer can show "running".
app.get('/auto/status', (_req, res) => {
  const jobs = [...new Set(runningJobs.values())].map(jobView);
  res.json({ running: jobs.length > 0, jobs });
});

app.killJobs = killJobs;
return app;
}

// Start listening; resolves with the http.Server once bound.
export function startServer({ root, port = 8080, host = process.env.KRONIKARZ_HOST || DEFAULT_HOST, ...opts } = {}) {
  const app = createApp({ root, ...opts });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.killJobs = app.killJobs;
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

async function main() {
  loadDotEnv();
  const root = path.resolve(REPO, process.env.KRONIKARZ_DATA || './data');
  const port = Number(process.env.KRONIKARZ_PORT || 8080);

  // Probe uv at startup
  const r = resolveUv();
  if (r.cmd) console.log(`uv resolved: ${r.cmd} ${r.prefix.join(' ')}`);
  else console.warn('uv NOT found. AI features will fail. Start server inside `nix develop` or install uv.');

  const server = await startServer({ root, port });
  // Scripts run in their own process group (runScript), so Ctrl-C / watchexec
  // restart does not reach them: kill them on the way out.
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.once(sig, () => {
      server.killJobs();
      process.exit(128 + n);
    });
  }
  const { address, port: boundPort } = server.address();
  const shown = address.includes(':') ? `[${address}]` : address;
  console.log(`kronikarz-server: http://${shown}:${boundPort}`);
  console.log(`  data root: ${root}`);
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(url.fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
