import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProject, loadPackage, loadPage, writeProject, writePackage, writePage } from './io.ts';
import { pinId, parsePinId } from './parse.ts';
import { validatePage, validatePackage, validateProject } from './validate.ts';
import type { Project, Package, Page, IcMap } from './types.ts';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'kronikarz-test-'));
}

test('pinId / parsePinId round-trip IC', () => {
  const id = pinId('M5', 'A', 1);
  assert.equal(id, 'M5.A.1');
  assert.deepEqual(parsePinId(id), { ref: 'M5', gate: 'A', num: 1 });
});

test('pinId / parsePinId round-trip passive', () => {
  const id = pinId('R1', null, 2);
  assert.equal(id, 'R1.2');
  assert.deepEqual(parsePinId(id), { ref: 'R1', gate: null, num: 2 });
});

test('parsePinId rejects garbage', () => {
  assert.throws(() => parsePinId('foo'));
  assert.throws(() => parsePinId('M5.A.B'));
});

test('project.yaml round-trip', async () => {
  const dir = await tmpDir();
  const proj: Project = {
    kronikarz: '1',
    project: { name: 'MJC-400', desc: 'test', doc: '12-006368-01-8A', status: 'wip' },
    packages: [
      { id: 'P-X3-2', name: 'Pakiet X', file: 'P-X3-2/package.yaml', status: 'wip' },
      { id: 'P-M3-2', name: 'Pakiet M', file: 'P-M3-2/package.yaml', status: 'raw' },
    ],
    backplane: [
      {
        signal: '+K1',
        from: { package: 'P-X3-2', connector_pin: 'A23' },
        to: { package: 'P-M3-2', connector_pin: 'B15' },
      },
    ],
  };
  const fp = path.join(dir, 'project.yaml');
  await writeProject(fp, proj);
  const back = await loadProject(fp);
  assert.deepEqual(back, proj);
  assert.deepEqual(validateProject(back), []);
});

test('package.yaml round-trip', async () => {
  const dir = await tmpDir();
  const pkg: Package = {
    kronikarz: '1',
    package: {
      id: 'P-X3-2',
      name: 'Pakiet X',
      doc: '12-006368-01-8A',
      status: 'wip',
      pages: [
        { id: '2-1', file: 'pages/2-1.sch.yaml', scan: 'scans/2-1.jpg', title: '...', status: 'wip' },
      ],
    },
    components: {
      M5: {
        ic: '04',
        gates: { A: { page: '2-1' }, B: { page: '2-1' }, C: null },
      },
      R1: {
        ic: null,
        type: 'resistor',
        value: '1k',
        pages: ['2-1'],
      },
    },
  };
  const fp = path.join(dir, 'package.yaml');
  await writePackage(fp, pkg);
  const back = await loadPackage(fp);
  assert.deepEqual(back, pkg);
  assert.deepEqual(validatePackage(back), []);
});

test('sch.yaml round-trip + validation catches floating net', async () => {
  const dir = await tmpDir();
  const page: Page = {
    kronikarz: '1',
    page: '2-1',
    package: 'P-X3-2',
    scan_size: [1654, 1169],
    gates: [
      {
        ref: 'M5',
        gate: 'A',
        x: 340,
        y: 120,
        rotation: 0,
        pins: [
          { num: 1, side: 'left', net: 'NET_A', px: 310, py: 120 },
          { num: 2, side: 'right', net: 'NET_B', px: 370, py: 120 },
        ],
        verified: false,
        note: null,
      },
    ],
    power: [],
    nets: {
      NET_A: { pins: ['M5.A.1'], segments: null, junctions: null }, // floating
      NET_B: { pins: ['M5.A.2', 'M5.A.1'], segments: null, junctions: null },
    },
    annotations: [],
  };
  const fp = path.join(dir, '2-1.sch.yaml');
  await writePage(fp, page);
  const back = await loadPage(fp);
  assert.deepEqual(back, page);

  const pkg: Package = {
    kronikarz: '1',
    package: { id: 'P-X3-2', name: 'X', doc: '', status: 'wip', pages: [] },
    components: { M5: { ic: '04', gates: { A: { page: '2-1' } } } },
  };
  const icMap: IcMap = {
    '04': { kicad_symbol: '74xx:SN7404N', pins: 14, gates: 6 },
  };
  const issues = validatePage(back, pkg, icMap);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('NET_FLOATING'));
  assert.ok(codes.includes('NET_NO_SEGMENTS'));
});

test('wrong format version rejected', async () => {
  const dir = await tmpDir();
  const fp = path.join(dir, 'bad.yaml');
  await fs.writeFile(fp, 'kronikarz: "2"\nfoo: bar\n');
  await assert.rejects(() => loadProject(fp), /kronikarz/);
});

test('labels with leading - are quoted', async () => {
  const dir = await tmpDir();
  const proj: Project = {
    kronikarz: '1',
    project: { name: 'X', desc: '', doc: '', status: 'wip' },
    packages: [],
    backplane: [
      {
        signal: '-K1',
        from: { package: 'A', connector_pin: 'A1' },
        to: { package: 'B', connector_pin: 'B1' },
      },
    ],
  };
  const fp = path.join(dir, 'p.yaml');
  await writeProject(fp, proj);
  const text = await fs.readFile(fp, 'utf-8');
  assert.match(text, /"-K1"|'-K1'/);
});
