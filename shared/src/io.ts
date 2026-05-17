import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Project, Package, Page, IcMap } from './types.ts';

const FORMAT_VERSION = '1';

function checkVersion(doc: unknown, filePath: string): void {
  if (!doc || typeof doc !== 'object' || (doc as { kronikarz?: unknown }).kronikarz !== FORMAT_VERSION) {
    throw new Error(`${filePath}: missing or wrong "kronikarz: ${FORMAT_VERSION}"`);
  }
}

async function readYaml<T>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, 'utf-8');
  const doc = yaml.load(text);
  checkVersion(doc, filePath);
  return doc as T;
}

export async function loadProject(filePath: string): Promise<Project> {
  return readYaml<Project>(filePath);
}

export async function loadPackage(filePath: string): Promise<Package> {
  return readYaml<Package>(filePath);
}

export async function loadPage(filePath: string): Promise<Page> {
  return readYaml<Page>(filePath);
}

export async function loadIcMap(filePath: string): Promise<IcMap> {
  const text = await fs.readFile(filePath, 'utf-8');
  const doc = yaml.load(text);
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${filePath}: not a YAML mapping`);
  }
  return doc as IcMap;
}

// Quote labels that look like YAML-special tokens (start with -, +, contain special chars)
const QUOTING_TYPE = `"` as const;

async function writeYaml(filePath: string, doc: unknown): Promise<void> {
  const text = yaml.dump(doc, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    quotingType: QUOTING_TYPE,
    forceQuotes: false,
    sortKeys: false,
  });
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, text, 'utf-8');
  await fs.rename(tmp, filePath);
}

export async function writeProject(filePath: string, doc: Project): Promise<void> {
  return writeYaml(filePath, doc);
}

export async function writePackage(filePath: string, doc: Package): Promise<void> {
  return writeYaml(filePath, doc);
}

export async function writePage(filePath: string, doc: Page): Promise<void> {
  return writeYaml(filePath, doc);
}

export async function writeIcMap(filePath: string, doc: IcMap): Promise<void> {
  return writeYaml(filePath, doc);
}

// --- Pin id helpers ---

// Format: "REF.GATE.NUM" for IC pins, "REF.NUM" for passives
export function pinId(ref: string, gate: string | null, num: number): string {
  return gate === null ? `${ref}.${num}` : `${ref}.${gate}.${num}`;
}

export function parsePinId(id: string): { ref: string; gate: string | null; num: number } {
  const parts = id.split('.');
  if (parts.length === 2) {
    const [ref, numStr] = parts;
    const num = Number(numStr);
    if (!ref || Number.isNaN(num)) throw new Error(`bad pin id: ${id}`);
    return { ref, gate: null, num };
  }
  if (parts.length === 3) {
    const [ref, gate, numStr] = parts;
    const num = Number(numStr);
    if (!ref || !gate || Number.isNaN(num)) throw new Error(`bad pin id: ${id}`);
    return { ref, gate, num };
  }
  throw new Error(`bad pin id: ${id}`);
}
