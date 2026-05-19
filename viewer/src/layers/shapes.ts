import type { Gate, Package, IcMap, IcDef } from '@kronikarz/shared';

export type Shape =
  | 'rect'
  | 'triangle'
  | 'resistor'
  | 'capacitor'
  | 'capacitor_polarized'
  | 'flipflop';

export function gateShape(gate: Gate, pkg: Package | null, icMap: IcMap | null): Shape {
  if (!pkg) return 'rect';
  const comp = pkg.components[gate.ref];
  if (!comp) return 'rect';

  // Passive
  if (comp.ic === null) {
    if (comp.type === 'resistor') return 'resistor';
    if (comp.type === 'capacitor') return comp.polarized ? 'capacitor_polarized' : 'capacitor';
    return 'rect';
  }

  // IC — consult ic_map
  const icDef: IcDef | undefined = icMap?.[comp.ic];
  if (icDef?.shape === 'triangle') return 'triangle';
  if (icDef?.shape === 'resistor') return 'resistor';
  if (icDef?.shape === 'capacitor') return 'capacitor';
  if (icDef?.shape === 'capacitor_polarized') return 'capacitor_polarized';

  // Detect flip-flop by pin labels (require clk — eliminates register files like 74170)
  if (gate.gate && icDef?.gate_pins) {
    const gp = icDef.gate_pins[gate.gate];
    if (gp?.clk) return 'flipflop';
  }
  return 'rect';
}
