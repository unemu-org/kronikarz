import type { Project, Package, Page, IcMap, IcComponent, Component } from './types.ts';
import { parsePinId, resolveIcKey } from './parse.ts';

function backplaneConnectorsForPackage(project: Project | undefined, pkgId: string): Set<string> {
  if (!project) return new Set();
  const conns = new Set<string>();
  for (const s of project.backplane) {
    for (const ep of s.endpoints) {
      if (ep.package === pkgId) conns.add(`${ep.connector}${ep.pin}`);
    }
  }
  return conns;
}

export type IssueLevel = 'err' | 'warn' | 'info';

export interface Issue {
  level: IssueLevel;
  code: string;
  message: string;
  ref?: string;
}

function isIc(c: Component): c is IcComponent {
  return c.ic !== null;
}

export function validatePage(page: Page, pkg?: Package, icMap?: IcMap, project?: Project): Issue[] {
  const issues: Issue[] = [];

  if (page.ports && pkg) {
    const known = backplaneConnectorsForPackage(project, page.package);
    const haveProject = project !== undefined;
    for (const port of page.ports) {
      const pid = `${port.connector}${port.pin}`;
      if (!page.nets[port.net]) {
        issues.push({
          level: 'warn',
          code: 'PORT_NET_MISSING',
          message: `port ${pid} references net "${port.net}" which has no entry in page.nets`,
          ref: port.net,
        });
      }
      if (haveProject && !known.has(pid)) {
        issues.push({
          level: 'warn',
          code: 'PORT_NOT_ON_BACKPLANE',
          message: `port ${pid} (${port.label}) does not appear in project.yaml backplane for package "${page.package}"`,
          ref: pid,
        });
      }
    }
  }

  if (page.package !== pkg?.package.id && pkg) {
    issues.push({
      level: 'err',
      code: 'PAGE_PACKAGE_MISMATCH',
      message: `page.package="${page.package}" but loaded package.id="${pkg.package.id}"`,
    });
  }

  // Gate refs must exist in package.components
  for (let i = 0; i < page.gates.length; i++) {
    const gate = page.gates[i]!;
    const ref = gate.ref;
    if (pkg && !(ref in pkg.components)) {
      issues.push({
        level: 'err',
        code: 'GATE_UNKNOWN_REF',
        message: `gate references "${ref}" which is not in package.components`,
        ref,
      });
      continue;
    }
    if (pkg) {
      const comp = pkg.components[ref];
      if (comp && isIc(comp) && (gate.gate === null || gate.gate === undefined || String(gate.gate).trim() === '')) {
        issues.push({
          level: 'err',
          code: 'GATE_LETTER_MISSING',
          message: `${ref} jest IC ale gate ma puste pole "gate" — wybierz litere bramki (A/B/C/...) [idx=${i}]`,
          ref: `${ref}#${i}`,
        });
      }
    }
    if (pkg && gate.gate !== null) {
      const comp = pkg.components[ref];
      if (comp && isIc(comp)) {
        if (!(gate.gate in comp.gates)) {
          issues.push({
            level: 'err',
            code: 'GATE_UNKNOWN_LETTER',
            message: `${ref}.${gate.gate} not declared in package.components["${ref}"].gates`,
            ref: `${ref}.${gate.gate}`,
          });
        }
        // ic_map lookup (with normalization for Polish prefixes like H, MH, UCY)
        const resolvedKey = icMap ? resolveIcKey(comp.ic, icMap) : null;
        if (icMap && !resolvedKey) {
          issues.push({
            level: 'warn',
            code: 'IC_UNKNOWN_SUFFIX',
            message: `IC suffix "${comp.ic}" for ${ref} not in ic_map`,
            ref,
          });
        }
        // Per-gate pinout vs ic_map.gate_pins[letter]
        if (icMap && resolvedKey && gate.gate) {
          const icDef = icMap[resolvedKey]!;
          const spec = icDef.gate_pins?.[gate.gate];
          if (spec) {
            const expected = new Set<number>();
            for (const arr of Object.values(spec)) if (Array.isArray(arr)) for (const n of arr) expected.add(n);
            const actual = new Set<number>(gate.pins.map((p) => p.num));
            for (const n of actual) {
              if (!expected.has(n)) {
                issues.push({
                  level: 'err',
                  code: 'GATE_PIN_INVALID',
                  message: `${ref}.${gate.gate} has pin ${n} which is not in 74${resolvedKey} gate ${gate.gate} pinout (expected: ${[...expected].sort((a, b) => a - b).join(',')})`,
                  ref: `${ref}.${gate.gate}`,
                });
              }
            }
            for (const n of expected) {
              if (!actual.has(n)) {
                issues.push({
                  level: 'warn',
                  code: 'GATE_PIN_MISSING',
                  message: `${ref}.${gate.gate} is missing pin ${n} per 74${resolvedKey} spec`,
                  ref: `${ref}.${gate.gate}`,
                });
              }
            }
          }
        }
      }
    }
  }

  // Net connectivity: if a net has segments drawn, all pins/ports/cross_refs
  // sharing the net name must be reachable via segments+junctions. Otherwise
  // the user labeled disconnected wires with the same name by mistake.
  {
    const TOL = 8; // px tolerance (matches PIN_NUDGE)
    const portOpenEnd = (p: { x: number; y: number; side: string; connector: string; pin: number }) => {
      const pid = `${p.connector}${p.pin}`;
      const labelWidth = Math.max(60, pid.length * 16 + 12);
      const bw = labelWidth + 16;
      const rot = p.side === 'left' ? 0 : p.side === 'right' ? 180 : p.side === 'top' ? 90 : 270;
      const rad = (rot * Math.PI) / 180;
      return { x: Math.round(p.x + bw * Math.cos(rad)), y: Math.round(p.y + bw * Math.sin(rad)) };
    };
    type Pt = { x: number; y: number; tag: string };
    const collect = (netName: string): Pt[] => {
      const out: Pt[] = [];
      for (const g of page.gates) {
        for (const pin of g.pins) {
          if (pin.disconnected) continue;
          if (pin.net === netName) out.push({ x: pin.px, y: pin.py, tag: `${g.ref}${g.gate ? '.' + g.gate : ''}.${pin.num}` });
        }
      }
      for (const port of page.ports ?? []) {
        if (port.net === netName) {
          const oe = portOpenEnd(port);
          out.push({ x: oe.x, y: oe.y, tag: `port:${port.connector}` });
        }
      }
      for (const cr of page.cross_refs ?? []) {
        if (cr.net === netName) out.push({ x: cr.x, y: cr.y, tag: `xref:${cr.label}` });
      }
      for (const ps of page.power ?? []) {
        if (ps.net === netName) out.push({ x: ps.x, y: ps.y, tag: `power:${ps.type}` });
      }
      return out;
    };

    for (const [netName, net] of Object.entries(page.nets)) {
      if (!netName.trim()) continue;
      const eps = collect(netName);
      if (eps.length <= 1) continue;
      const hasSegs = Array.isArray(net.segments) && net.segments.length > 0;
      if (!hasSegs) continue; // raw/dashed net — user hasn't routed yet

      // Union-find on positions (segments + junctions + endpoint positions)
      const parent = new Map<string, string>();
      const k = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
      const find = (a: string): string => {
        const p = parent.get(a);
        if (p === undefined) { parent.set(a, a); return a; }
        if (p === a) return a;
        const r = find(p);
        parent.set(a, r);
        return r;
      };
      const union = (a: string, b: string) => {
        const ra = find(a); const rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
      };
      const ensure = (a: string) => { if (!parent.has(a)) parent.set(a, a); };

      // Snap nearby points to a canonical key
      const canon = (x: number, y: number): string => {
        for (const key of parent.keys()) {
          const parts = key.split(',');
          const kx = Number(parts[0]);
          const ky = Number(parts[1]);
          if (Math.abs(kx - x) <= TOL && Math.abs(ky - y) <= TOL) return key;
        }
        const nk = k(x, y);
        parent.set(nk, nk);
        return nk;
      };

      for (const s of net.segments!) {
        const a = canon(s[0], s[1]);
        const b = canon(s[2], s[3]);
        ensure(a); ensure(b);
        union(a, b);
      }
      for (const j of net.junctions ?? []) {
        canon(j[0], j[1]); // bring into parent map
      }

      const roots = new Set<string>();
      const orphans: string[] = [];
      for (const ep of eps) {
        // does ep coord exist in any cluster (within tolerance)?
        let found: string | null = null;
        for (const key of parent.keys()) {
          const parts = key.split(',');
          const kx = Number(parts[0]);
          const ky = Number(parts[1]);
          if (Math.abs(kx - ep.x) <= TOL && Math.abs(ky - ep.y) <= TOL) { found = key; break; }
        }
        if (!found) orphans.push(ep.tag);
        else roots.add(find(found));
      }

      if (orphans.length > 0) {
        issues.push({
          level: 'err',
          code: 'NET_ORPHAN_ENDPOINT',
          message: `net "${netName}" has endpoints not connected to any drawn segment: ${orphans.join(', ')}`,
          ref: netName,
        });
      }
      if (roots.size > 1) {
        issues.push({
          level: 'err',
          code: 'NET_DISCONNECTED',
          message: `net "${netName}" is split into ${roots.size} disconnected clusters — same name used for unconnected wires`,
          ref: netName,
        });
      }
    }
  }

  // Nets must have ≥1 endpoint (pin/port/cross_ref referencing the net).
  // Source-of-truth: pin.net / port.net / cr.net — NIE legacy net.pins[].
  const netRefCount = new Map<string, number>();
  for (const g of page.gates) for (const pin of g.pins) {
    if (pin.disconnected) continue;
    if (pin.net && pin.net.trim()) netRefCount.set(pin.net, (netRefCount.get(pin.net) ?? 0) + 1);
  }
  for (const port of page.ports ?? []) {
    if (port.net && port.net.trim()) netRefCount.set(port.net, (netRefCount.get(port.net) ?? 0) + 1);
  }
  for (const cr of page.cross_refs ?? []) {
    if (cr.net && cr.net.trim()) netRefCount.set(cr.net, (netRefCount.get(cr.net) ?? 0) + 1);
  }
  for (const ps of page.power ?? []) {
    if (ps.net && ps.net.trim()) netRefCount.set(ps.net, (netRefCount.get(ps.net) ?? 0) + 1);
  }
  for (const [netName, net] of Object.entries(page.nets)) {
    const refs = netRefCount.get(netName) ?? 0;
    if (refs === 0) {
      issues.push({
        level: 'warn',
        code: 'NET_EMPTY',
        message: `net "${netName}" has no pins`,
        ref: netName,
      });
    } else if (refs === 1 && !net.cross) {
      issues.push({
        level: 'err',
        code: 'NET_FLOATING',
        message: `net "${netName}" has only 1 endpoint and no cross-page reference (floating)`,
        ref: netName,
      });
    }
    // Each pin reference parseable
    for (const pid of net.pins) {
      try {
        parsePinId(pid);
      } catch (e) {
        issues.push({
          level: 'err',
          code: 'PIN_ID_MALFORMED',
          message: `net "${netName}" has malformed pin id "${pid}"`,
          ref: netName,
        });
      }
    }
    if (net.segments === null) {
      issues.push({
        level: 'info',
        code: 'NET_NO_SEGMENTS',
        message: `net "${netName}" has no segments (will render as dashed)`,
        ref: netName,
      });
    }
  }

  // ENDPOINT_NET_MISMATCH: pin/port/cr wyglada na podlaczony do netu X, ale
  // ma endpoint.net = Y. Rozroznienie:
  //   - strong: pin == endpoint segmentu (tolerancja TOL) → na pewno podlaczony
  //   - mid-line: pin lezy na srodku segmentu → wymaga junction-dot zeby uznac za connection
  // Inaczej krzyzujace sie druty bez dota generowalyby false positives.
  const TOL = 8;
  const segIndex: Array<{ net: string; coords: [number, number, number, number] }> = [];
  const junctionsByNet = new Map<string, Array<[number, number]>>();
  for (const [n, net] of Object.entries(page.nets)) {
    for (const s of net.segments ?? []) {
      segIndex.push({ net: n, coords: s });
    }
    if (net.junctions) junctionsByNet.set(n, net.junctions);
  }
  const hasJunctionNear = (net: string, x: number, y: number): boolean => {
    const js = junctionsByNet.get(net);
    if (!js) return false;
    for (const [jx, jy] of js) {
      if (Math.abs(jx - x) <= TOL && Math.abs(jy - y) <= TOL) return true;
    }
    return false;
  };
  const onSegEndpoint = (x: number, y: number): string | null => {
    for (const e of segIndex) {
      const s = e.coords;
      if (Math.abs(s[0] - x) <= TOL && Math.abs(s[1] - y) <= TOL) return e.net;
      if (Math.abs(s[2] - x) <= TOL && Math.abs(s[3] - y) <= TOL) return e.net;
      // Mid-line: tylko gdy jest junction-dot tego netu w tym punkcie
      if (s[1] === s[3] && Math.abs(y - s[1]) <= TOL && x > Math.min(s[0], s[2]) + TOL && x < Math.max(s[0], s[2]) - TOL) {
        if (hasJunctionNear(e.net, x, y)) return e.net;
      }
      if (s[0] === s[2] && Math.abs(x - s[0]) <= TOL && y > Math.min(s[1], s[3]) + TOL && y < Math.max(s[1], s[3]) - TOL) {
        if (hasJunctionNear(e.net, x, y)) return e.net;
      }
    }
    return null;
  };
  for (const g of page.gates) {
    for (const pin of g.pins) {
      if (pin.disconnected) continue;
      const segNet = onSegEndpoint(pin.px, pin.py);
      if (segNet && pin.net && segNet !== pin.net) {
        issues.push({
          level: 'err',
          code: 'ENDPOINT_NET_MISMATCH',
          message: `pin ${g.ref}.${pin.num} sits on net "${segNet}" but pin.net="${pin.net}"`,
          ref: pin.net,
        });
      }
    }
  }
  for (const port of page.ports ?? []) {
    const labelWidth = Math.max(60, port.connector.length * 16 + 12);
    const bw = labelWidth + 16;
    const rad = (port.side === 'left' ? 0 : port.side === 'right' ? 180 : port.side === 'top' ? 90 : 270) * Math.PI / 180;
    const ox = Math.round(port.x + bw * Math.cos(rad));
    const oy = Math.round(port.y + bw * Math.sin(rad));
    const segNet = onSegEndpoint(ox, oy);
    if (segNet && port.net && segNet !== port.net) {
      issues.push({
        level: 'err',
        code: 'ENDPOINT_NET_MISMATCH',
        message: `port ${port.connector} sits on net "${segNet}" but port.net="${port.net}"`,
        ref: port.net,
      });
    }
  }
  for (const cr of page.cross_refs ?? []) {
    const segNet = onSegEndpoint(cr.x, cr.y);
    if (segNet && cr.net && segNet !== cr.net) {
      issues.push({
        level: 'err',
        code: 'ENDPOINT_NET_MISMATCH',
        message: `cross_ref ${cr.label} sits on net "${segNet}" but cr.net="${cr.net}"`,
        ref: cr.net,
      });
    }
  }

  // unverified count
  const unverified = page.gates.filter((g) => !g.verified).length;
  if (unverified > 0) {
    issues.push({
      level: 'info',
      code: 'GATES_UNVERIFIED',
      message: `${unverified} gates unverified`,
    });
  }

  return issues;
}

export function validatePackage(pkg: Package, icMap?: IcMap): Issue[] {
  const issues: Issue[] = [];
  const pageIds = new Set(pkg.package.pages.map((p) => p.id));

  for (const [ref, comp] of Object.entries(pkg.components)) {
    if (isIc(comp)) {
      // IC suffix must exist in ic_map (with prefix normalization)
      if (icMap && !resolveIcKey(comp.ic, icMap)) {
        issues.push({
          level: 'warn',
          code: 'IC_UNKNOWN_SUFFIX',
          message: `${ref}.ic="${comp.ic}" not in ic_map`,
          ref,
        });
      }
      // Each gate's page must exist
      for (const [letter, g] of Object.entries(comp.gates)) {
        if (g === null) continue;
        if (!pageIds.has(g.page)) {
          issues.push({
            level: 'err',
            code: 'GATE_PAGE_UNKNOWN',
            message: `${ref}.${letter} declared on page "${g.page}" which is not in package.pages`,
            ref: `${ref}.${letter}`,
          });
        }
      }
      // Unused gates: ic_map.gate_pins enumerates all letters; comp.gates has only used.
      if (icMap) {
        const resolved = resolveIcKey(comp.ic, icMap);
        const icDef = resolved ? icMap[resolved] : null;
        const expected = icDef?.gate_pins ? Object.keys(icDef.gate_pins) : [];
        const used = new Set(
          Object.entries(comp.gates)
            .filter(([, v]) => v !== null)
            .map(([k]) => k),
        );
        const unused = expected.filter((l) => !used.has(l));
        if (unused.length > 0) {
          issues.push({
            level: 'warn',
            code: 'GATE_UNUSED',
            message: `${ref} (74${resolved}) ma niewykorzystane bramki: ${unused.join(', ')}`,
            ref,
          });
        }
      }
    } else {
      // passive — pages must exist
      for (const p of comp.pages) {
        if (!pageIds.has(p)) {
          issues.push({
            level: 'err',
            code: 'PASSIVE_PAGE_UNKNOWN',
            message: `passive ${ref} references page "${p}" which is not in package.pages`,
            ref,
          });
        }
      }
    }
  }

  return issues;
}

// Cross-page validation: dla kazdego cross_ref na stronie A sprawdz ze docelowe
// strony pakietu maja matching cross_ref z ta sama nazwa neta.
export function validatePackagePages(pkg: Package, pages: Map<string, Page>): Issue[] {
  const issues: Issue[] = [];
  // Mapa: sheet_number (as string) -> pageId. Lookup `cross_ref.pages` przez sheet num.
  const sheetToPageId = new Map<string, string>();
  for (const p of pkg.package.pages) {
    if (p.sheet !== undefined && p.sheet !== null) {
      sheetToPageId.set(String(p.sheet), p.id);
    }
    sheetToPageId.set(p.id, p.id); // fallback gdy cross_ref uzywa pelnego ID
  }
  // Indeks: pageId -> Set<netName> ktore maja cross_refs zadeklarowane na tej stronie
  const crossNetsByPage = new Map<string, Set<string>>();
  for (const [pid, page] of pages) {
    const set = new Set<string>();
    for (const cr of page.cross_refs ?? []) {
      if (cr.net && cr.net.trim()) set.add(cr.net);
    }
    crossNetsByPage.set(pid, set);
  }

  for (const [pid, page] of pages) {
    for (const cr of page.cross_refs ?? []) {
      const net = (cr.net ?? '').trim();
      if (!net) continue;
      for (const target of cr.pages ?? []) {
        const targetPageId = sheetToPageId.get(String(target));
        if (!targetPageId) {
          issues.push({
            level: 'warn',
            code: 'CROSS_REF_UNKNOWN_PAGE',
            message: `page "${pid}" cross_ref net "${net}" wskazuje nieznany sheet "${target}" w pakiecie`,
            ref: net,
          });
          continue;
        }
        const targetSet = crossNetsByPage.get(targetPageId);
        if (!targetSet) continue;
        if (!targetSet.has(net)) {
          issues.push({
            level: 'err',
            code: 'CROSS_REF_NO_RETURN',
            message: `page "${pid}" ma cross_ref net "${net}" do sheet ${target} (page "${targetPageId}"), ale tam nie ma cross_ref z ta nazwa`,
            ref: net,
          });
        }
      }
    }
  }
  return issues;
}

export function validateProject(proj: Project): Issue[] {
  const issues: Issue[] = [];
  const pkgIds = new Set(proj.packages.map((p) => p.id));
  for (const sig of proj.backplane) {
    for (const ep of sig.endpoints) {
      if (!pkgIds.has(ep.package)) {
        issues.push({
          level: 'err',
          code: 'BACKPLANE_UNKNOWN_PACKAGE',
          message: `backplane signal "${sig.signal}" endpoint references unknown package "${ep.package}"`,
          ref: sig.signal,
        });
      }
    }
    if (sig.endpoints.length < 2) {
      issues.push({
        level: 'warn',
        code: 'BACKPLANE_SINGLE_ENDPOINT',
        message: `backplane signal "${sig.signal}" has only ${sig.endpoints.length} endpoint(s)`,
        ref: sig.signal,
      });
    }
  }
  return issues;
}
