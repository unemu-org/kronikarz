// Pipeline etapowy (format v1.2): pochodzenie elementów (`src`) i stan kroków
// strony (`page.steps`). Czyste funkcje, bez fs — działa w viewerze i w Node.
//
// Aspekty elementów i kroki, do których należą:
//   gate.src          → gates   (x, y, w, h, rotation)
//   gate.text_src     → text    (ref, gate, value, label_left, label_right)
//   pin.src           → text    (num, side, px/py względem środka bramki, disconnected)
//   pin.net_src       → nets    (net, cross)
//   port/cross_ref/power .src     → labels (etykieta, położenie, strona)
//   port/cross_ref/power .net_src → nets   (net)
//   net.auto_segments / auto_junctions → wires (geometria)
// Adnotacje i dekoracje są wyłącznie ludzkie — bez `src`.
import type {
  CrossRef,
  Gate,
  Net,
  Page,
  Pin,
  Port,
  PowerSymbol,
  Src,
  StepName,
  StepStatus,
} from './types.ts';

export const STEP_ORDER: readonly StepName[] = ['gates', 'text', 'wires', 'labels', 'nets'];
export const STEP_STATUSES: readonly StepStatus[] = ['todo', 'auto', 'approved', 'stale'];
export const SRC_FIELDS = ['src', 'text_src', 'net_src'] as const;
export type SrcField = (typeof SRC_FIELDS)[number];

type WithSrc = Partial<Record<SrcField, Src | undefined>>;

/** Stan kroku; brak sekcji, kroku albo nieznana wartość = `todo`. */
export function stepStatus(page: Pick<Page, 'steps'>, step: StepName): StepStatus {
  const st = page.steps?.[step]?.status;
  return st && (STEP_STATUSES as readonly string[]).includes(st) ? st : 'todo';
}

/** Pochodzenie aspektu elementu; wszystko poza `auto` (także brak pola) = `edited`. */
export function elementSrc(el: object, field: SrcField = 'src'): Src {
  return (el as WithSrc)[field] === 'auto' ? 'auto' : 'edited';
}

/**
 * Oznacz element (albo jeden jego aspekt) jako ludzki: usuwa pole, bo brak
 * pola = `edited` (writer nie zapisuje `src: edited`). Zwraca true, gdy coś
 * zmienił.
 */
export function markEdited(el: object, field?: SrcField): boolean {
  const o = el as WithSrc;
  let changed = false;
  for (const f of field ? [field] : SRC_FIELDS) {
    if (f in o) {
      if (o[f] === 'auto') changed = true;
      delete o[f];
    }
  }
  return changed;
}

/**
 * Po zmianie kroku `step` każdy PÓŹNIEJSZY zatwierdzony krok staje się `stale`
 * (sam `step` zostaje, jaki był). Zwraca kroki, które zmienił.
 */
export function markStaleAfter(page: Page, step: StepName, at?: string): StepName[] {
  const changed: StepName[] = [];
  const steps = page.steps;
  if (!steps) return changed;
  for (const s of STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1)) {
    const st = steps[s];
    if (st && st.status === 'approved') {
      st.status = 'stale';
      if (at !== undefined) st.at = at;
      changed.push(s);
    }
  }
  return changed;
}

export interface CanRunOptions {
  force?: boolean; // przepuść zatwierdzony krok jeszcze raz (wraca do `auto`)
  draft?: boolean; // próba: bez wymogu zatwierdzonego poprzednika
}
export type CanRunResult = { ok: true } | { ok: false; reason: string };

/** Czy krok może przebiec: poprzedni `approved` (chyba że draft); `approved` tylko z force. */
export function canRun(
  page: Pick<Page, 'steps'>,
  step: StepName,
  opts: CanRunOptions = {},
): CanRunResult {
  const i = STEP_ORDER.indexOf(step);
  if (i < 0) return { ok: false, reason: `nieznany krok „${step}”` };
  if (stepStatus(page, step) === 'approved' && !opts.force) {
    return {
      ok: false,
      reason: `krok ${step} jest zatwierdzony — ponowny przebieg tylko z --force`,
    };
  }
  const prev = STEP_ORDER[i - 1];
  if (prev && !opts.draft && stepStatus(page, prev) !== 'approved') {
    return {
      ok: false,
      reason: `poprzedni krok ${prev} nie jest zatwierdzony (${stepStatus(page, prev)}) — zatwierdź go albo użyj --draft`,
    };
  }
  return { ok: true };
}

/** Pierwszy krok, który nie jest zatwierdzony i może przebiec bez force/draft (STEP=next). */
export function nextRunnableStep(page: Pick<Page, 'steps'>): StepName | null {
  for (const s of STEP_ORDER) {
    if (stepStatus(page, s) === 'approved') continue;
    return canRun(page, s).ok ? s : null;
  }
  return null;
}

export type ElementKind = 'gate' | 'pin' | 'port' | 'cross_ref' | 'power';

const blank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const noNumber = (v: unknown): boolean => typeof v !== 'number' || !Number.isFinite(v);

/**
 * Czy CAŁY aspekt elementu jest pusty. Reguła dla kroków pipeline'u: krok
 * wypełnia aspekt dowolnego elementu (także ludzkiego) tylko, gdy ten jest
 * pusty, i ustawia wtedy jego pole `*_src: auto`; aspektu niepustego (nawet
 * częściowo) nie rusza — chyba że pole jest `auto` (zob. format-spec.md).
 *   gate  src      — brak x/y
 *   gate  text_src — ref, gate, value, label_left, label_right puste i brak pinów
 *   pin   src      — brak num i side
 *   port  src      — connector, pin, label puste
 *   cross_ref src  — label puste i brak pages
 *   power src      — type puste
 *   *     net_src  — net pusty (pin: także brak cross)
 * Położenie portu / odsyłacza / zasilania nie liczy się do pustości (stoi na
 * wolnym końcu drutu z kroku ③).
 */
export function aspectEmpty(kind: ElementKind, el: object, field: SrcField): boolean {
  const o = el as Record<string, unknown>;
  if (field === 'net_src') return blank(o.net) && (kind !== 'pin' || blank(o.cross));
  if (field === 'text_src') {
    if (kind !== 'gate') return false;
    const pins = o.pins;
    return (
      blank(o.ref) &&
      blank(o.gate) &&
      blank(o.value) &&
      blank(o.label_left) &&
      blank(o.label_right) &&
      !(Array.isArray(pins) && pins.length > 0)
    );
  }
  switch (kind) {
    case 'gate':
      return noNumber(o.x) && noNumber(o.y);
    case 'pin':
      return noNumber(o.num) && blank(o.side);
    case 'port':
      return blank(o.connector) && noNumber(o.pin) && blank(o.label);
    case 'cross_ref':
      return blank(o.label) && !(Array.isArray(o.pages) && o.pages.length > 0);
    case 'power':
      return blank(o.type);
  }
}

// --- klucze aspektów (bez pól src / verified / note) ---

const k = (...a: unknown[]): string => JSON.stringify(a);
const gateBoxKey = (g: Gate) => k(g.x, g.y, g.w ?? null, g.h ?? null, g.rotation ?? 0);
const gateTextKey = (g: Gate) =>
  k(g.ref, g.gate ?? null, g.value ?? null, g.label_left ?? null, g.label_right ?? null);
const pinTextKey = (g: Gate, p: Pin) =>
  k(p.num, p.side, p.px - g.x, p.py - g.y, p.disconnected === true);
const pinGeomKey = (g: Gate, p: Pin) => k(p.side, p.px - g.x, p.py - g.y);
const pinNetKey = (p: Pin) => k(p.net, p.cross ?? null);
const portLabelKey = (p: Port) => k(p.connector, p.pin, p.label, p.x, p.y, p.side);
const crossRefLabelKey = (c: CrossRef) => k(c.label, c.pages, c.x, c.y, c.side);
const powerLabelKey = (p: PowerSymbol) => k(p.type, p.x, p.y, p.rotation ?? 0);
const endpointNetKey = (e: { net: string }) => k(e.net);
type Seg = [number, number, number, number];
type Pt = [number, number];
const isPoint = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
/** Poprawny odcinek `[x1, y1, x2, y2]` (4 skończone liczby). */
export const isSegment = (v: unknown): v is Seg => isPoint(v, 4);
/** Poprawna kropka `[x, y]`. */
export const isJunction = (v: unknown): v is Pt => isPoint(v, 2);
/** Lista z pliku: nie-tablica = pusta (zły plik nie może zablokować edycji). */
const listOf = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** Odcinek bez względu na kierunek; zły wpis = klucz, którego nie ma żaden poprawny. */
export function segmentKey(s: readonly number[]): string {
  if (!isSegment(s)) return 'bad:' + k(s);
  const [x1, y1, x2, y2] = s;
  return x1 < x2 || (x1 === x2 && y1 <= y2) ? k(x1, y1, x2, y2) : k(x2, y2, x1, y1);
}
export function junctionKey(j: readonly number[]): string {
  return isJunction(j) ? k(j[0], j[1]) : 'bad:' + k(j);
}

// --- pochodzenie drutów ---

class Bag {
  private m = new Map<string, number>();
  add(key: string): void {
    this.m.set(key, (this.m.get(key) ?? 0) + 1);
  }
  take(key: string): boolean {
    const n = this.m.get(key) ?? 0;
    if (n <= 0) return false;
    this.m.set(key, n - 1);
    return true;
  }
  get size(): number {
    return this.m.size;
  }
}

/** Odcinki netu, które są `auto` (dopasowanie po wartości, z krotnością). */
export function autoSegmentMask(net: Net): boolean[] {
  return mask(net.segments, net.auto_segments, isSegment, segmentKey);
}
export function autoJunctionMask(net: Net): boolean[] {
  return mask(net.junctions, net.auto_junctions, isJunction, junctionKey);
}
function mask(
  items: unknown,
  autos: unknown,
  valid: (v: unknown) => boolean,
  key: (x: readonly number[]) => string,
): boolean[] {
  const bag = new Bag();
  for (const a of listOf(autos)) if (valid(a)) bag.add(key(a as number[]));
  return listOf(items).map((it) => valid(it) && bag.take(key(it as number[])));
}

// --- wykrywanie edycji człowieka ---

function hasAuto(el: object): boolean {
  const o = el as WithSrc;
  return o.src === 'auto' || o.text_src === 'auto' || o.net_src === 'auto';
}

function pageHasAuto(p: Page): boolean {
  for (const g of p.gates ?? []) {
    if (hasAuto(g)) return true;
    for (const pin of g.pins ?? []) if (hasAuto(pin)) return true;
  }
  for (const list of [p.ports, p.cross_refs, p.power])
    for (const e of list ?? []) if (hasAuto(e)) return true;
  for (const n of Object.values(p.nets ?? {}))
    // samo pole (nawet złe) — wtedy edycja je przelicza i porządkuje
    if (n && (n.auto_segments !== undefined || n.auto_junctions !== undefined)) return true;
  return false;
}

/**
 * Para next[j] → prev[i] (albo -1), w przebiegach od najpewniejszego:
 * (a) ten sam indeks i wszystkie klucze równe; (b) wszystkie klucze równe
 * gdziekolwiek (z krotnością) — wstawienie / usunięcie elementu nie przesuwa
 * par sąsiadów, nawet gdy wiele elementów ma ten sam klucz (puste etykiety
 * z kroku ①, net ""); (c) ten sam indeks i którykolwiek klucz równy
 * (zmieniony element); (d) kolejno po każdym kluczu wśród niesparowanych.
 */
function pairUp<P, N>(
  prev: readonly P[],
  next: readonly N[],
  keys: Array<[(p: P) => string, (n: N) => string]>,
): number[] {
  const res = new Array<number>(next.length).fill(-1);
  const used = new Array<boolean>(prev.length).fill(false);
  const pair = (j: number, i: number) => {
    res[j] = i;
    used[i] = true;
  };
  const byKey = (kp: (p: P) => string, kn: (n: N) => string) => {
    const free = new Map<string, number[]>();
    prev.forEach((p, i) => {
      if (used[i]) return;
      const key = kp(p);
      const l = free.get(key);
      if (l) l.push(i);
      else free.set(key, [i]);
    });
    next.forEach((n, j) => {
      if (res[j]! >= 0) return;
      const i = free.get(kn(n))?.shift();
      if (i !== undefined) pair(j, i);
    });
  };
  const fullP = (p: P) => k(keys.map(([kp]) => kp(p)));
  const fullN = (n: N) => k(keys.map(([, kn]) => kn(n)));
  const common = Math.min(prev.length, next.length);
  for (let j = 0; j < common; j++) if (fullP(prev[j]!) === fullN(next[j]!)) pair(j, j);
  byKey(fullP, fullN);
  for (let j = 0; j < common; j++) {
    if (res[j]! >= 0 || used[j]) continue;
    if (keys.some(([kp, kn]) => kp(prev[j]!) === kn(next[j]!))) pair(j, j);
  }
  for (const [kp, kn] of keys) byKey(kp, kn);
  return res;
}

/** Aspekt zostaje `auto` tylko, gdy był `auto` u pary i jego treść się nie zmieniła. */
function flipIfChanged(
  el: object,
  prev: object,
  field: SrcField,
  before: string,
  after: string,
): void {
  if ((el as WithSrc)[field] !== 'auto') return;
  if (before !== after || (prev as WithSrc)[field] !== 'auto') markEdited(el, field);
}

function trackEndpoints<T extends { net: string }>(
  pl: readonly T[],
  nl: readonly T[],
  labelKey: (e: T) => string,
): void {
  const pr = pairUp(pl, nl, [
    [labelKey, labelKey],
    [endpointNetKey, endpointNetKey],
  ]);
  nl.forEach((e, j) => {
    const i = pr[j]!;
    if (i < 0) {
      markEdited(e);
      return;
    }
    flipIfChanged(e, pl[i]!, 'src', labelKey(pl[i]!), labelKey(e));
    flipIfChanged(e, pl[i]!, 'net_src', endpointNetKey(pl[i]!), endpointNetKey(e));
  });
}

/** `auto` aspekty elementów `next`, które różnią się od `prev`, stają się `edited`. */
function trackSrc(prev: Page, next: Page): void {
  // Bramki i piny.
  const pg = prev.gates ?? [];
  const ng = next.gates ?? [];
  const gp = pairUp(pg, ng, [
    [gateBoxKey, gateBoxKey],
    [gateTextKey, gateTextKey],
  ]);
  ng.forEach((g, j) => {
    const i = gp[j]!;
    if (i < 0) {
      markEdited(g);
      for (const p of g.pins ?? []) markEdited(p);
      return;
    }
    const o = pg[i]!;
    flipIfChanged(g, o, 'src', gateBoxKey(o), gateBoxKey(g));
    flipIfChanged(g, o, 'text_src', gateTextKey(o), gateTextKey(g));
    const op = o.pins ?? [];
    const np = g.pins ?? [];
    const pp = pairUp(op, np, [
      [(p) => pinTextKey(o, p), (p) => pinTextKey(g, p)],
      // bez numeru: poprawiony numer pinu nie zdejmuje auto z jego netu
      [(p) => pinGeomKey(o, p), (p) => pinGeomKey(g, p)],
      [(p) => k(p.num), (p) => k(p.num)],
    ]);
    np.forEach((p, pj) => {
      const pi = pp[pj]!;
      if (pi < 0) {
        markEdited(p);
        return;
      }
      flipIfChanged(p, op[pi]!, 'src', pinTextKey(o, op[pi]!), pinTextKey(g, p));
      flipIfChanged(p, op[pi]!, 'net_src', pinNetKey(op[pi]!), pinNetKey(p));
    });
  });
  // Porty, odsyłacze, zasilanie.
  trackEndpoints(prev.ports ?? [], next.ports ?? [], portLabelKey);
  trackEndpoints(prev.cross_refs ?? [], next.cross_refs ?? [], crossRefLabelKey);
  trackEndpoints(prev.power ?? [], next.power ?? [], powerLabelKey);
  // Druty: odcinek / kropka zostaje `auto`, jeśli identyczny (wartość) był
  // `auto` gdziekolwiek na stronie przed edycją — także po przeniesieniu do
  // innego netu (scalenie / zmiana nazwy to krok `nets`, nie `wires`).
  const segs = new Bag();
  const juncs = new Bag();
  for (const n of Object.values(prev.nets ?? {})) {
    if (!n) continue;
    const ss = listOf(n.segments) as Seg[];
    const js = listOf(n.junctions) as Pt[];
    autoSegmentMask(n).forEach((a, i) => a && segs.add(segmentKey(ss[i]!)));
    autoJunctionMask(n).forEach((a, i) => a && juncs.add(junctionKey(js[i]!)));
  }
  for (const n of Object.values(next.nets ?? {})) {
    if (!n) continue;
    const as: Seg[] = [];
    const aj: Pt[] = [];
    if (segs.size)
      for (const s of listOf(n.segments))
        if (isSegment(s) && segs.take(segmentKey(s))) as.push([s[0], s[1], s[2], s[3]]);
    if (juncs.size)
      for (const jn of listOf(n.junctions))
        if (isJunction(jn) && juncs.take(junctionKey(jn))) aj.push([jn[0], jn[1]]);
    if (as.length) n.auto_segments = as;
    else delete n.auto_segments;
    if (aj.length) n.auto_junctions = aj;
    else delete n.auto_junctions;
  }
}

/** Odcisk treści kroku na stronie (multizbiór kluczy aspektów; bez src / verified / note). */
export function stepFingerprint(page: Page, step: StepName): string {
  const out: string[] = [];
  const gates = page.gates ?? [];
  const eps = [
    ...(page.ports ?? []).map((p) => ['port', portLabelKey(p), p.net] as const),
    ...(page.cross_refs ?? []).map((c) => ['xref', crossRefLabelKey(c), c.net] as const),
    ...(page.power ?? []).map((p) => ['power', powerLabelKey(p), p.net] as const),
  ];
  switch (step) {
    case 'gates':
      for (const g of gates) out.push(gateBoxKey(g));
      break;
    case 'text':
      for (const g of gates) {
        const pins = (g.pins ?? []).map((p) => pinTextKey(g, p)).sort();
        out.push(k(gateTextKey(g), pins));
      }
      break;
    case 'wires':
      for (const n of Object.values(page.nets ?? {})) {
        for (const s of listOf(n?.segments) as Seg[]) out.push('s' + segmentKey(s));
        for (const j of listOf(n?.junctions) as Pt[]) out.push('j' + junctionKey(j));
      }
      break;
    case 'labels':
      for (const [kind, key] of eps) out.push(kind + key);
      break;
    case 'nets':
      for (const g of gates)
        for (const p of g.pins ?? []) out.push(k(g.ref, g.gate ?? null, p.num, pinNetKey(p)));
      for (const [kind, key, net] of eps) out.push(k(kind, key, net));
      for (const [name, n] of Object.entries(page.nets ?? {})) {
        for (const s of listOf(n?.segments) as Seg[]) out.push(k(name, 's', segmentKey(s)));
        for (const j of listOf(n?.junctions) as Pt[]) out.push(k(name, 'j', junctionKey(j)));
      }
      break;
  }
  return out.sort().join('\n');
}

/** Kroki, których treść różni się między `prev` a `next`. */
export function changedSteps(prev: Page, next: Page): StepName[] {
  return STEP_ORDER.filter((s) => stepFingerprint(prev, s) !== stepFingerprint(next, s));
}

// --- które kroki unieważnia zmiana kroku (kr-9p8.25) ---

/** Tolerancja spójności drutów (px, Chebyshev) — jak walidator / viewer (wireEdit.CONNECT_TOL). */
export const CONNECT_TOL = 8;

/** Otwarty koniec portu (tam wchodzi drut; przeciwnie do grotu) — jak PortLayer. */
function portOpenEnd(p: Port): Pt | null {
  if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return null;
  const labelWidth = Math.max(60, `${p.connector}${p.pin}`.length * 16 + 12);
  const bw = labelWidth + 16;
  const rot = p.side === 'left' ? 0 : p.side === 'right' ? 180 : p.side === 'top' ? 90 : 270;
  const rad = (rot * Math.PI) / 180;
  return [Math.round(p.x + bw * Math.cos(rad)), Math.round(p.y + bw * Math.sin(rad))];
}

const near = (a: Pt, b: Pt): boolean =>
  Math.abs(a[0] - b[0]) <= CONNECT_TOL && Math.abs(a[1] - b[1]) <= CONNECT_TOL;

/**
 * Wejście kroku ④ z geometrii drutów: kotwice końcówek — otwarty koniec
 * portu, odsyłacz, symbol zasilania — przy których (≤ CONNECT_TOL,
 * Chebyshev) jest jakikolwiek koniec odcinka (dowolnego netu, także kilka
 * końców w jednym punkcie). Posortowane punkty kotwic.
 */
export function labelAnchorEnds(page: Page): Pt[] {
  const anchors: Pt[] = [];
  for (const p of listOf(page.ports) as Port[]) {
    const o = p && typeof p === 'object' ? portOpenEnd(p) : null;
    if (o) anchors.push(o);
  }
  for (const e of [...listOf(page.cross_refs), ...listOf(page.power)] as Array<CrossRef | PowerSymbol>)
    if (e && Number.isFinite(e.x) && Number.isFinite(e.y)) anchors.push([e.x, e.y]);
  if (!anchors.length) return [];
  const ends: Pt[] = [];
  for (const n of Object.values(page.nets ?? {}))
    for (const sg of listOf(n?.segments))
      if (isSegment(sg)) ends.push([sg[0], sg[1]], [sg[2], sg[3]]);
  return anchors.filter((a) => ends.some((e) => near(e, a))).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * Czy zmieniło się, które kotwice ④ mają koniec drutu: koniec przy kotwicy
 * pojawił się albo zniknął (odsunął o więcej niż CONNECT_TOL).
 */
export function labelEndsChanged(prev: Page, next: Page): boolean {
  return k(labelAnchorEnds(prev)) !== k(labelAnchorEnds(next));
}

/**
 * Kroki unieważniane (approved → stale) przez zmianę treści kroku `step`:
 * zwykle każdy późniejszy. Zmiana drutów (③) — tylko ⑤ (nety); ④ tylko gdy
 * zmieniło się, które porty / odsyłacze / zasilanie mają przy sobie koniec
 * drutu (`labelEnds` = labelEndsChanged): pojawił się, zniknął albo odsunął o
 * więcej niż CONNECT_TOL. Poprawka drutu w ⑤ nie unieważnia więc etykiet.
 */
export function staleTargets(step: StepName, labelEnds: boolean): StepName[] {
  const later = STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1);
  if (step !== 'wires') return later;
  return later.filter((s) => s !== 'labels' || labelEnds);
}

/** Zatwierdzone kroki z `which` → `stale`. Zwraca kroki, które zmienił. */
export function markStale(page: Page, which: readonly StepName[], at?: string): StepName[] {
  const changed: StepName[] = [];
  const steps = page.steps;
  if (!steps) return changed;
  for (const s of which) {
    const st = steps[s];
    if (st && st.status === 'approved') {
      st.status = 'stale';
      if (at !== undefined) st.at = at;
      changed.push(s);
    }
  }
  return changed;
}

export interface HumanEditResult {
  /** Kroki, które oznaczono jako `stale`. */
  stale: StepName[];
}

/**
 * Wywoływane po każdej edycji człowieka (`next` = `prev` po mutacji, osobne
 * obiekty): (1) `auto` aspekty, które się zmieniły — oraz elementy bez pary —
 * stają się `edited`; (2) każdy krok, którego treść się zmieniła, oznacza
 * zatwierdzone kroki z `staleTargets` jako `stale` (zwykle wszystkie
 * późniejsze; druty — ⑤, a ④ tylko przy zmianie wolnych końców przy
 * kotwicach). Mutuje `next`.
 * Ograniczenie: dopasowanie jest po indeksie i treści — jedna mutacja, która
 * naraz usuwa i zmienia elementy, może zostawić `auto` na zmienionym.
 */
export function applyHumanEdit(prev: Page, next: Page, at?: string): HumanEditResult {
  // `next` też: element `auto` wklejony / skopiowany z innej strony jest ludzki.
  if (pageHasAuto(prev) || pageHasAuto(next)) trackSrc(prev, next);
  const stale: StepName[] = [];
  if (next.steps) {
    for (const s of STEP_ORDER) {
      const later = STEP_ORDER.slice(STEP_ORDER.indexOf(s) + 1);
      if (!later.some((l) => stepStatus(next, l) === 'approved')) continue;
      if (stepFingerprint(prev, s) !== stepFingerprint(next, s))
        stale.push(...markStale(next, staleTargets(s, s === 'wires' && labelEndsChanged(prev, next)), at));
    }
  }
  return { stale };
}
