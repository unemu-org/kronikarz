// Node-only filesystem wrappers. Browser code should import from `./parse.ts`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  parseProject,
  parsePackage,
  parsePage,
  parseIcMap,
  serializeProject,
  serializePackage,
  serializePage,
  serializeIcMap,
} from './parse.ts';
import type { Project, Package, Page, IcMap } from './types.ts';

export async function loadProject(filePath: string): Promise<Project> {
  return parseProject(await fs.readFile(filePath, 'utf-8'), filePath);
}
export async function loadPackage(filePath: string): Promise<Package> {
  return parsePackage(await fs.readFile(filePath, 'utf-8'), filePath);
}
export async function loadPage(filePath: string): Promise<Page> {
  return parsePage(await fs.readFile(filePath, 'utf-8'), filePath);
}
export async function loadIcMap(filePath: string): Promise<IcMap> {
  return parseIcMap(await fs.readFile(filePath, 'utf-8'), filePath);
}

async function atomicWrite(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, text, 'utf-8');
  await fs.rename(tmp, filePath);
}

export const writeProject = (p: string, d: Project) => atomicWrite(p, serializeProject(d));
export const writePackage = (p: string, d: Package) => atomicWrite(p, serializePackage(d));
export const writePage = (p: string, d: Page) => atomicWrite(p, serializePage(d));
export const writeIcMap = (p: string, d: IcMap) => atomicWrite(p, serializeIcMap(d));
