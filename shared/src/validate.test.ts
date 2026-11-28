// Run: npm test -w shared. Issue.page (walidacja między stronami) i
// Issue.scope (rejestr pakietu) — viewer filtruje po nich walidację kroku.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePackage, parsePage, parseIcMap } from './parse.ts';
import { validatePackage, validatePackagePages, validatePage } from './validate.ts';

const pkg = parsePackage(`
kronikarz: "1"
package:
  id: P-1
  name: test
  doc: x
  status: raw
  pages:
    - { id: "2-1", sheet: 1 }
    - { id: "2-2", sheet: 2 }
components:
  M1: { ic: "9999", gates: {} }
`);

const page = (id: string, xrefs: string) =>
  parsePage(`
kronikarz: "1"
page: "${id}"
package: P-1
scan_size: [100, 100]
gates: []
power: []
nets: {}
cross_refs: ${xrefs}
`);

test('validatePackagePages: CROSS_REF_* mają page = strona z odsyłaczem', () => {
  const pages = new Map([
    ['2-1', page('2-1', '[{label: A, pages: ["2"], net: A, x: 0, y: 0, side: left}, {label: B, pages: ["7"], net: B, x: 0, y: 9, side: left}]')],
    ['2-2', page('2-2', '[]')],
  ]);
  const issues = validatePackagePages(pkg, pages);
  const byCode = Object.fromEntries(issues.map((i) => [i.code, i]));
  assert.equal(byCode.CROSS_REF_NO_RETURN?.page, '2-1');
  assert.equal(byCode.CROSS_REF_NO_RETURN?.ref, 'A');
  assert.equal(byCode.CROSS_REF_UNKNOWN_PAGE?.page, '2-1');
  assert.equal(issues.length, 2);
});

test('IC_UNKNOWN_SUFFIX: z rejestru pakietu ma scope package, ze strony nie', () => {
  const icMap = parseIcMap('kronikarz: "1"\n"00": { name: NAND, kicad: "74xx:7400" }\n');
  const fromPkg = validatePackage(pkg, icMap).filter((i) => i.code === 'IC_UNKNOWN_SUFFIX');
  assert.equal(fromPkg.length, 1);
  assert.equal(fromPkg[0]!.scope, 'package');
  const p = parsePage(`
kronikarz: "1"
page: "2-1"
package: P-1
scan_size: [100, 100]
gates: [{ref: M1, gate: A, x: 10, y: 10, rotation: 0, pins: [], verified: false, note: null}]
power: []
nets: {}
`);
  const fromPage = validatePage(p, pkg, icMap).filter((i) => i.code === 'IC_UNKNOWN_SUFFIX');
  assert.equal(fromPage.length, 1);
  assert.equal(fromPage[0]!.scope, undefined);
});
