import type { Project, Package, Page, IcMap, IcComponent, Component } from './types.ts';
import { parsePinId } from './parse.ts';

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

export function validatePage(page: Page, pkg?: Package, icMap?: IcMap): Issue[] {
  const issues: Issue[] = [];

  if (page.package !== pkg?.package.id && pkg) {
    issues.push({
      level: 'err',
      code: 'PAGE_PACKAGE_MISMATCH',
      message: `page.package="${page.package}" but loaded package.id="${pkg.package.id}"`,
    });
  }

  // Gate refs must exist in package.components
  for (const gate of page.gates) {
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
        // ic_map lookup
        if (icMap && !(comp.ic in icMap)) {
          issues.push({
            level: 'warn',
            code: 'IC_UNKNOWN_SUFFIX',
            message: `IC suffix "${comp.ic}" for ${ref} not in ic_map`,
            ref,
          });
        }
      }
    }
  }

  // Nets must have ≥1 pin
  for (const [netName, net] of Object.entries(page.nets)) {
    if (!net.pins || net.pins.length === 0) {
      issues.push({
        level: 'warn',
        code: 'NET_EMPTY',
        message: `net "${netName}" has no pins`,
        ref: netName,
      });
    } else if (net.pins.length === 1 && !net.cross) {
      issues.push({
        level: 'warn',
        code: 'NET_FLOATING',
        message: `net "${netName}" has only 1 pin and no cross-page reference (floating)`,
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
      // IC suffix must exist in ic_map
      if (icMap && !(comp.ic in icMap)) {
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

export function validateProject(proj: Project): Issue[] {
  const issues: Issue[] = [];
  const pkgIds = new Set(proj.packages.map((p) => p.id));
  for (const sig of proj.backplane) {
    if (!pkgIds.has(sig.from.package)) {
      issues.push({
        level: 'err',
        code: 'BACKPLANE_UNKNOWN_PACKAGE',
        message: `backplane signal "${sig.signal}" from unknown package "${sig.from.package}"`,
        ref: sig.signal,
      });
    }
    if (!pkgIds.has(sig.to.package)) {
      issues.push({
        level: 'err',
        code: 'BACKPLANE_UNKNOWN_PACKAGE',
        message: `backplane signal "${sig.signal}" to unknown package "${sig.to.package}"`,
        ref: sig.signal,
      });
    }
  }
  return issues;
}
