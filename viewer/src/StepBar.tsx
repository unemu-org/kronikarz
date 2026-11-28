// Pasek kroków ①–⑥ nad płótnem (kr-9p8.20): stan kroków strony, wybór
// bieżącego kroku (filtr warstw / narzędzi / walidacji), „inne kroki:
// wyszarzone | ukryte” i „Uruchom krok” (POST /auto) z wynikiem przebiegu.
import { useEffect, useState } from 'react';
import { stepStatus } from '@kronikarz/shared';
import { isLocked, parsePageFilePath, useDocStore } from './store.ts';
import { pollAutoStatus, runStepOnPage, takeStoredResult, type AutoJob } from './autoRun.ts';
import {
  STATUS_COLOR,
  STATUS_LABEL,
  STEP_META,
  VIEW_STEPS,
  autoBody,
  isStepName,
  runNeeds,
  type AutoMessage,
  type RunOptions,
  type ViewStep,
} from './stepView.ts';

const NO_OPTS: RunOptions = { force: false, draft: false, dryRun: false };

export function StepBar(): JSX.Element | null {
  const page = useDocStore((s) => s.page);
  const pagePath = useDocStore((s) => s.pagePath);
  const currentStep = useDocStore((s) => s.currentStep);
  const setCurrentStep = useDocStore((s) => s.setCurrentStep);
  const othersMode = useDocStore((s) => s.othersMode);
  const setOthersMode = useDocStore((s) => s.setOthersMode);
  const [opts, setOpts] = useState<RunOptions>(NO_OPTS);
  const locked = useDocStore(isLocked);
  const anyRun = useDocStore((s) => s.autoRuns > 0); // jeden przebieg naraz w karcie
  // Przebieg i jego wynik należą do strony (ścieżki), na której go uruchomiono —
  // po przejściu na inną stronę nie są pokazywane.
  const [runningAt, setRunning] = useState<{ path: string; since: number; now: number; job: AutoJob | null } | null>(null);
  const [resultAt, setResult] = useState<{ path: string; step: ViewStep; msg: AutoMessage } | null>(null);

  // Wynik przebiegu sprzed przeładowania (runRewrite) — i jego krok.
  useEffect(() => {
    const r = pagePath ? takeStoredResult(pagePath) : null;
    setResult(r && pagePath ? { path: pagePath, step: r.step, msg: r.msg } : null);
    if (r) setCurrentStep(r.step);
  }, [pagePath, setCurrentStep]);
  useEffect(() => setOpts(NO_OPTS), [currentStep, pagePath]);

  if (!page || !pagePath) return null;
  const running = runningAt?.path === pagePath ? runningAt : null;
  const result = resultAt?.path === pagePath ? resultAt : null;
  const target = parsePageFilePath(pagePath);
  const step = isStepName(currentStep) ? currentStep : null;
  const needs = step ? runNeeds(page, step, opts) : null;

  async function run() {
    if (!step || !target || !pagePath || running || locked || anyRun) return;
    const path = pagePath;
    const body = autoBody(target.pkg, target.pageId, step, opts);
    setResult(null);
    const since = Date.now();
    setRunning({ path, since, now: since, job: null });
    const stop = pollAutoStatus((jobs) =>
      setRunning((r) => r && {
        ...r,
        now: Date.now(),
        job: jobs?.find((j) => j.kind === 'auto' && (j.pages ?? []).includes(target.pageId)) ?? r.job,
      }),
    );
    try {
      const m = await runStepOnPage(path, step, body);
      if (m) setResult({ path, step, msg: m });
    } finally {
      stop();
      setRunning(null);
    }
  }

  return (
    <div className="shrink-0 border-b border-bg-accent bg-bg-panel text-xs">
      <div className="flex flex-wrap items-center gap-1 px-2 py-1">
        <button
          onClick={() => setCurrentStep(null)}
          className={`px-2 py-0.5 ${currentStep === null ? 'bg-bg-accent text-text-main outline outline-1 outline-text-dim' : 'text-text-dim hover:bg-bg-accent'}`}
          title="bez kroku — wszystkie warstwy i narzędzia (jak przed pipeline'em)"
        >
          wszystko
        </button>
        {VIEW_STEPS.map((s, i) => {
          const st = s === 'kicad' ? null : stepStatus(page, s);
          const cur = currentStep === s;
          return (
            <span key={s} className="flex items-center">
              {i > 0 && <span className="px-0.5 text-text-dim">›</span>}
              <button
                onClick={() => setCurrentStep(s)}
                className={`flex items-center gap-1.5 px-2 py-0.5 ${cur ? 'bg-bg-accent text-text-main outline outline-1 outline-text-dim' : 'text-text-dim hover:bg-bg-accent'}`}
                title={`${STEP_META[s].name} — ${STEP_META[s].source}`}
                data-step={s}
              >
                <span className="text-sm">{STEP_META[s].glyph}</span>
                <span>{STEP_META[s].name}</span>
                <span
                  className="rounded-full px-1.5 text-[10px]"
                  style={{ color: st ? STATUS_COLOR[st] : '#5c616b', background: st ? STATUS_COLOR[st] + '1f' : undefined }}
                >
                  {st ? STATUS_LABEL[st] : '— podgląd'}
                </span>
              </button>
            </span>
          );
        })}
        <span className="mx-2 h-4 w-px bg-bg-accent" />
        <span className="text-text-dim">inne kroki:</span>
        <span className="inline-flex border border-bg-accent">
          {(['faint', 'hidden'] as const).map((m) => (
            <button
              key={m}
              disabled={currentStep === null || currentStep === 'kicad'}
              onClick={() => setOthersMode(m)}
              className={`px-2 py-0.5 disabled:opacity-40 ${othersMode === m ? 'bg-bg-accent text-text-main' : 'text-text-dim'}`}
            >
              {m === 'faint' ? 'wyszarzone' : 'ukryte'}
            </button>
          ))}
        </span>
        {step && needs && (
          <>
            <span className="mx-2 h-4 w-px bg-bg-accent" />
            <button
              onClick={run}
              disabled={!!running || locked || anyRun}
              className="border border-phosphor-dim bg-phosphor-dim/30 px-2 py-0.5 text-text-main hover:bg-phosphor-dim disabled:opacity-50"
              title={`POST /auto — krok ${STEP_META[step].glyph} ${step} tej strony${opts.dryRun ? ' (podgląd: nic nie zapisuje)' : ''}`}
              data-testid="run-step"
            >
              {running ? '⏳ trwa…' : `▶ Uruchom krok ${STEP_META[step].glyph}`}
            </button>
            {(needs.needsForce || opts.force) && (
              <Opt label="wymuś" title="krok zatwierdzony — przepuść go jeszcze raz (wraca do „do przeglądu”)" on={opts.force} set={(v) => setOpts({ ...opts, force: v })} />
            )}
            {(needs.needsDraft || opts.draft) && (
              <Opt label="szkic (draft)" title="poprzedni krok nie jest zatwierdzony — przebieg próbny" on={opts.draft} set={(v) => setOpts({ ...opts, draft: v })} />
            )}
            <Opt label="podgląd (dry-run)" title="policz wynik bez zapisu strony i snapshotu" on={opts.dryRun} set={(v) => setOpts({ ...opts, dryRun: v })} />
            {needs.blocked && !running && (
              <span className="text-warning" title={needs.blocked}>
                ⚠ {needs.needsForce && !opts.force ? 'zaznacz „wymuś”' : 'zaznacz „szkic”'} — inaczej serwer odmówi
              </span>
            )}
            {running && (
              <span className="text-text-dim">
                {Math.round((running.now - running.since) / 1000)} s
                {running.job ? ` · zadanie #${running.job.id ?? '?'} ${running.job.step ?? ''}${running.job.dryRun ? ' (podgląd)' : ''}` : ''}
              </span>
            )}
          </>
        )}
        {currentStep === 'kicad' && (
          <span className="ml-2 text-text-dim">⑥ podgląd .kicad_sch — eksporter jeszcze niezaimplementowany (kr-4rq)</span>
        )}
      </div>
      {result && result.step === currentStep && <AutoResult msg={result.msg} onClose={() => setResult(null)} />}
    </div>
  );
}

function Opt({ label, title, on, set }: { label: string; title: string; on: boolean; set: (v: boolean) => void }): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-1 text-text-dim" title={title}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
}

const KIND_STYLE: Readonly<Record<AutoMessage['kind'], string>> = {
  ok: 'border-verified/60 text-text-main',
  dry: 'border-selected/60 text-text-main',
  refused: 'border-warning/70 text-warning',
  'not-implemented': 'border-text-dim text-text-dim',
  busy: 'border-warning/70 text-warning',
  error: 'border-error/70 text-error',
};

/** Wynik przebiegu (także zbiorczego w widoku pakietu). */
export function AutoResult({ msg, onClose }: { msg: AutoMessage; onClose: () => void }): JSX.Element {
  return (
    <div className={`mx-2 mb-1 border-l-2 bg-bg-main px-2 py-1 ${KIND_STYLE[msg.kind]}`} data-testid="auto-result">
      <div className="flex items-start gap-2">
        <span className="font-bold">{msg.title}</span>
        {msg.uncertain && (
          <span className="text-error">
            — wynik niepewny — przeładuj stronę{' '}
            <button onClick={() => window.location.reload()} className="border border-error/70 px-1.5 text-text-main hover:bg-error/30">
              przeładuj
            </button>
          </span>
        )}
        <button onClick={onClose} className="ml-auto text-text-dim hover:text-text-main" title="zamknij">
          ✕
        </button>
      </div>
      {msg.lines.length > 0 && (
        <ul className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] text-text-main">
          {msg.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
