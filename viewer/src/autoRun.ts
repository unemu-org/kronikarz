// Uruchamianie kroków pipeline'u z viewera (kr-9p8.20): POST /auto przez
// apiWrite, GET /auto/status w trakcie, przeładowanie strony przez runRewrite.
// Komunikaty i decyzje (autoReplyMessage, autoOutcome) w stepView.ts.
import { apiWrite } from './api.ts';
import { flushSavesOrAlert, runRewrite, useDocStore } from './store.ts';
import {
  autoOutcome,
  autoReplyMessage,
  freshStoredResult,
  type AutoBody,
  type AutoMessage,
  type StoredResult,
  type ViewStep,
} from './stepView.ts';

export interface AutoJob {
  id?: number;
  kind?: string;
  pkg?: string;
  page?: string;
  step?: string;
  pages?: string[];
  startedAt?: string;
  dryRun?: boolean;
  stuck?: boolean;
}

export const LOCK_RUNNING = 'trwa krok pipeline’u — edycja zablokowana';
export const LOCK_UNCERTAIN = 'wynik kroku niepewny — przeładuj stronę';

// Przebiegi w toku (strona albo cały pakiet; store `autoRuns`): beforeunload
// pyta przed zamknięciem karty, a „Uruchom krok” / „następny krok na wszystkich
// stronach” są nieaktywne — jeden przebieg naraz w karcie.
export function isAutoRunning(): boolean {
  return useDocStore.getState().autoRuns > 0;
}

/** POST /auto; brak odpowiedzi (sieć, proxy) = status 0. */
export async function postAuto(body: AutoBody): Promise<{ status: number; data: unknown }> {
  useDocStore.getState().bumpAutoRuns(1);
  try {
    const r = await apiWrite('/auto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data: unknown = null;
    try {
      data = await r.json();
    } catch {
      /* nie-JSON → komunikat z samego statusu */
    }
    return { status: r.status, data };
  } catch (err) {
    return { status: 0, data: { error: err instanceof Error ? err.message : String(err) } };
  } finally {
    useDocStore.getState().bumpAutoRuns(-1);
  }
}

/** GET /auto/status — trwające zadania skryptów (null przy błędzie). */
export async function autoStatus(): Promise<AutoJob[] | null> {
  try {
    const r = await fetch('/auto/status');
    if (!r.ok) return null;
    const d = (await r.json()) as { jobs?: AutoJob[] };
    return Array.isArray(d.jobs) ? d.jobs : [];
  } catch {
    return null;
  }
}

/** Co sekundę GET /auto/status, dopóki nie wywołasz zwróconego stop(). */
export function pollAutoStatus(onJobs: (jobs: AutoJob[] | null) => void, ms = 1000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const jobs = await autoStatus();
    if (!stopped) onJobs(jobs);
  };
  void tick();
  const h = setInterval(tick, ms);
  return () => {
    stopped = true;
    clearInterval(h);
  };
}

// Wynik przebiegu przeżywa przeładowanie strony (runRewrite → reload).
const RESULT_KEY = 'kronikarz:auto-result';

function stash(r: StoredResult): void {
  try {
    sessionStorage.setItem(RESULT_KEY, JSON.stringify(r));
  } catch {
    /* bez sessionStorage wynik po prostu nie zostanie pokazany po przeładowaniu */
  }
}

/**
 * Wynik przebiegu sprzed przeładowania dla tej strony (zabierany raz). Wpis
 * innej strony albo starszy niż 10 min jest usuwany bez pokazywania.
 */
export function takeStoredResult(pagePath: string): StoredResult | null {
  try {
    const raw = sessionStorage.getItem(RESULT_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(RESULT_KEY);
    return freshStoredResult(raw, pagePath, Date.now());
  } catch {
    return null;
  }
}

/**
 * Krok na otwartej stronie. Podgląd (dryRun) nic nie zapisuje: flush (serwer
 * widzi bieżące zmiany) i POST. Przebieg właściwy: strona zablokowana
 * (pageLock — edycja, cofnij, zatwierdzanie i akcje strony nieaktywne), potem
 * runRewrite: flush, blokada zapisów strony, POST, przeładowanie (wynik
 * zapamiętany w sessionStorage i pokazany po przeładowaniu), odblokowanie
 * (serwer nic nie zapisał) albo blokada do ręcznego przeładowania (wynik
 * niepewny). Zwraca komunikat do pokazania od razu, albo null (strona się
 * przeładowuje albo przebieg nie wystartował).
 */
export async function runStepOnPage(pagePath: string, step: ViewStep, body: AutoBody): Promise<AutoMessage | null> {
  if (body.dryRun) {
    if (!(await flushSavesOrAlert('Podgląd kroku'))) return null;
    const { status, data } = await postAuto(body);
    return autoReplyMessage(status, data);
  }
  if (isAutoRunning()) return null; // jeden przebieg naraz (przycisk i tak nieaktywny)
  useDocStore.getState().setPageLock(pagePath, LOCK_RUNNING);
  let shown: AutoMessage | null = null;
  let result: Awaited<ReturnType<typeof runRewrite>> = 'not-started';
  try {
    result = await runRewrite(
      pagePath,
      'Krok pipeline’u',
      async () => {
        const { status, data } = await postAuto(body);
        const msg = autoReplyMessage(status, data);
        const outcome = autoOutcome(status, msg);
        if (outcome === 'ok') stash({ pagePath, step, msg, at: Date.now() });
        shown = msg; // pokazany, gdy strona się nie przeładowała (także „zostań”)
        return outcome;
      },
      { ambiguousMessage: 'Krok pipeline’u: wynik niepewny — przeładuj stronę; niezapisane zmiany tej strony nie zostały wysłane' },
    );
  } finally {
    // Niepewny wynik / zapis bez przeładowania: ta strona zostaje zablokowana do
    // przeładowania; blokady innych stron nietknięte.
    const keep = result === 'ambiguous' || result === 'reload-declined' || result === 'reloaded';
    useDocStore.getState().setPageLock(pagePath, keep ? LOCK_UNCERTAIN : null);
  }
  if (result === 'reloaded') return null;
  return shown;
}
