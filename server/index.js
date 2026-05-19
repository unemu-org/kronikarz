import express from 'express';
import cors from 'cors';
import { promises as fs, createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// Repo root: server/ → ..
const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// Load .env from repo root if present
const envFile = path.join(REPO, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const ROOT = path.resolve(REPO, process.env.KRONIKARZ_DATA || './data');
const PORT = Number(process.env.KRONIKARZ_PORT || 8080);

const app = express();
app.use(cors());
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} → ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

function safeResolve(rel) {
  const resolved = path.resolve(ROOT, rel);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

app.get('/health', (_req, res) => res.json({ ok: true, root: ROOT }));

app.get('/files/*', async (req, res) => {
  const abs = safeResolve(req.params[0]);
  if (!abs) return res.status(403).json({ error: 'path traversal' });
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is a directory' });
    res.setHeader('Content-Length', stat.size);
    createReadStream(abs).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/files/*', async (req, res) => {
  const abs = safeResolve(req.params[0]);
  if (!abs) return res.status(403).json({ error: 'path traversal' });
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, req.body);
    await fs.rename(tmp, abs);
    res.json({ ok: true, bytes: req.body.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/files/*', async (req, res) => {
  const abs = safeResolve(req.params[0]);
  if (!abs) return res.status(403).json({ error: 'path traversal' });
  try {
    await fs.unlink(abs);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: err.message });
  }
});

async function listDir(rel, res) {
  const abs = safeResolve(rel);
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

// --- AI-assisted ROI detection ----------------------------------------------

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

app.post('/ai-detect', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page, x, y, w, h } = body || {};
  if (!pkg || !page || ![x, y, w, h].every((n) => Number.isFinite(n))) {
    return res.status(400).json({ error: 'need {package, page, x, y, w, h}', got: body });
  }
  const script = path.join(REPO, 'scripts/ai-detect-roi.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'detect script missing' });

  const { cmd, args } = uvCommand(['run', script]);
  if (!cmd) return res.status(500).json({ error: 'uv not found; start server inside `nix develop` or install uv' });
  const proc = spawn(cmd, args, { cwd: REPO });
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
  const yamlPath = path.join(ROOT, 'MJC-400', pkg, 'pages', `${page}.sch.yaml`);

  // Backup BEFORE running vision — keep rolling .bak + timestamped (only if file exists).
  if (existsSync(yamlPath)) {
    try {
      const bakPath = `${yamlPath}.bak`;
      await fs.copyFile(yamlPath, bakPath);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.copyFile(yamlPath, `${yamlPath}.${ts}.bak`);
    } catch (e) {
      return res.status(500).json({ error: `backup failed: ${e.message}` });
    }
  }

  const script = path.join(REPO, 'scripts/vision-page.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'vision-page script missing' });
  const { cmd, args } = uvCommand(['run', script, pkg, page]);
  if (!cmd) return res.status(500).json({ error: 'uv not found' });

  const proc = spawn(cmd, args, { cwd: REPO });
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
  const yamlPath = path.join(ROOT, 'MJC-400', pkg, 'pages', `${page}.sch.yaml`);

  if (existsSync(yamlPath)) {
    try {
      const bakPath = `${yamlPath}.bak`;
      await fs.copyFile(yamlPath, bakPath);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.copyFile(yamlPath, `${yamlPath}.${ts}.bak`);
    } catch (e) {
      return res.status(500).json({ error: `backup failed: ${e.message}` });
    }
  }

  const script = path.join(REPO, 'scripts/vision-zones.py');
  if (!existsSync(script)) return res.status(500).json({ error: 'vision-zones script missing' });
  const { cmd, args } = uvCommand(['run', script, pkg, page]);
  if (!cmd) return res.status(500).json({ error: 'uv not found' });

  const proc = spawn(cmd, args, { cwd: REPO });
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

app.post('/make-bak', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page } = body || {};
  if (!pkg || !page) return res.status(400).json({ error: 'need {package, page}' });
  const yamlPath = path.join(ROOT, 'MJC-400', pkg, 'pages', `${page}.sch.yaml`);
  if (!existsSync(yamlPath)) return res.status(404).json({ error: 'page yaml not found' });
  try {
    const bakPath = `${yamlPath}.bak`;
    await fs.copyFile(yamlPath, bakPath);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const tsPath = `${yamlPath}.${ts}.bak`;
    await fs.copyFile(yamlPath, tsPath);
    res.json({ ok: true, bak: bakPath, timestamped: tsPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/restore-bak', async (req, res) => {
  const body = parseJsonBody(req);
  const { package: pkg, page } = body || {};
  if (!pkg || !page) return res.status(400).json({ error: 'need {package, page}' });
  const yamlPath = path.join(ROOT, 'MJC-400', pkg, 'pages', `${page}.sch.yaml`);
  const bakPath = `${yamlPath}.bak`;
  if (!existsSync(bakPath)) return res.status(404).json({ error: 'no .bak file' });
  try {
    await fs.copyFile(bakPath, yamlPath);
    res.json({ ok: true, restored: bakPath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
  const { cmd, args: uvArgs } = uvCommand(args);
  if (!cmd) return res.status(500).json({ error: 'uv not found; start server inside `nix develop` or install uv' });
  const proc = spawn(cmd, uvArgs, { cwd: REPO });
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

// Probe uv at startup
{
  const r = resolveUv();
  if (r.cmd) console.log(`uv resolved: ${r.cmd} ${r.prefix.join(' ')}`);
  else console.warn('uv NOT found. AI features will fail. Start server inside `nix develop` or install uv.');
}

app.listen(PORT, () => {
  console.log(`kronikarz-server: http://localhost:${PORT}`);
  console.log(`  data root: ${ROOT}`);
});
