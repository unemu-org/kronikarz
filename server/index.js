import express from 'express';
import { promises as fs, createReadStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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

export function createApp({
  root,
  spawn: spawnFn = spawn,
  uvCommand: uvCmd = uvCommand,
  rename: renameFn = (from, to) => fs.rename(from, to),
  now = () => Date.now(),
  backupIntervalMs = BACKUP_INTERVAL_MS,
  backupKeep = BACKUP_KEEP,
} = {}) {
const ROOT = path.resolve(root ?? path.join(REPO, 'data'));

// Per-file write lock: writes to one absolute path run one at a time, in the
// order their handlers started (= order the full request was received).
const writeChains = new Map();
function withFileLock(abs, fn) {
  const prev = writeChains.get(abs) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  writeChains.set(abs, tail);
  tail.then(() => { if (writeChains.get(abs) === tail) writeChains.delete(abs); });
  return run;
}

// Last-resort error reply for a handler whose promise rejected.
function fail500(res, e) {
  if (!res.headersSent) res.status(500).json({ error: e.message });
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

app.post('/ai-detect', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page, x, y, w, h } = body || {};
  if (!pkg || !page || ![x, y, w, h].every((n) => Number.isFinite(n))) {
    return res.status(400).json({ error: 'need {package, page, x, y, w, h}', got: body });
  }
  if (!(await pageYamlOr(res, pkg, page))) return;
  const script = path.join(REPO, 'scripts/ai-detect-roi.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'detect script missing' });

  const { cmd, args } = uvCmd(['run', script]);
  if (!cmd) return res.status(500).json({ error: 'uv not found; start server inside `nix develop` or install uv' });
  const proc = spawnFn(cmd, args, { cwd: REPO });
  let out = '';
  let err = '';
  proc.stdout.on('data', (b) => (out += b.toString()));
  proc.stderr.on('data', (b) => (err += b.toString()));
  proc.on('error', (e) => res.status(500).json({ error: `spawn: ${e.message}` }));
  proc.on('close', (code) => {
    if (code !== 0) return res.status(500).json({ error: `exit ${code}`, stderr: err });
    try {
      res.json(JSON.parse(out));
    } catch (e) {
      res.status(500).json({ error: 'bad JSON from script', raw: out.slice(0, 500), stderr: err });
    }
  });
  proc.stdin.write(JSON.stringify({ package: pkg, page, x, y, w, h }));
  proc.stdin.end();
});

// --- Vision page digitalization --------------------------------------------

app.post('/vision-page', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page } = body || {};
  if (!pkg || !page) return res.status(400).json({ error: 'need {package, page}' });
  const yamlPath = await pageYamlOr(res, pkg, page);
  if (!yamlPath) return;

  // Backup BEFORE running vision — keep rolling .bak + timestamped (only if file exists).
  if (existsSync(yamlPath)) {
    try {
      await backupPage(yamlPath, now());
    } catch (e) {
      return res.status(500).json({ error: `backup failed: ${e.message}` });
    }
  }

  const script = path.join(REPO, 'scripts/vision-page.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'vision-page script missing' });
  const { cmd, args } = uvCmd(['run', script, pkg, page]);
  if (!cmd) return res.status(500).json({ error: 'uv not found' });

  const proc = spawnFn(cmd, args, { cwd: REPO });
  let out = '';
  let err = '';
  proc.stdout.on('data', (b) => (out += b.toString()));
  proc.stderr.on('data', (b) => (err += b.toString()));
  proc.on('error', (e) => res.status(500).json({ error: `spawn: ${e.message}` }));
  proc.on('close', (code) => {
    if (code !== 0) return res.status(500).json({ error: `exit ${code}`, stderr: err });
    try { res.json(JSON.parse(out)); }
    catch (e) { res.status(500).json({ error: 'bad JSON', raw: out.slice(0, 500), stderr: err }); }
  });
});

// --- Vision per-zone digitalization ----------------------------------------

app.post('/vision-page-zones', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page, zones } = body || {};
  if (!pkg || !page || !Array.isArray(zones)) return res.status(400).json({ error: 'need {package, page, zones[]}' });
  const yamlPath = await pageYamlOr(res, pkg, page);
  if (!yamlPath) return;

  if (existsSync(yamlPath)) {
    try {
      await backupPage(yamlPath, now());
    } catch (e) {
      return res.status(500).json({ error: `backup failed: ${e.message}` });
    }
  }

  const script = path.join(REPO, 'scripts/vision-zones.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'vision-zones script missing' });
  const { cmd, args } = uvCmd(['run', script, pkg, page]);
  if (!cmd) return res.status(500).json({ error: 'uv not found' });

  const proc = spawnFn(cmd, args, { cwd: REPO });
  let out = '';
  let err = '';
  proc.stdout.on('data', (b) => (out += b.toString()));
  proc.stderr.on('data', (b) => (err += b.toString()));
  proc.on('error', (e) => res.status(500).json({ error: `spawn: ${e.message}` }));
  proc.on('close', (code) => {
    if (code !== 0) return res.status(500).json({ error: `exit ${code}`, stderr: err });
    try { res.json(JSON.parse(out)); }
    catch (e) { res.status(500).json({ error: 'bad JSON', raw: out.slice(0, 500), stderr: err }); }
  });
  proc.stdin.write(JSON.stringify({ zones }));
  proc.stdin.end();
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
  const { cmd, args: uvArgs } = uvCmd(args);
  if (!cmd) return res.status(500).json({ error: 'uv not found; start server inside `nix develop` or install uv' });
  const proc = spawnFn(cmd, uvArgs, { cwd: REPO });
  let out = '';
  let err = '';
  proc.stdout.on('data', (b) => (out += b.toString()));
  proc.stderr.on('data', (b) => (err += b.toString()));
  proc.on('error', (e) => res.status(500).json({ error: `spawn: ${e.message}` }));
  proc.on('close', (code) => {
    if (code !== 0) return res.status(500).json({ error: `exit ${code}`, stderr: err });
    try { res.json(JSON.parse(out)); }
    catch (e) { res.status(500).json({ error: 'bad JSON', raw: out.slice(0, 500), stderr: err }); }
  });
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

return app;
}

// Start listening; resolves with the http.Server once bound.
export function startServer({ root, port = 8080, host = process.env.KRONIKARZ_HOST || DEFAULT_HOST, ...opts } = {}) {
  const app = createApp({ root, ...opts });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
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
