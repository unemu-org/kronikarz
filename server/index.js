import express from 'express';
import cors from 'cors';
import { promises as fs, createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { randomBytes } from 'node:crypto';

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

app.listen(PORT, () => {
  console.log(`kronikarz-server: http://localhost:${PORT}`);
  console.log(`  data root: ${ROOT}`);
});
