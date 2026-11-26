// Typy 1:1 ze specyfikacją `format-spec.md`.
// Wersja formatu pliku: pole top-level `kronikarz: "1"`.

export type Status = 'raw' | 'wip' | 'done' | 'verified';

// --- project.yaml ---

export interface ConnectorRef {
  package: string;
  connector: string; // letter, e.g. "A"
  pin: number;       // e.g. 50
}

// Multi-drop backplane signal: one logical net wired to N edge-finger contacts
// across one or more packages.
export interface BackplaneSignal {
  signal: string;
  endpoints: ConnectorRef[];
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
  // sheet number wewnatrz pakietu (1..N). Wartosc widoczna na ramce schematu
  // ("Ark 1 z 12"). cross_ref.pages odnosi sie do tego numeru.
  sheet?: number;
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

// Solder jumper — N pads with labels (e.g. ['D','C']). At most one is
// bridged to the common trace; `selected` records which.
export interface JumperComponent {
  ic: null;
  type: 'jumper';
  positions: string[];
  selected?: string | null;
  pages: string[];
}

export type Component = IcComponent | PassiveComponent | JumperComponent;

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
  // Explicitly marked NC (Not Connected). Hidden in viewer, skipped by validator.
  disconnected?: boolean;
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
  w?: number; // optional override for box width (px). Default auto-size.
  h?: number; // optional override for box height (px). Default auto-size.
  verified: boolean;
  note: string | null;
}

export type PowerType = 'VCC' | 'GND' | string;

export interface PowerSymbol {
  type: PowerType;
  x: number;
  y: number;
  net: string;
  rotation?: Rotation;
}

// Edge connector / port — `< A50 >` style symbol entering or leaving the page.
// connector + pin together identify a physical edge-finger contact in a package.
// Cross-package wiring described by project.yaml backplane signals' endpoints.
export interface Port {
  connector: string; // edge connector letter (e.g. "A", "B", "C", "D")
  pin: number;       // pin number on that connector (e.g. 50)
  label: string;     // signal label printed near port (e.g. "-BLR", "+LDC")
  net: string;       // net name in this page
  x: number;         // tip position on scan (in pixels)
  y: number;
  side: Side;        // direction the port opens toward the page interior
}

// Intra-package cross-page reference printed at the edge of a schematic page
// (e.g. "-CZYTRW 2,3,4,5" means the signal continues on pages 2-5 of the same
// package). Visual only — no bracket symbol.
export interface CrossRef {
  net: string; // net name on this page
  label: string; // signal label as printed (often === net)
  pages: string[]; // page ids where the signal continues
  x: number;
  y: number;
  side: Side;
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
  fontSize?: number;
  rotation?: number; // 0 | 90 | 180 | 270
}

export type Decoration =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; thickness?: number; color?: string }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; thickness?: number; color?: string }
  | { kind: 'ellipse'; x: number; y: number; rx: number; ry: number; thickness?: number; color?: string };

export interface Page {
  kronikarz: '1';
  page: string;
  package: string;
  scan_size: [number, number];
  gates: Gate[];
  power: PowerSymbol[];
  ports?: Port[];
  cross_refs?: CrossRef[];
  nets: Record<string, Net>;
  annotations: Annotation[];
  decorations?: Decoration[];
}

// --- ic_map.yaml ---

export type IcShape = 'resistor' | 'capacitor' | 'capacitor_polarized';

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
