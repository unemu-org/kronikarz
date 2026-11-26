import type { Gate, Package, IcMap, IcDef } from '@kronikarz/shared';

export type Shape =
  | 'rect'
  | 'resistor'
  | 'capacitor'
  | 'capacitor_polarized'
  | 'jumper';

export function gateShape(gate: Gate, pkg: Package | null, icMap: IcMap | null): Shape {
  if (!pkg) return 'rect';
  const comp = pkg.components[gate.ref];
  if (!comp) return 'rect';

  // Passive
  if (comp.ic === null) {
    if (comp.type === 'resistor') return 'resistor';
    if (comp.type === 'capacitor') return comp.polarized ? 'capacitor_polarized' : 'capacitor';
    if (comp.type === 'jumper') return 'jumper';
    return 'rect';
  }

  // IC — consult ic_map only for passive shapes (resistor/capacitor packaged as IC).
  const icDef: IcDef | undefined = icMap?.[comp.ic];
  if (icDef?.shape === 'resistor') return 'resistor';
  if (icDef?.shape === 'capacitor') return 'capacitor';
  if (icDef?.shape === 'capacitor_polarized') return 'capacitor_polarized';

  return 'rect';
}
