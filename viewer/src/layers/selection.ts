import type { Page } from '@kronikarz/shared';
import type { Selection } from '../store.ts';

export function activeNets(page: Page | null, selection: Selection): Set<string> {
  const out = new Set<string>();
  if (!page || !selection) return out;
  if (selection.kind === 'net') {
    out.add(selection.name);
  } else if (selection.kind === 'segment') {
    out.add(selection.netName);
  } else if (selection.kind === 'gate') {
    const g = page.gates[selection.idx];
    g?.pins.forEach((p) => out.add(p.net));
  } else if (selection.kind === 'pin') {
    const pin = page.gates[selection.gateIdx]?.pins[selection.pinIdx];
    if (pin) out.add(pin.net);
  }
  return out;
}
