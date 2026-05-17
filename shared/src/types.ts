// Typy 1:1 ze specyfikacją `format-spec.md`.
// Wersja formatu pliku: pole top-level `kronikarz: "1"`.

export type Status = 'raw' | 'wip' | 'done' | 'verified';

// --- project.yaml ---

export interface ConnectorRef {
  package: string;
  connector_pin: string;
}

export interface BackplaneSignal {
  signal: string;
  from: ConnectorRef;
  to: ConnectorRef;
}

export interface PackageRef {
  id: string;
  name: string;
  file: string;
  status: Status;
}

export interface Project {
  kronikarz: '1';
  project: {
    name: string;
    desc: string;
    doc: string;
    status: Status;
  };
  packages: PackageRef[];
  backplane: BackplaneSignal[];
}

// --- package.yaml ---

export interface PageRef {
  id: string;
  file: string;
  scan: string;
  title: string;
  status: Status;
}

export interface GateRef {
  page: string;
}

// IC component (74xx logic etc)
export interface IcComponent {
  ic: string; // suffix → ic_map key
  gates: Record<string, GateRef | null>;
}

// Passive R / C
export interface PassiveComponent {
  ic: null;
  type: 'resistor' | 'capacitor';
  value: string;
  polarized?: boolean;
  pages: string[];
}

export type Component = IcComponent | PassiveComponent;

export interface Package {
  kronikarz: '1';
  package: {
    id: string;
    name: string;
    doc: string;
    status: Status;
    pcb?: {
      front?: string;
      back?: string;
    };
    pages: PageRef[];
  };
  components: Record<string, Component>;
}

// --- *.sch.yaml ---

export type Side = 'left' | 'right' | 'top' | 'bottom';
export type Rotation = 0 | 90 | 180 | 270;

export interface CrossPage {
  page: string;
  label: string;
}

export interface Pin {
  num: number;
  side: Side;
  net: string;
  px: number;
  py: number;
  cross?: CrossPage;
}

export interface Gate {
  ref: string; // component reference in package.components
  gate: string | null; // letter A/B/C/... or null for passives
  x: number; // center px on scan
  y: number;
  rotation: Rotation;
  pins: Pin[];
  label_left?: string;
  label_right?: string;
  value?: string; // for passives
  verified: boolean;
  note: string | null;
}

export type PowerType = 'VCC' | 'GND' | string;

export interface PowerSymbol {
  type: PowerType;
  x: number;
  y: number;
  net: string;
}

export interface Net {
  pins: string[]; // "REF.GATE.NUM" or "REF.NUM" for passives
  segments: Array<[number, number, number, number]> | null;
  junctions: Array<[number, number]> | null;
  cross?: CrossPage;
}

export interface Annotation {
  text: string;
  x: number;
  y: number;
}

export interface Page {
  kronikarz: '1';
  page: string;
  package: string;
  scan_size: [number, number];
  gates: Gate[];
  power: PowerSymbol[];
  nets: Record<string, Net>;
  annotations: Annotation[];
}

// --- ic_map.yaml ---

export type IcShape = 'triangle' | 'resistor' | 'capacitor' | 'capacitor_polarized';

export interface IcGateGeometry {
  in?: number[];
  out?: number[];
  // Flip-flop pins:
  clk?: number[];
  d?: number[];
  q?: number[];
  nq?: number[];
  pre?: number[];
  clr?: number[];
  j?: number[];
  k?: number[];
}

export interface IcDef {
  name?: string;
  desc?: string;
  kicad_symbol: string;
  kicad_footprint?: string;
  pins?: number;
  gates?: number;
  gate_pins?: Record<string, IcGateGeometry>;
  power?: { VCC: number; GND: number };
  shape?: IcShape;
}

export type IcMap = Record<string, IcDef>;
