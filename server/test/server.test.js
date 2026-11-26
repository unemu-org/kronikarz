// Run: node --test 'server/test/*.test.js'   (or: npm test -w server)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { createApp, startServer } from '../index.js';

// Request logger is noisy under the test runner.
const origLog = console.log;
console.log = () => {};
after(() => { console.log = origLog; });

const H = { 'X-Kronikarz': '1' };
const JSON_H = { ...H, 'Content-Type': 'application/json' };

let parent; // temp dir holding data/ (the root) and outside/ (symlink targets)
let root;
let server;
let base;
let spawnCalls;
let renameCalls;
let failRename;

// Injected rename: records the atomic-commit step, can simulate a failure.
async function spyRename(from, to) {
  renameCalls.push([from, to]);
  if (failRename) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
  return fs.rename(from, to);
}

// Stub for child_process.spawn: records argv, answers with `{"ok":true}`.
function fakeSpawn(cmd, args) {
  spawnCalls.push({ cmd, args });
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from('{"ok":true,"gates":0}'));
    proc.emit('close', 0);
  });
  return proc;
}
const fakeUv = (args) => ({ cmd: 'fake-uv', args });

async function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kronikarz-test-'));
  root = path.join(parent, 'data');
  await fs.mkdir(root);
  server = await listen(createApp({ root, spawn: fakeSpawn, uvCommand: fakeUv, rename: spyRename }));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(parent, { recursive: true, force: true });
});

beforeEach(async () => {
  spawnCalls = [];
  renameCalls = [];
  failRename = false;
  const pages = path.join(root, 'MJC-400', 'P-A3-2', 'pages');
  await fs.rm(path.join(root, 'MJC-400'), { recursive: true, force: true });
  await fs.mkdir(pages, { recursive: true });
  await fs.writeFile(path.join(pages, '2-85.sch.yaml'), 'current\n');
});

const pageFile = (...p) => path.join(root, 'MJC-400', 'P-A3-2', 'pages', ...p);
const post = (url, body, headers = JSON_H) =>
  fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });

// --- kr-0sn.1: bind + CSRF header + no CORS --------------------------------

test('listens on 127.0.0.1 by default', async () => {
  const saved = process.env.KRONIKARZ_HOST;
  delete process.env.KRONIKARZ_HOST;
  try {
    const s = await startServer({ root, port: 0 });
    try {
      assert.equal(s.address().address, '127.0.0.1');
    } finally {
      await new Promise((r) => s.close(r));
    }
  } finally {
    if (saved !== undefined) process.env.KRONIKARZ_HOST = saved;
  }
});

test('PUT /files without X-Kronikarz → 403, nothing written', async () => {
  const r = await fetch(`${base}/files/x.txt`, { method: 'PUT', body: 'evil' });
  assert.equal(r.status, 403);
  assert.equal(existsSync(path.join(root, 'x.txt')), false);
});

test('PUT /files with wrong header value → 403', async () => {
  const r = await fetch(`${base}/files/x.txt`, { method: 'PUT', headers: { 'X-Kronikarz': '0' }, body: 'evil' });
  assert.equal(r.status, 403);
});

test('PUT /files with X-Kronikarz: 1 → 200, written', async () => {
  const r = await fetch(`${base}/files/x.txt`, { method: 'PUT', headers: H, body: 'hello' });
  assert.equal(r.status, 200);
  assert.equal(await fs.readFile(path.join(root, 'x.txt'), 'utf-8'), 'hello');
});

test('DELETE /files without header → 403 (file kept), with → 200', async () => {
  const f = path.join(root, 'del.txt');
  await fs.writeFile(f, 'x');
  let r = await fetch(`${base}/files/del.txt`, { method: 'DELETE' });
  assert.equal(r.status, 403);
  assert.equal(existsSync(f), true);
  r = await fetch(`${base}/files/del.txt`, { method: 'DELETE', headers: H });
  assert.equal(r.status, 200);
  assert.equal(existsSync(f), false);
});

test('every POST endpoint without header → 403, no spawn', async () => {
  const body = { package: 'P-A3-2', page: '2-85', x: 1, y: 1, w: 1, h: 1, zones: [] };
  for (const ep of ['/ai-detect', '/vision-page', '/vision-page-zones', '/make-bak', '/restore-bak', '/yolo-export']) {
    // text/plain = "simple" CORS request, no preflight in the browser
    const r = await fetch(base + ep, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
    assert.equal(r.status, 403, ep);
  }
  assert.equal(spawnCalls.length, 0);
});

test('POST with header works (make-bak, vision-page via stubbed spawn)', async () => {
  let r = await post('/make-bak', { package: 'P-A3-2', page: '2-85' });
  assert.equal(r.status, 200);
  assert.equal(await fs.readFile(pageFile('2-85.sch.yaml.bak'), 'utf-8'), 'current\n');

  r = await post('/vision-page', { package: 'P-A3-2', page: '2-85' });
  assert.equal(r.status, 200);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args.slice(-2), ['P-A3-2', '2-85']);
});

test('GET stays header-free', async () => {
  const r = await fetch(`${base}/files/MJC-400/P-A3-2/pages/2-85.sch.yaml`);
  assert.equal(r.status, 200);
});

test('CORS preflight from foreign Origin gets no Access-Control-Allow-*', async () => {
  for (const p of ['/files/x.txt', '/vision-page']) {
    const r = await fetch(base + p, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://evil.example',
        'Access-Control-Request-Method': p.startsWith('/files') ? 'PUT' : 'POST',
        'Access-Control-Request-Headers': 'x-kronikarz, content-type',
      },
    });
    const acHeaders = [...r.headers.keys()].filter((k) => k.startsWith('access-control-allow'));
    assert.deepEqual(acHeaders, [], p);
  }
  const g = await fetch(`${base}/health`, { headers: { Origin: 'http://evil.example' } });
  assert.equal(g.headers.get('access-control-allow-origin'), null);
});

// --- kr-0sn.2: path-forming field validation --------------------------------

const BAD = [
  '../x', '..', 'a/b', '/etc/passwd', '', 'a\\b', '.hidden', 'a..b',
  '-rf', '--help', 'a'.repeat(129), 123, null, ['P-A3-2'],
];
const PATH_ENDPOINTS = {
  '/ai-detect': { x: 1, y: 2, w: 3, h: 4 },
  '/vision-page': {},
  '/vision-page-zones': { zones: [] },
  '/make-bak': {},
  '/restore-bak': {},
};

for (const [ep, extra] of Object.entries(PATH_ENDPOINTS)) {
  test(`${ep}: traversal / invalid package or page → 400, no spawn`, async () => {
    for (const bad of BAD) {
      for (const body of [
        { ...extra, package: bad, page: '2-85' },
        { ...extra, package: 'P-A3-2', page: bad },
      ]) {
        const r = await post(ep, body);
        assert.equal(r.status, 400, `${ep} ${JSON.stringify(body)}`);
      }
    }
    assert.equal(spawnCalls.length, 0);
  });
}

test('/restore-bak cannot reach a .bak outside the data root', async () => {
  // A victim file outside root that a traversal would target.
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside`);
  await fs.mkdir(path.join(outside, 'pages'), { recursive: true });
  try {
    await fs.writeFile(path.join(outside, 'pages', 'v.sch.yaml'), 'victim');
    await fs.writeFile(path.join(outside, 'pages', 'v.sch.yaml.bak'), 'pwned');
    const rel = path.relative(path.join(root, 'MJC-400'), outside);
    const r = await post('/restore-bak', { package: rel, page: 'v' });
    assert.equal(r.status, 400);
    assert.equal(await fs.readFile(path.join(outside, 'pages', 'v.sch.yaml'), 'utf-8'), 'victim');
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

// --- kr-0sn.3: restore-bak backs up current file, restores atomically --------

test('/restore-bak: timestamped backup of current file, then restore', async () => {
  await fs.writeFile(pageFile('2-85.sch.yaml.bak'), 'from-bak\n');
  const r = await post('/restore-bak', { package: 'P-A3-2', page: '2-85' });
  assert.equal(r.status, 200);
  const d = await r.json();

  assert.equal(await fs.readFile(pageFile('2-85.sch.yaml'), 'utf-8'), 'from-bak\n');
  // rolling .bak untouched
  assert.equal(await fs.readFile(pageFile('2-85.sch.yaml.bak'), 'utf-8'), 'from-bak\n');

  const files = await fs.readdir(pageFile());
  const ts = files.filter((f) => /^2-85\.sch\.yaml\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/.test(f));
  assert.equal(ts.length, 1, `files: ${files.join(', ')}`);
  assert.equal(await fs.readFile(pageFile(ts[0]), 'utf-8'), 'current\n');
  assert.equal(d.backup, pageFile(ts[0]));
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
});

test('/restore-bak: missing .bak → 404, current file untouched', async () => {
  const r = await post('/restore-bak', { package: 'P-A3-2', page: '2-85' });
  assert.equal(r.status, 404);
  assert.equal(await fs.readFile(pageFile('2-85.sch.yaml'), 'utf-8'), 'current\n');
  assert.deepEqual((await fs.readdir(pageFile())).sort(), ['2-85.sch.yaml']);
});

test('/restore-bak: write goes through tmp + rename onto the page (atomic)', async () => {
  await fs.writeFile(pageFile('2-85.sch.yaml.bak'), 'from-bak\n');
  const r = await post('/restore-bak', { package: 'P-A3-2', page: '2-85' });
  assert.equal(r.status, 200);
  assert.equal(renameCalls.length, 1);
  const [from, to] = renameCalls[0];
  assert.equal(to, pageFile('2-85.sch.yaml'));
  assert.equal(path.dirname(from), pageFile());
  assert.match(path.basename(from), /^2-85\.sch\.yaml\.[0-9a-f]+\.tmp$/);
});

test('/restore-bak: failed commit leaves page, no tmp, no orphan backup', async () => {
  await fs.writeFile(pageFile('2-85.sch.yaml.bak'), 'from-bak\n');
  failRename = true;
  const r = await post('/restore-bak', { package: 'P-A3-2', page: '2-85' });
  assert.equal(r.status, 500);
  assert.equal(await fs.readFile(pageFile('2-85.sch.yaml'), 'utf-8'), 'current\n');
  assert.deepEqual((await fs.readdir(pageFile())).sort(), ['2-85.sch.yaml', '2-85.sch.yaml.bak']);
});

test('/restore-bak: unreadable .bak leaves no orphan backup', async () => {
  await fs.mkdir(pageFile('2-85.sch.yaml.bak')); // a directory, readFile → EISDIR
  const r = await post('/restore-bak', { package: 'P-A3-2', page: '2-85' });
  assert.equal(r.status, 500);
  assert.equal(await fs.readFile(pageFile('2-85.sch.yaml'), 'utf-8'), 'current\n');
  assert.deepEqual((await fs.readdir(pageFile())).sort(), ['2-85.sch.yaml', '2-85.sch.yaml.bak']);
});

test('segment length limit: 128 chars allowed, 129 rejected', async () => {
  let r = await post('/make-bak', { package: 'P-A3-2', page: 'a'.repeat(128) });
  assert.equal(r.status, 404); // passed validation, page simply does not exist
  r = await post('/make-bak', { package: 'P-A3-2', page: 'a'.repeat(129) });
  assert.equal(r.status, 400);
});

// --- kr-0sn.10: DNS rebinding (Host allowlist) ------------------------------

// fetch() won't let us forge Host, so use node:http directly.
function rawRequest({ method = 'GET', path: p = '/health', host, headers = {}, body }) {
  const { port } = server.address();
  const h = { ...headers };
  if (host !== undefined) h.Host = host;
  if (body !== undefined) h['Content-Type'] = 'application/octet-stream';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('foreign Host header → 403 on GET and PUT (even with X-Kronikarz)', async () => {
  for (const host of ['evil.example', 'evil.example:8080', '127.0.0.1.evil.example', 'localhost.evil:80', 'localhost:80@evil']) {
    let r = await rawRequest({ host });
    assert.equal(r.status, 403, `GET Host=${host}`);
    r = await rawRequest({ method: 'PUT', path: '/files/rebind.txt', host, headers: H, body: 'x' });
    assert.equal(r.status, 403, `PUT Host=${host}`);
  }
  assert.equal(existsSync(path.join(root, 'rebind.txt')), false);
});

test('request without any Host header (HTTP/1.0) → 403', async () => {
  const { port } = server.address();
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.end('GET /health HTTP/1.0\r\n\r\n'));
    let buf = '';
    sock.on('data', (c) => (buf += c));
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.\d 403/);
});

test('loopback Host names (with/without port) are accepted', async () => {
  for (const host of ['localhost', 'localhost:5173', 'LOCALHOST:8080', '127.0.0.1', '127.0.0.1:8080', '[::1]', '[::1]:8080']) {
    const r = await rawRequest({ host });
    assert.equal(r.status, 200, `GET Host=${host}`);
    const w = await rawRequest({ method: 'PUT', path: '/files/ok.txt', host, headers: H, body: host });
    assert.equal(w.status, 200, `PUT Host=${host}`);
  }
});

// --- kr-0sn.2: /files root, directories, tmp hygiene ------------------------

const tmpLeftovers = async (dir) => (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));

test('PUT/DELETE /files/ (data root itself) → 400, no tmp next to data dir', async () => {
  let r = await fetch(`${base}/files/`, { method: 'PUT', headers: H, body: 'x' });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/files/`, { method: 'DELETE', headers: H });
  assert.equal(r.status, 400);
  assert.deepEqual(await tmpLeftovers(parent), []);
  assert.equal(existsSync(root), true);
});

test('PUT/DELETE on an existing directory → 400, no tmp, dir kept', async () => {
  await fs.mkdir(path.join(root, 'somedir'), { recursive: true });
  let r = await fetch(`${base}/files/somedir`, { method: 'PUT', headers: H, body: 'x' });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/files/somedir`, { method: 'DELETE', headers: H });
  assert.equal(r.status, 400);
  assert.deepEqual(await tmpLeftovers(root), []);
  assert.equal((await fs.stat(path.join(root, 'somedir'))).isDirectory(), true);
});

test('PUT /files writes via tmp + rename; no tmp left', async () => {
  const r = await fetch(`${base}/files/MJC-400/P-A3-2/pages/2-85.sch.yaml`, { method: 'PUT', headers: H, body: 'new\n' });
  assert.equal(r.status, 200);
  assert.equal(renameCalls.length, 1);
  const [from, to] = renameCalls[0];
  assert.equal(to, pageFile('2-85.sch.yaml'));
  assert.match(path.basename(from), /^2-85\.sch\.yaml\.[0-9a-f]+\.tmp$/);
  assert.equal(await fs.readFile(pageFile('2-85.sch.yaml'), 'utf-8'), 'new\n');
  assert.deepEqual(await tmpLeftovers(pageFile()), []);
});

test('PUT /files: failed commit keeps old content and removes tmp', async () => {
  failRename = true;
  const r = await fetch(`${base}/files/MJC-400/P-A3-2/pages/2-85.sch.yaml`, { method: 'PUT', headers: H, body: 'new\n' });
  assert.equal(r.status, 500);
  assert.equal(await fs.readFile(pageFile('2-85.sch.yaml'), 'utf-8'), 'current\n');
  assert.deepEqual(await tmpLeftovers(pageFile()), []);
});

// --- kr-0sn.2: symlinks inside the data dir must not lead outside -----------

test('symlinks out of the data root are refused (files, list, POST, .bak)', async () => {
  const outside = path.join(parent, 'outside');
  await fs.rm(outside, { recursive: true, force: true });
  await fs.mkdir(path.join(outside, 'pages'), { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.writeFile(path.join(outside, 'pages', '2-85.sch.yaml'), 'victim');
  const links = [path.join(root, 'linkdir'), path.join(root, 'MJC-400', 'EVIL'), path.join(root, 'dangling')];
  await fs.symlink(outside, links[0]);
  await fs.symlink(outside, links[1]);
  await fs.symlink(path.join(outside, 'nope'), links[2]);
  await fs.symlink(path.join(outside, 'secret.txt'), pageFile('2-85.sch.yaml.bak'));
  try {
    let r = await fetch(`${base}/files/linkdir/secret.txt`);
    assert.equal(r.status, 403, 'GET through symlinked dir');
    r = await fetch(`${base}/list/linkdir`);
    assert.equal(r.status, 403, 'list symlinked dir');
    r = await fetch(`${base}/files/linkdir/new.txt`, { method: 'PUT', headers: H, body: 'x' });
    assert.equal(r.status, 403, 'PUT through symlinked dir');
    r = await fetch(`${base}/files/linkdir/secret.txt`, { method: 'DELETE', headers: H });
    assert.equal(r.status, 403, 'DELETE through symlinked dir');
    r = await fetch(`${base}/files/dangling/x.txt`, { method: 'PUT', headers: H, body: 'x' });
    assert.equal(r.status, 403, 'PUT through dangling symlink');
    for (const ep of ['/vision-page', '/vision-page-zones', '/make-bak', '/restore-bak', '/ai-detect']) {
      r = await post(ep, { package: 'EVIL', page: '2-85', zones: [], x: 1, y: 1, w: 1, h: 1 });
      assert.equal(r.status, 403, `${ep} via symlinked package dir`);
    }
    r = await post('/restore-bak', { package: 'P-A3-2', page: '2-85' });
    assert.equal(r.status, 403, 'restore from symlinked .bak');
    assert.equal(spawnCalls.length, 0);
    assert.equal(await fs.readFile(pageFile('2-85.sch.yaml'), 'utf-8'), 'current\n');
    assert.deepEqual((await fs.readdir(outside)).sort(), ['pages', 'secret.txt']);
    assert.deepEqual(await fs.readdir(path.join(outside, 'pages')), ['2-85.sch.yaml']);
    assert.equal(await fs.readFile(path.join(outside, 'pages', '2-85.sch.yaml'), 'utf-8'), 'victim');
  } finally {
    for (const l of links) await fs.rm(l, { force: true });
  }
});

// --- entry point: runs main() also when started through a symlink ----------

test('CLI starts when index.js is invoked through a symlinked path', async () => {
  const real = url.fileURLToPath(new URL('../index.js', import.meta.url));
  const link = path.join(parent, 'index-link.js');
  await fs.rm(link, { force: true });
  await fs.symlink(real, link);
  const child = spawn(process.execPath, [link], {
    env: {
      PATH: path.dirname(process.execPath), // keeps the uv/nix probe fast and local
      HOME: parent,
      UV_PATH: '/nonexistent-uv',
      KRONIKARZ_DATA: root,
      KRONIKARZ_PORT: '0',
      KRONIKARZ_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error(`no startup line; got: ${buf}`)), 10000);
      child.stdout.on('data', (b) => {
        buf += b;
        if (/kronikarz-server: http:\/\/127\.0\.0\.1:\d+/.test(buf)) { clearTimeout(t); resolve(buf); }
      });
      child.on('exit', (code) => { clearTimeout(t); reject(new Error(`exited ${code}; got: ${buf}`)); });
    });
    assert.match(out, /kronikarz-server: http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    child.kill();
  }
});
