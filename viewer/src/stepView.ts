// Etapowy viewer (kr-9p8.20): czyste funkcje paska kroków ①–⑥, wyszarzania
// warstw, kolorów pochodzenia, filtra walidacji, znaczków stanu kroków,
// kolejki przeglądu i komunikatów POST /auto. Bez DOM i store — testy w
// stepView.test.ts (node --test).
//
// Kroki i aspekty elementów jak w shared/src/steps.ts:
//   ① gates  — ramka bramki (gate.src)
//   ② text   — tekst bramki (gate.text_src) i piny (pin.src)
//   ③ wires  — odcinki i kropki (net.auto_segments / auto_junctions)
//   ④ labels — porty, odsyłacze, zasilanie (src)
//   ⑤ nets   — nety końcówek (pin / port / odsyłacz / zasilanie .net_src)
//   ⑥ kicad  — podgląd eksportu (eksporter kr-4rq; dziś nic do uruchomienia)
import {
  STEP_ORDER,
  autoJunctionMask,
  autoSegmentMask,
  canRun,
  elementSrc,
  markStaleAfter,
  nextRunnableStep,
  stepStatus,
  type Issue,
  type Page,
  type Src,
  type StepName,
  type StepStatus,
} from '@kronikarz/shared';
import type { MultiSelect, Route, Selection, Tool } from './store.ts';
import { combineWireSel, wiresInBox, type WireSel } from './wireEdit.ts';

export type ViewStep = StepName | 'kicad';
export const isStepName = (s: ViewStep | null): s is StepName => s !== null && s !== 'kicad';
export const VIEW_STEPS: readonly ViewStep[] = [...STEP_ORDER, 'kicad'];

export interface StepMeta {
  glyph: string;
  name: string;
  /** Skąd pochodzi wynik kroku (podpis w panelu przeglądu). */
  source: string;
}

export const STEP_META: Readonly<Record<ViewStep, StepMeta>> = {
  gates: { glyph: '①', name: 'Ramki', source: 'CV: cv-gates.py' },
  text: { glyph: '②', name: 'Tekst i piny', source: 'VLM na wycinkach + ic_map (jeszcze niezaimplementowany)' },
  wires: { glyph: '③', name: 'Druty', source: 'CV: cv-wires.py na bieżących bramkach' },
  labels: { glyph: '④', name: 'Etykiety', source: 'CV + lokalny VLM: porty, odsyłacze, zasilanie na wolnych końcach drutów' },
  nets: { glyph: '⑤', name: 'Nety', source: 'składanie grafu + walidator (jeszcze niezaimplementowany)' },
  kicad: { glyph: '⑥', name: 'KiCad', source: 'eksporter .kicad_sch (kr-4rq, jeszcze niezaimplementowany)' },
};

export const STATUS_LABEL: Readonly<Record<StepStatus, string>> = {
  todo: '○ czeka',
  auto: '● do przeglądu',
  approved: '✓ zatwierdzony',
  stale: '◐ nieaktualny',
};

export const STATUS_MARK: Readonly<Record<StepStatus, string>> = {
  todo: '○',
  auto: '●',
  approved: '✓',
  stale: '◐',
};

/** Kolor znaczka / etykiety stanu kroku (CSS). */
// --- paleta pochodzenia (docs/auto-digitalizacja.md „Viewer”) ---
// Jedno miejsce na kolory kroków: płótno, panel przeglądu, znaczki, pasek.
// Decyzja opiekuna co do barw w toku (makieta: auto żółty, ludzkie niebieski).

export const PROV_COLORS = {
  // barwy jak w zaakceptowanej makiecie (USER 2026-11-28, wariant C)
  auto: '#e5c07b', // żółty: wynik pipeline'u, nieruszony
  edited: '#61afef', // niebieski: zmieniony / dodany przez człowieka
  approved: '#66bb6a', // zielony: krok zatwierdzony
  stale: '#ff9800', // pomarańczowy: krok nieaktualny
  todo: '#5c616b', // szary: krok nieuruchomiony
} as const;

/** Kolor znaczka / etykiety stanu kroku (z PROV_COLORS). */
export const STATUS_COLOR: Readonly<Record<StepStatus, string>> = {
  todo: PROV_COLORS.todo,
  auto: PROV_COLORS.auto,
  approved: PROV_COLORS.approved,
  stale: PROV_COLORS.stale,
};

/** Kolor elementu bieżącego kroku: krok zatwierdzony → zielony, inaczej wg `src`. */
export function provColor(status: StepStatus, src: Src): string {
  if (status === 'approved') return PROV_COLORS.approved;
  return src === 'auto' ? PROV_COLORS.auto : PROV_COLORS.edited;
}

// --- części rysunku i ich rola w bieżącym kroku ---

/**
 * Część rysunku:
 *   gateBox  — ramka bramki (i kształt elementu pasywnego)
 *   gateText — ref / litera / typ / etykiety bramki
 *   pin      — pin (kółko, numer; w ⑤ jego net)
 *   wire     — odcinki, kropki, wolne końce
 *   label    — porty, odsyłacze, symbole zasilania
 *   pinCross — strzałki `pin.cross` (aspekt netu pinu)
 *   decor    — adnotacje i dekoracje (ludzkie, poza krokami)
 */
export type Part = 'gateBox' | 'gateText' | 'pin' | 'wire' | 'label' | 'pinCross' | 'decor';

/**
 * own     — element bieżącego kroku: pełny, kolor pochodzenia
 * context — potrzebny do pracy w kroku: pełny, zwykłe kolory
 * other   — inny krok: wyszarzony albo ukryty, bez interakcji
 */
export type Role = 'own' | 'context' | 'other';

const ROLES: Readonly<Record<StepName, Readonly<Record<Part, Role>>>> = {
  gates: { gateBox: 'own', gateText: 'other', pin: 'other', wire: 'other', label: 'other', pinCross: 'other', decor: 'other' },
  text: { gateBox: 'context', gateText: 'own', pin: 'own', wire: 'other', label: 'other', pinCross: 'other', decor: 'other' },
  wires: { gateBox: 'context', gateText: 'other', pin: 'context', wire: 'own', label: 'other', pinCross: 'other', decor: 'other' },
  labels: { gateBox: 'other', gateText: 'other', pin: 'other', wire: 'context', label: 'own', pinCross: 'other', decor: 'other' },
  nets: { gateBox: 'context', gateText: 'context', pin: 'own', wire: 'context', label: 'own', pinCross: 'own', decor: 'other' },
};

/** Rola części w kroku; bez kroku („wszystko”) i w ⑥ wszystko jest zwykłym kontekstem. */
export function partRole(part: Part, step: ViewStep | null): Role {
  if (step === null || step === 'kicad') return 'context';
  return ROLES[step][part];
}

export type OthersMode = 'faint' | 'hidden';
export const FAINT_OPACITY = 0.22;

export interface Look {
  role: Role;
  visible: boolean;
  opacity: number;
  listening: boolean;
}

/** Jak narysować część: inne kroki wyszarzone (bez interakcji) albo ukryte. */
export function partLook(part: Part, step: ViewStep | null, others: OthersMode): Look {
  const role = partRole(part, step);
  if (role !== 'other') return { role, visible: true, opacity: 1, listening: true };
  return { role, visible: others !== 'hidden', opacity: FAINT_OPACITY, listening: false };
}

// --- narzędzia ---

/**
 * Narzędzia dozwolone w kroku:
 *   bez kroku („wszystko”) — wszystkie, jak dotąd
 *   każdy krok ①–⑤        — V (zaznacz) i E (edycja)
 *   ③ wires, ⑤ nets       — także W (drut: rysuje odcinki i przypisuje net)
 *   ⑥ kicad               — tylko V (podgląd)
 *   R (AI) i Z (strefy)    — tylko bez kroku (znikają w kr-9p8.16)
 */
export function toolAllowed(step: ViewStep | null, tool: Tool): boolean {
  if (step === null) return true;
  if (tool === 'select') return true;
  if (step === 'kicad') return false;
  if (tool === 'edit') return true;
  if (tool === 'wire') return step === 'wires' || step === 'nets';
  return false;
}

export type PlaceKind = 'gate' | 'cross_ref' | 'port' | 'power' | 'annotation' | 'decoration';

/** Przyciski „+ …” paska narzędzi: ① bramka; ④ port, odsyłacz, zasilanie; adnotacje / dekoracje bez kroku. */
export function placeAllowed(step: ViewStep | null, kind: PlaceKind): boolean {
  if (step === null) return true;
  if (step === 'gates') return kind === 'gate';
  if (step === 'labels') return kind === 'cross_ref' || kind === 'port' || kind === 'power';
  return false;
}

// --- krok domyślny ---

/**
 * Krok wybrany po otwarciu strony: strona bez sekcji `steps` (ręczna, sprzed
 * pipeline'u) → bez kroku („wszystko”, jak dotąd). Inaczej pierwszy krok do
 * przeglądu (`auto` / `stale`), potem następny do uruchomienia; wszystko
 * zatwierdzone → bez kroku.
 */
export function defaultStep(page: Pick<Page, 'steps'>): ViewStep | null {
  if (!page.steps || typeof page.steps !== 'object' || Object.keys(page.steps).length === 0) return null;
  for (const s of STEP_ORDER) {
    const st = stepStatus(page, s);
    if (st === 'auto' || st === 'stale') return s;
  }
  return nextRunnableStep(page);
}

// --- znaczki stanu kroków (lista stron, widok pakietu) ---

export interface StepMark {
  step: StepName;
  status: StepStatus;
  mark: string;
  color: string;
}

export function stepMarks(page: Pick<Page, 'steps'> | null | undefined): StepMark[] {
  return STEP_ORDER.map((step) => {
    const status = page ? stepStatus(page, step) : 'todo';
    return { step, status, mark: STATUS_MARK[status], color: STATUS_COLOR[status] };
  });
}

/** Tekst znaczków, np. „✓✓●○○”. */
export function marksText(page: Pick<Page, 'steps'> | null | undefined): string {
  return stepMarks(page).map((m) => m.mark).join('');
}

// --- walidacja: kod → krok ---

const ISSUE_STEP: Readonly<Record<string, StepName>> = {
  GATES_UNVERIFIED: 'gates',
  GATE_UNKNOWN_REF: 'text',
  GATE_LETTER_MISSING: 'text',
  GATE_UNKNOWN_LETTER: 'text',
  IC_UNKNOWN_SUFFIX: 'text',
  GATE_PIN_INVALID: 'text',
  GATE_PIN_MISSING: 'text',
  AUTO_GEOM_INVALID: 'wires',
  NET_NO_SEGMENTS: 'wires',
  PORT_NOT_ON_BACKPLANE: 'labels',
  CROSS_REF_UNKNOWN_PAGE: 'labels',
  CROSS_REF_NO_RETURN: 'nets', // brak powrotnego odsyłacza z tym netem (cr.net)
  NET_DISCONNECTED: 'nets',
  NET_ORPHAN_ENDPOINT: 'nets',
  NET_FLOATING: 'nets',
  NET_EMPTY: 'nets',
  ENDPOINT_NET_MISMATCH: 'nets',
  PORT_NET_MISSING: 'nets',
  PIN_ID_MALFORMED: 'nets',
};

/**
 * Krok, którego dotyczy kod walidatora; null = „inne”: rejestr pakietu
 * (GATE_PAGE_UNKNOWN, GATE_UNUSED, PASSIVE_PAGE_UNKNOWN), projekt
 * (BACKPLANE_*), format (STEP_INVALID, SRC_INVALID, PAGE_PACKAGE_MISMATCH)
 * i kody nieznane.
 */
export function issueStep(code: string): StepName | null {
  return Object.hasOwn(ISSUE_STEP, code) ? ISSUE_STEP[code]! : null;
}

/**
 * Czy problem walidatora barwi elementy płótna w kroku: bez kroku / ⑥ —
 * każdy; w kroku ①–⑤ tylko problemy tego kroku (np. GATE_UNKNOWN_REF z ②
 * nie zaczerwienia każdej nowej ramki w ①).
 */
export function issueRelevant(issue: Pick<Issue, 'code' | 'scope'>, step: ViewStep | null): boolean {
  return step === null || step === 'kicad' || issueStepOf(issue) === step;
}

/** Krok problemu: problemy rejestru pakietu (scope `package`) są zawsze „inne”. */
export function issueStepOf(issue: Pick<Issue, 'code' | 'scope'>): StepName | null {
  return issue.scope === 'package' ? null : issueStep(issue.code);
}

export interface IssueGroups {
  /** Problemy bieżącego kroku (albo wszystkie, gdy `all` lub brak kroku). */
  step: Issue[];
  /** Kody bez kroku — pokazywane osobno jako „inne”. */
  other: Issue[];
  /** Ukryte: problemy innych kroków albo innych stron pakietu. */
  hidden: number;
}

/**
 * Filtr panelu walidacji. `all` albo brak kroku / ⑥ → wszystko w `step`.
 * Inaczej: problemy tego kroku w `step`, kody bez kroku w `other`; problemy
 * innych stron pakietu (Issue.page ≠ bieżąca) są pomijane.
 */
export function groupIssues(
  issues: readonly Issue[],
  step: ViewStep | null,
  all: boolean,
  pageId?: string,
): IssueGroups {
  if (all || step === null || step === 'kicad') return { step: [...issues], other: [], hidden: 0 };
  const out: IssueGroups = { step: [], other: [], hidden: 0 };
  for (const i of issues) {
    if (pageId !== undefined && i.page !== undefined && i.page !== pageId) {
      out.hidden++;
      continue;
    }
    const s = issueStepOf(i);
    if (s === step) out.step.push(i);
    else if (s === null) out.other.push(i);
    else out.hidden++;
  }
  return out;
}

/**
 * Błędy walidacji strony blokujące zatwierdzenie ⑤: `err` o kodzie kroku
 * ①–⑤ tej strony (inne strony pakietu, rejestr i projekt się nie liczą).
 */
/**
 * Kody, których naprawa leży na innej stronie (USER 2026-11-28): brak
 * odsyłacza powrotnego blokuje dopiero tamtą stronę, tu jest tylko widoczny.
 */
export const NON_BLOCKING_CODES: ReadonlySet<string> = new Set(['CROSS_REF_NO_RETURN']);

export function blockingErrors(issues: readonly Issue[], pageId: string): Issue[] {
  return issues.filter(
    (i) =>
      i.level === 'err' &&
      !NON_BLOCKING_CODES.has(i.code) &&
      issueStepOf(i) !== null &&
      (i.page === undefined || i.page === pageId),
  );
}

// --- zatwierdzanie ---

/**
 * Zatwierdź krok: `steps[step] = {status: approved, at}` (zostaje `run`). Krok
 * ① oznacza też każdą bramkę jako sprawdzoną (`verified: true`). Stan kroku
 * i `verified` nie są treścią — applyHumanEdit nie zmienia przez to pochodzenia
 * ani nie unieważnia późniejszych kroków.
 */
export function approveStep(page: Page, step: StepName, at: string): void {
  page.steps ??= {};
  page.steps[step] = { ...page.steps[step], status: 'approved', at };
  if (step === 'gates') for (const g of page.gates ?? []) g.verified = true;
}

/**
 * Cofnij zatwierdzenie: krok wraca do `auto` (był przebieg, jest `run`) albo
 * `todo`; późniejsze zatwierdzone kroki → `stale` (opierały się na nim).
 * `verified` bramek zostaje.
 */
export function unapproveStep(page: Page, step: StepName, at: string): void {
  const cur = page.steps?.[step];
  if (!page.steps || !cur || cur.status !== 'approved') return;
  page.steps[step] = { ...cur, status: cur.run ? 'auto' : 'todo', at };
  markStaleAfter(page, step, at);
}

export interface ApproveCheck {
  ok: boolean;
  reason?: string;
}

/** Czy krok można zatwierdzić: ⑤ tylko bez błędów walidacji strony. */
export function canApprove(page: Page, step: StepName, issues: readonly Issue[], pageId: string): ApproveCheck {
  if (stepStatus(page, step) === 'approved') return { ok: false, reason: 'krok już zatwierdzony' };
  if (step === 'nets') {
    const errs = blockingErrors(issues, pageId);
    if (errs.length) {
      const codes = [...new Set(errs.map((i) => `${i.code} ${STEP_META[issueStepOf(i)!].glyph}`))];
      return {
        ok: false,
        reason: `⑤ wymaga strony bez błędów walidacji: ${errs.length} err (${codes.slice(0, 4).join(', ')}${codes.length > 4 ? ', …' : ''}) — „wszystkie” w walidacji`,
      };
    }
  }
  return { ok: true };
}

// --- uruchamianie kroku ---

export interface RunOptions {
  force: boolean;
  draft: boolean;
  dryRun: boolean;
}

export interface RunNeeds {
  /** Krok zatwierdzony: przebieg tylko z „wymuś”. */
  needsForce: boolean;
  /** Poprzedni krok niezatwierdzony: przebieg tylko jako „szkic”. */
  needsDraft: boolean;
  /** Powód blokady przy podanych opcjach (canRun), albo null. */
  blocked: string | null;
}

export function runNeeds(page: Pick<Page, 'steps'>, step: StepName, opts: Partial<RunOptions> = {}): RunNeeds {
  const needsForce = stepStatus(page, step) === 'approved';
  const i = STEP_ORDER.indexOf(step);
  const prev = i > 0 ? STEP_ORDER[i - 1]! : null;
  const needsDraft = prev !== null && stepStatus(page, prev) !== 'approved';
  // podgląd (dry-run) i tak sprawdza canRun po stronie serwera
  const r = canRun(page, step, { force: opts.force, draft: opts.draft });
  return { needsForce, needsDraft, blocked: r.ok ? null : r.reason };
}

export interface AutoBody {
  pkg: string;
  page: string;
  step: StepName | 'next';
  force: boolean;
  draft: boolean;
  dryRun: boolean;
}

export function autoBody(pkg: string, page: string, step: StepName | 'next', opts: Partial<RunOptions> = {}): AutoBody {
  return {
    pkg,
    page,
    step,
    force: step !== 'next' && opts.force === true,
    draft: opts.draft === true,
    dryRun: opts.dryRun === true,
  };
}

// --- odpowiedź POST /auto → komunikat ---

/** Raport jednej strony z auto.py --json (pola, których używa viewer). */
export interface AutoPageReport {
  page: string;
  step: string | null;
  status: string; // ok | dry_run | refused | not_implemented | error | nothing
  exit: number;
  reason?: string;
  counts?: Record<string, unknown>;
  written?: boolean;
  stale?: string[];
  time_s?: number;
  run?: string;
}

export type AutoMessageKind = 'ok' | 'dry' | 'refused' | 'not-implemented' | 'busy' | 'error';

export interface AutoMessage {
  kind: AutoMessageKind;
  title: string;
  lines: string[];
  /** Strony, które przebieg zapisał (trzeba je przeładować). */
  written: string[];
  /** Serwer mógł coś zapisać, ale tego nie wiadomo (500 bez wyniku, 504, sieć). */
  uncertain: boolean;
}

const num = (c: Record<string, unknown>, k: string): string => {
  const v = c[k];
  return typeof v === 'number' ? String(v) : '?';
};

/** Liczniki kroku jednym wierszem (jak format_page w auto.py). */
export function countsLine(step: string | null, c: Record<string, unknown> | undefined): string {
  if (!c) return '';
  if (step === 'gates') {
    return (
      `wykryte ${num(c, 'detected')}, dodane auto ${num(c, 'added_auto')}, usunięte auto ${num(c, 'removed_auto')}, ` +
      `zostawione ${num(c, 'kept')} (ludzkie ${num(c, 'kept_human')}, auto chronione ${num(c, 'kept_auto')}), ` +
      `odrzucone na zostających ${num(c, 'dropped_overlap')}`
    );
  }
  if (step === 'wires') {
    let s =
      `wykryte ${num(c, 'detected_segments')} odc. w ${num(c, 'detected_nets')} skł.; ` +
      `dodane auto ${num(c, 'added_auto_segments')} odc. / ${num(c, 'added_auto_junctions')} kropek / ${num(c, 'added_nets')} netów; ` +
      `usunięte auto ${num(c, 'removed_auto_segments')} odc. / ${num(c, 'removed_auto_junctions')} kropek / ${num(c, 'removed_nets')} netów; ` +
      `zostawione ${num(c, 'kept_segments')} odc. / ${num(c, 'kept_junctions')} kropek; ` +
      `na zostających odrzucone ${num(c, 'dropped_overlap')}, przycięte ${num(c, 'clipped_overlap')}`;
    const s5 = c.step5_nets;
    if (s5 && typeof s5 === 'object' && Object.keys(s5).length) s += `; usunięte auto z netów po ⑤: ${Object.keys(s5).sort().join(', ')}`;
    return s;
  }
  return Object.entries(c)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

const STATUS_PL: Readonly<Record<string, string>> = {
  ok: 'zapisano',
  dry_run: 'podgląd (nic nie zapisano)',
  refused: 'ODMOWA',
  not_implemented: 'niezaimplementowany',
  error: 'BŁĄD',
  nothing: 'nic do zrobienia',
};

function stepLabel(step: string | null | undefined): string {
  if (!step) return '';
  const m = (STEP_META as Record<string, StepMeta | undefined>)[step];
  return m ? `${m.glyph} ${step}` : step;
}

/** Wiersz raportu strony. */
export function pageLine(r: AutoPageReport): string {
  const head = `${r.page}${r.step ? ' ' + stepLabel(r.step) : ''}: ${STATUS_PL[r.status] ?? r.status}`;
  if (r.status === 'ok' || r.status === 'dry_run') {
    let s = `${head} — ${countsLine(r.step, r.counts)}`;
    if (typeof r.time_s === 'number') s += `; ${r.time_s.toFixed(2)} s`;
    if (r.stale?.length) s += `; nieaktualne: ${r.stale.join(', ')}`;
    return s;
  }
  return r.reason ? `${head} — ${r.reason}` : head;
}

function reportsOf(data: unknown): AutoPageReport[] {
  const d = data as { pages?: unknown; result?: { pages?: unknown } } | null;
  const pages = Array.isArray(d?.pages) ? d!.pages : Array.isArray(d?.result?.pages) ? d!.result!.pages : [];
  return (pages as unknown[]).filter((p): p is AutoPageReport => !!p && typeof p === 'object' && 'page' in p);
}

function jobLine(job: unknown): string {
  if (!job || typeof job !== 'object') return 'trwa inne zadanie na tej stronie';
  const j = job as Record<string, unknown>;
  const what = [j.kind, j.step, j.pkg, j.page].filter((x) => typeof x === 'string' && x).join(' ');
  const since = typeof j.startedAt === 'string' ? ` od ${j.startedAt}` : '';
  return `trwa zadanie #${String(j.id ?? '?')} ${what}${since}${j.dryRun ? ' (podgląd)' : ''}${j.stuck ? ' — zawieszone' : ''}`;
}

/**
 * Komunikat dla odpowiedzi POST /auto (status HTTP + JSON albo null):
 * 200 podsumowanie (liczniki per strona), 409 busy (zadanie) / refused
 * (powody), 501 krok niezaimplementowany, 500 błąd z końcówką stderr, 504
 * timeout, inne 4xx — błąd żądania. `written` = strony zapisane mimo błędu.
 */
export function autoReplyMessage(status: number, data: unknown): AutoMessage {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const reports = reportsOf(data);
  const written = reports.filter((r) => r.written === true).map((r) => r.page);
  const lines = reports.map(pageLine);
  const err = typeof d.error === 'string' ? d.error : null;
  if (status >= 200 && status < 300) {
    const dry = d.dry_run === true || (reports.length > 0 && reports.every((r) => r.status === 'dry_run' || r.status === 'nothing'));
    const n = reports.filter((r) => r.status === 'ok').length;
    const title = dry
      ? 'Podgląd przebiegu (nic nie zapisano)'
      : reports.length > 1
        ? `Krok przebiegł — zapisane strony: ${n}/${reports.length}`
        : reports[0]?.status === 'nothing'
          ? 'Nic do zrobienia — wszystkie kroki zatwierdzone'
          : 'Krok przebiegł — wynik do przeglądu';
    return { kind: dry ? 'dry' : 'ok', title, lines, written, uncertain: false };
  }
  if (status === 409 && err === 'busy') {
    return { kind: 'busy', title: 'Strona zajęta — trwa inny przebieg', lines: [jobLine(d.job)], written, uncertain: false };
  }
  if (status === 409 && err === 'refused') {
    const reasons = Array.isArray(d.reasons) ? (d.reasons as Array<Record<string, unknown>>) : [];
    const rl = reasons.map((r) => `${String(r.page ?? '')}${r.step ? ' ' + stepLabel(String(r.step)) : ''}: ${String(r.reason ?? r.status ?? '')}`);
    const okLines = reports.filter((r) => r.exit === 0).map(pageLine);
    const title = written.length ? `Odmowa na części stron — zapisane strony: ${written.length}` : 'Odmowa — krok nie przebiegł';
    return { kind: 'refused', title, lines: [...rl, ...okLines], written, uncertain: false };
  }
  if (status === 501) {
    const result = d.result as Record<string, unknown> | undefined;
    const reason = typeof result?.reason === 'string' ? result.reason : null;
    const extra = reports.filter((r) => r.status === 'not_implemented' && r.reason).map(pageLine);
    return {
      kind: 'not-implemented',
      title: written.length
        ? `Zapisane strony: ${written.length}; na pozostałych krok jeszcze niezaimplementowany`
        : 'Krok jeszcze niezaimplementowany',
      lines: [...(reason ? [reason] : []), ...extra, ...reports.filter((r) => r.status !== 'not_implemented').map(pageLine)],
      written,
      uncertain: false,
    };
  }
  const stderr = typeof d.stderr === 'string' && d.stderr.trim() ? ['stderr:', ...d.stderr.trimEnd().split('\n').slice(-12)] : [];
  if (status === 504) {
    return { kind: 'error', title: 'Przekroczony czas — przebieg przerwany', lines: [...lines, ...stderr], written, uncertain: true };
  }
  if (status >= 400 && status < 500) {
    return { kind: 'error', title: `Błąd żądania (${status})${err ? ': ' + err : ''}`, lines, written, uncertain: false };
  }
  if (status === 0) {
    return { kind: 'error', title: `Brak odpowiedzi serwera${err ? ': ' + err : ''}`, lines, written, uncertain: true };
  }
  // 500: auto.py exit 1 (JSON z wynikiem) albo bez pasującego JSON (np. błąd uv)
  return {
    kind: 'error',
    title: `Błąd przebiegu (${status})${err ? ': ' + err : ''}`,
    lines: [...lines, ...stderr],
    written,
    uncertain: reports.length === 0,
  };
}

// --- kolejka przeglądu ---

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReviewItem {
  key: string;
  label: string;
  src: Src;
  /** Powody niepewności (puste = pewny). */
  flags: string[];
  box: Box;
  select: Selection;
}

const box = (x1: number, y1: number, x2: number, y2: number, pad: number): Box => ({
  x: Math.min(x1, x2) - pad,
  y: Math.min(y1, y2) - pad,
  w: Math.abs(x2 - x1) + 2 * pad,
  h: Math.abs(y2 - y1) + 2 * pad,
});

function gateBoxOf(g: { x: number; y: number; w?: number; h?: number; rotation?: number; pins?: unknown[] }): Box {
  const w = typeof g.w === 'number' ? g.w : 80;
  const h = typeof g.h === 'number' ? g.h : 90;
  const rot = g.rotation === 90 || g.rotation === 270;
  const bw = rot ? h : w;
  const bh = rot ? w : h;
  return { x: g.x - bw / 2 - 20, y: g.y - bh / 2 - 20, w: bw + 40, h: bh + 40 };
}

type Seg = [number, number, number, number];
const SHORT_SEG_PX = 10;
const T_TOUCH_PX = 2;
const DOT_NEAR_PX = 4;

/** Punkt leży we wnętrzu odcinka (nie przy jego końcach), w odległości ≤ tol. */
function onInterior(px: number, py: number, s: Seg, tol: number): boolean {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return false;
  const t = ((px - x1) * dx + (py - y1) * dy) / len2;
  const len = Math.sqrt(len2);
  if (t * len <= tol + 1 || (1 - t) * len <= tol + 1) return false;
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return (qx - px) ** 2 + (qy - py) ** 2 <= tol * tol;
}

/**
 * Proste, tanie sygnały niepewności odcinka `auto`: bardzo krótki (< 10 px)
 * i styk T bez kropki (koniec odcinka we wnętrzu innego odcinka, bez kropki
 * w pobliżu — albo brak kropki na połączeniu, albo zwarcie dwóch drutów).
 */
export function wireFlags(seg: Seg, all: readonly Seg[], dots: ReadonlyArray<readonly [number, number]>): string[] {
  const flags: string[] = [];
  const len = Math.hypot(seg[2] - seg[0], seg[3] - seg[1]);
  if (len < SHORT_SEG_PX) flags.push(`krótki (${Math.round(len)} px)`);
  for (const [px, py] of [[seg[0], seg[1]], [seg[2], seg[3]]] as const) {
    if (dots.some((d) => Math.abs(d[0] - px) <= DOT_NEAR_PX && Math.abs(d[1] - py) <= DOT_NEAR_PX)) continue;
    if (all.some((o) => o !== seg && onInterior(px, py, o, T_TOUCH_PX))) {
      flags.push(`styk T bez kropki (${px},${py})`);
      break;
    }
  }
  return flags;
}

function gateName(g: { ref?: string; gate?: string | null }, i: number): string {
  const r = g.ref && g.ref.trim() ? g.ref : `(bez ref #${i})`;
  return g.gate ? `${r}.${g.gate}` : r;
}

function issuesBy(issues: readonly Issue[], step: StepName): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const i of issues) {
    if (!i.ref || i.level === 'info' || issueStepOf(i) !== step) continue;
    const l = m.get(i.ref);
    if (l) {
      if (!l.includes(i.code)) l.push(i.code);
    } else m.set(i.ref, [i.code]);
  }
  return m;
}

/**
 * Kolejka przeglądu kroku: elementy kroku z `src: auto` (dla ⑤: net_src),
 * najpierw niepewne (problem walidatora kroku przy elemencie; dla drutów też
 * wireFlags), potem reszta w kolejności strony.
 */
export function reviewQueue(page: Page, step: StepName, issues: readonly Issue[] = []): ReviewItem[] {
  const byRef = issuesBy(issues, step);
  const codes = (...refs: Array<string | undefined>): string[] => {
    const out: string[] = [];
    for (const r of refs) if (r) for (const c of byRef.get(r) ?? []) if (!out.includes(c)) out.push(c);
    return out;
  };
  const items: ReviewItem[] = [];
  const gates = page.gates ?? [];
  if (step === 'gates' || step === 'text') {
    gates.forEach((g, i) => {
      const field = step === 'gates' ? 'src' : 'text_src';
      const autoPins = step === 'text' ? (g.pins ?? []).filter((p) => elementSrc(p) === 'auto').length : 0;
      if (elementSrc(g, field) !== 'auto' && autoPins === 0) return;
      const flags = codes(g.ref, `${g.ref}.${g.gate}`, `${g.ref}#${i}`);
      items.push({
        key: `g${i}`,
        label: `bramka ${gateName(g, i)}${autoPins ? ` · piny auto: ${autoPins}` : ''}`,
        src: 'auto',
        flags,
        box: gateBoxOf(g),
        select: { kind: 'gate', idx: i },
      });
    });
  } else if (step === 'wires') {
    const all: Seg[] = [];
    const dots: Array<[number, number]> = [];
    for (const n of Object.values(page.nets ?? {})) {
      for (const s of Array.isArray(n?.segments) ? n.segments : []) all.push(s as Seg);
      for (const j of Array.isArray(n?.junctions) ? n.junctions : []) dots.push(j as [number, number]);
    }
    for (const [name, n] of Object.entries(page.nets ?? {})) {
      if (!n) continue;
      const segs = Array.isArray(n.segments) ? (n.segments as Seg[]) : [];
      const netCodes = codes(name);
      autoSegmentMask(n).forEach((a, si) => {
        if (!a) return;
        const s = segs[si]!;
        items.push({
          key: `s:${name}:${si}`,
          label: `odcinek ${name} #${si}`, // numeracja jak w SelectionPanel (od 0)
          src: 'auto',
          flags: [...wireFlags(s, all, dots), ...netCodes],
          box: box(s[0], s[1], s[2], s[3], 30),
          select: { kind: 'segment', netName: name, segmentIdx: si },
        });
      });
      const js = Array.isArray(n.junctions) ? n.junctions : [];
      autoJunctionMask(n).forEach((a, ji) => {
        if (!a) return;
        const j = js[ji]!;
        items.push({
          key: `j:${name}:${ji}`,
          label: `kropka ${name} (${j[0]},${j[1]})`,
          src: 'auto',
          flags: netCodes,
          box: box(j[0], j[1], j[0], j[1], 40),
          select: { kind: 'net', name },
        });
      });
    }
  } else {
    const field = step === 'labels' ? 'src' : 'net_src';
    if (step === 'nets') {
      gates.forEach((g, gi) =>
        (g.pins ?? []).forEach((p, pi) => {
          if (elementSrc(p, 'net_src') !== 'auto') return;
          items.push({
            key: `p${gi}:${pi}`,
            label: `pin ${gateName(g, gi)}:${p.num} → ${p.net || '(brak netu)'}`,
            src: 'auto',
            flags: codes(p.net),
            box: box(p.px, p.py, p.px, p.py, 40),
            select: p.net ? { kind: 'net', name: p.net } : { kind: 'gate', idx: gi },
          });
        }),
      );
    }
    (page.ports ?? []).forEach((p, i) => {
      if (elementSrc(p, field) !== 'auto') return;
      const pid = `${p.connector}${p.pin}`;
      items.push({
        key: `o${i}`,
        label: `port ${pid}${p.label ? ' ' + p.label : ''}${step === 'nets' ? ` → ${p.net || '(brak netu)'}` : ''}`,
        src: 'auto',
        flags: step === 'labels' ? codes(pid) : codes(p.net),
        box: box(p.x, p.y, p.x, p.y, 60),
        select: { kind: 'port', idx: i },
      });
    });
    (page.cross_refs ?? []).forEach((c, i) => {
      if (elementSrc(c, field) !== 'auto') return;
      items.push({
        key: `x${i}`,
        label: `odsyłacz ${c.label || '(bez etykiety)'} → ${(c.pages ?? []).join(', ')}${step === 'nets' ? ` · ${c.net || '(brak netu)'}` : ''}`,
        src: 'auto',
        flags: codes(c.net),
        box: box(c.x, c.y, c.x, c.y, 60),
        select: { kind: 'cross_ref', idx: i },
      });
    });
    (page.power ?? []).forEach((p, i) => {
      if (elementSrc(p, field) !== 'auto') return;
      items.push({
        key: `w${i}`,
        label: `zasilanie ${p.type}${step === 'nets' ? ` → ${p.net || '(brak netu)'}` : ''}`,
        src: 'auto',
        flags: step === 'nets' ? codes(p.net) : [],
        box: box(p.x, p.y, p.x, p.y, 50),
        select: { kind: 'power', idx: i },
      });
    });
  }
  // niepewne najpierw; stabilnie (sort w JS jest stabilny)
  return items.sort((a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0));
}

export interface StepCounts {
  total: number;
  auto: number;
  edited: number;
}

/** Liczba elementów kroku: wszystkie / auto / ludzkie (nagłówek panelu przeglądu). */
export function stepCounts(page: Page, step: StepName): StepCounts {
  let total = 0;
  let auto = 0;
  const add = (src: Src) => {
    total++;
    if (src === 'auto') auto++;
  };
  const gates = page.gates ?? [];
  if (step === 'gates') for (const g of gates) add(elementSrc(g));
  else if (step === 'text')
    for (const g of gates) {
      add(elementSrc(g, 'text_src'));
      for (const p of g.pins ?? []) add(elementSrc(p));
    }
  else if (step === 'wires')
    for (const n of Object.values(page.nets ?? {})) {
      if (!n) continue;
      for (const a of autoSegmentMask(n)) add(a ? 'auto' : 'edited');
      for (const a of autoJunctionMask(n)) add(a ? 'auto' : 'edited');
    }
  else {
    const field = step === 'labels' ? 'src' : 'net_src';
    if (step === 'nets') for (const g of gates) for (const p of g.pins ?? []) add(elementSrc(p, 'net_src'));
    for (const e of [...(page.ports ?? []), ...(page.cross_refs ?? []), ...(page.power ?? [])]) add(elementSrc(e, field));
  }
  return { total, auto, edited: total - auto };
}

/** Indeks następnego (dir 1) / poprzedniego (dir -1) elementu kolejki, z zawinięciem. */
export function stepQueueIndex(len: number, cur: number, dir: 1 | -1): number {
  if (len <= 0) return -1;
  if (cur < 0 || cur >= len) return dir === 1 ? 0 : len - 1;
  return (cur + dir + len) % len;
}

/**
 * Wynik przebiegu dla runRewrite (blokada strony do przeładowania):
 *   ok          — strona zapisana (2xx albo `written` mimo błędu) → przeładuj
 *   not-applied — serwer nic nie zapisał (409 refused / busy, 501, 4xx, 500
 *                 z wynikiem bez zapisanych stron) → edycja wraca
 *   ambiguous   — nie wiadomo (500 bez wyniku, 504, brak odpowiedzi) → strona
 *                 zostaje zablokowana do ręcznego przeładowania
 */
export function autoOutcome(status: number, msg: AutoMessage): 'ok' | 'not-applied' | 'ambiguous' {
  if (status >= 200 && status < 300) return 'ok';
  if (msg.written.length > 0) return 'ok';
  return msg.uncertain ? 'ambiguous' : 'not-applied';
}

// --- edycja elementów w kroku (kr-9p8.20, poprawki z przeglądu) ---

/** Rodzaj elementu (jak `Selection.kind`, plus kropka). */
export type ElementKind =
  | 'gate'
  | 'pin'
  | 'segment'
  | 'junction'
  | 'net'
  | 'port'
  | 'cross_ref'
  | 'power'
  | 'annotation'
  | 'decoration';

/**
 * Aspekt elementu: box (ramka bramki), text (tekst bramki / pinu), geom
 * (geometria drutu), label (etykieta końcówki), net (przypisanie netu).
 */
export type Aspect = 'box' | 'text' | 'geom' | 'label' | 'net';

const ASPECTS: Readonly<Record<ElementKind, readonly Aspect[]>> = {
  gate: ['box', 'text', 'net'], // net = nety pinów (panel bramki w ⑤)
  pin: ['text', 'net'],
  segment: ['geom'],
  junction: ['geom'],
  net: ['net', 'geom'], // podstawowy aspekt netu = przypisanie (⑤); geometria — 'geom' jawnie
  port: ['label', 'net'],
  cross_ref: ['label', 'net'],
  power: ['label', 'net'],
  annotation: [],
  decoration: [],
};

const ASPECT_STEP: Readonly<Record<Aspect, StepName>> = {
  box: 'gates',
  text: 'text',
  geom: 'wires',
  label: 'labels',
  net: 'nets',
};

/**
 * Krok aspektu elementu; null = element spoza kroków (adnotacja, dekoracja —
 * edycja tylko bez kroku). Bez `aspect` — aspekt podstawowy (istnienie
 * elementu: ramka bramki, tekst pinu, geometria drutu, etykieta końcówki).
 */
export function aspectStep(kind: ElementKind, aspect?: Aspect): StepName | null {
  const a = aspect ?? ASPECTS[kind][0];
  return a ? ASPECT_STEP[a] : null;
}

/**
 * Czy w kroku wolno zmienić aspekt elementu (przeciągnąć, usunąć, wpisać):
 * bez kroku — wszystko; ⑥ — nic; inaczej tylko aspekt bieżącego kroku
 * (wyjątek: geometria drutów — w ③ i w ⑤).
 * Części „kontekstu” (np. ramki w ③) są widoczne i klikalne (zaznaczenie,
 * przyciąganie drutu), ale tylko do odczytu.
 */
export function canEditElement(step: ViewStep | null, kind: ElementKind, aspect?: Aspect): boolean {
  if (step === null) return true;
  if (step === 'kicad') return false;
  if (aspect === undefined && ASPECTS[kind].length === 0) return false;
  // Geometria drutów także w ⑤ (kr-9p8.25, USER): poprawki drutów przy składaniu netów.
  if ((aspect ?? ASPECTS[kind][0]) === 'geom' && step === 'nets') return true;
  return aspectStep(kind, aspect) === step;
}

/**
 * Panel zaznaczenia ma coś do edycji: któryś aspekt elementu należy do kroku.
 * Panel bramki: ①②⑤; segmentu: ③⑤; netu: ③ i ⑤; końcówki: ④ i ⑤. Które
 * pola w panelu — `fieldEditable`.
 */
export function panelEditable(step: ViewStep | null, kind: ElementKind): boolean {
  if (step === null) return true;
  return ASPECTS[kind].some((a) => canEditElement(step, kind, a));
}

/**
 * Pola panelu zaznaczenia → aspekt. Pola spoza tabeli (także „usuń”) mają
 * aspekt podstawowy elementu (ramka bramki, etykieta końcówki, geometria
 * drutu). `note` i `verified` nie są treścią — panel ich nie blokuje.
 *   bramka: rotation → ramka ①; ref, gate, value, ic (typ, rozkład pinów),
 *           nc (pin nienarysowany na arkuszu) → tekst ②; pinNet (net pinu,
 *           ✎, rozłącz ×) → net ⑤
 *   port / odsyłacz / zasilanie: net → net ⑤; reszta (etykieta, złącze,
 *           pin, arkusze, strona, typ, obrót, usuń) → etykieta ④
 * NC (`pin.disconnected`) to aspekt tekstu pinu — jak w steps.ts (pinTextKey).
 */
const FIELD_ASPECT: Readonly<Record<string, Aspect>> = {
  'gate.rotation': 'box',
  'gate.ref': 'text',
  'gate.gate': 'text',
  'gate.value': 'text',
  'gate.ic': 'text',
  'gate.pinNet': 'net',
  'gate.nc': 'text',
  'port.net': 'net',
  'cross_ref.net': 'net',
  'power.net': 'net',
};

export function fieldAspect(kind: ElementKind, field: string): Aspect | undefined {
  return Object.hasOwn(FIELD_ASPECT, `${kind}.${field}`) ? FIELD_ASPECT[`${kind}.${field}`] : ASPECTS[kind][0];
}

/** Czy pole panelu zaznaczenia jest edytowalne w kroku (canEditElement aspektu pola). */
export function fieldEditable(step: ViewStep | null, kind: ElementKind, field: string): boolean {
  return canEditElement(step, kind, fieldAspect(kind, field));
}

/** Krok, w którym element da się edytować (podpowiedź „przełącz krok”); null = „wszystko”. */
export function editStepFor(kind: ElementKind): StepName | null {
  return aspectStep(kind);
}

/** Zaznaczenie prostokątem (V): tylko elementy, które wolno w kroku przesuwać. */
export function rubberBand(
  page: Pick<Page, 'gates' | 'ports' | 'cross_refs'>,
  r: Box,
  step: ViewStep | null,
): MultiSelect {
  const inside = (x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  const pick = (list: ReadonlyArray<{ x: number; y: number }> | undefined) => {
    const out: number[] = [];
    (list ?? []).forEach((e, i) => {
      if (inside(e.x, e.y)) out.push(i);
    });
    return out;
  };
  // Priorytet jak dotąd: bramki, porty, odsyłacze — ale tylko edytowalne w kroku
  // (w ④ porty przy bramkach dają się zaznaczyć, bo bramki nie wchodzą w grę).
  if (canEditElement(step, 'gate', 'box')) {
    const g = pick(page.gates);
    if (g.length) return { kind: 'gate', indices: g };
  }
  if (canEditElement(step, 'port', 'label')) {
    const p = pick(page.ports);
    if (p.length) return { kind: 'port', indices: p };
  }
  if (canEditElement(step, 'cross_ref', 'label')) {
    const c = pick(page.cross_refs);
    if (c.length) return { kind: 'cross_ref', indices: c };
  }
  return null;
}

/**
 * Prostokąt w V / E (kr-9p8.25): bez Shift jak dotąd bramki / porty /
 * odsyłacze (`rubberBand`); gdy żadnych — druty (odcinki i kropki), o ile
 * geometria drutów jest w kroku edytowalna (③, „wszystko”). Odcinek wpada,
 * gdy oba końce są w prostokącie; z Alt — gdy prostokąt go dotyka. Shift:
 * tylko druty, przełącza je w bieżącym zaznaczeniu drutów.
 */
export function bandSelection(
  page: Page,
  r: Box,
  step: ViewStep | null,
  mods: { shift: boolean; alt: boolean },
  cur: WireSel | null,
): { multi: MultiSelect } | { wire: WireSel | null } {
  if (!mods.shift) {
    const m = rubberBand(page, r, step);
    if (m) return { multi: m };
  }
  if (!canEditElement(step, 'segment', 'geom')) return { multi: null };
  return { wire: combineWireSel(cur, wiresInBox(page, r, mods.alt), mods.shift) };
}

/** Akcje strony na pasku narzędzi: cleanup nets w ③ / ⑤ / bez kroku; vision i .bak tylko bez kroku. */
export function pageActionAllowed(step: ViewStep | null, action: 'cleanup' | 'vision' | 'make-bak' | 'restore-bak'): boolean {
  if (step === null) return true;
  if (action === 'cleanup') return step === 'wires' || step === 'nets';
  return false;
}

/**
 * Po zbiorczym przebiegu w widoku pakietu: odśwież tylko, gdy użytkownik nadal
 * jest w widoku tego pakietu (nigdy nie wracaj do niego z innej trasy).
 */
export function shouldRefreshPackage(route: Route, pkg: string): boolean {
  return route.mode === 'package' && route.pkg === pkg;
}

// --- wynik przebiegu po przeładowaniu ---

export const STORED_RESULT_MAX_AGE_MS = 10 * 60 * 1000;

export interface StoredResult {
  pagePath: string;
  step: ViewStep;
  msg: AutoMessage;
  at: number;
}

/**
 * Zapamiętany wynik przebiegu (sessionStorage) — tylko dla tej strony i nie
 * starszy niż 10 min; inaczej null (i wpis do usunięcia).
 */
export function freshStoredResult(raw: string | null, pagePath: string, now: number): StoredResult | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<StoredResult>;
    if (r.pagePath !== pagePath || typeof r.at !== 'number' || !r.msg || !r.step) return null;
    if (now - r.at > STORED_RESULT_MAX_AGE_MS || now < r.at) return null;
    return r as StoredResult;
  } catch {
    return null;
  }
}
