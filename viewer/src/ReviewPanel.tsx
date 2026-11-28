// Kolejka przeglądu bieżącego kroku (kr-9p8.20, wersja minimalna — kr-9p8.7
// ją rozbuduje): elementy kroku z `src: auto`, najpierw niepewne; klik albo
// N / Shift+N → zaznacz i przybliż. Na dole „Zatwierdź krok” / „Cofnij
// zatwierdzenie” (editPage — stan kroku nie jest treścią).
import { useEffect, useMemo, useState } from 'react';
import { stepStatus } from '@kronikarz/shared';
import { isLocked, parsePageFilePath, useDocStore } from './store.ts';
import { plainKey } from './hotkeys.ts';
import {
  PROV_COLORS,
  STATUS_COLOR,
  STATUS_LABEL,
  STEP_META,
  approveStep,
  canApprove,
  isStepName,
  reviewQueue,
  stepCounts,
  stepQueueIndex,
  unapproveStep,
  type ReviewItem,
} from './stepView.ts';

function focus(item: ReviewItem): void {
  useDocStore.getState().setSelection(item.select);
  window.dispatchEvent(new CustomEvent('kronikarz:zoom-to', { detail: item.box }));
}

export function ReviewPanel(): JSX.Element | null {
  const page = useDocStore((s) => s.page);
  const pagePath = useDocStore((s) => s.pagePath);
  const currentStep = useDocStore((s) => s.currentStep);
  const issues = useDocStore((s) => s.issues);
  const editPage = useDocStore((s) => s.editPage);
  const locked = useDocStore(isLocked);
  const [cur, setCur] = useState(-1);
  const step = isStepName(currentStep) ? currentStep : null;
  const queue = useMemo(() => (page && step ? reviewQueue(page, step, issues) : []), [page, step, issues]);
  useEffect(() => setCur(-1), [step, pagePath]);

  // N = następny, Shift+N = poprzedni element kolejki.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (plainKey(e) !== 'n' || queue.length === 0) return;
      const i = stepQueueIndex(queue.length, cur, e.shiftKey ? -1 : 1);
      setCur(i);
      focus(queue[i]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [queue, cur]);

  if (!page || !pagePath || !step) return null;
  const pageId = parsePageFilePath(pagePath)?.pageId ?? page.page;
  const st = stepStatus(page, step);
  const counts = stepCounts(page, step);
  const unsure = queue.filter((q) => q.flags.length > 0).length;
  const approve = canApprove(page, step, issues, pageId);
  const meta = STEP_META[step];

  const doApprove = () => {
    if (!approve.ok) return;
    if (st === 'todo' && !window.confirm(`Krok ${meta.glyph} nie był uruchomiony. Zatwierdzić bieżącą (ręczną) treść kroku?`)) return;
    editPage((p) => approveStep(p, step, new Date().toISOString()));
  };
  const doUnapprove = () => {
    if (!window.confirm(`Cofnąć zatwierdzenie kroku ${meta.glyph}? Późniejsze zatwierdzone kroki staną się nieaktualne.`)) return;
    editPage((p) => unapproveStep(p, step, new Date().toISOString()));
  };

  return (
    <section className="flex max-h-[55%] min-h-0 shrink-0 flex-col border-b border-bg-accent text-xs" data-testid="review-panel">
      <div className="border-b border-bg-accent p-2">
        <h2 className="flex items-baseline justify-between font-bold text-text-main">
          <span>
            {meta.glyph} {meta.name}
          </span>
          <span className="text-[10px] font-normal" style={{ color: STATUS_COLOR[st] }}>
            {STATUS_LABEL[st]}
          </span>
        </h2>
        <div className="text-[10px] text-text-dim">źródło: {meta.source}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px]">
          <span className="text-text-dim">elementów: {counts.total}</span>
          <span style={{ color: PROV_COLORS.auto }}>auto: {counts.auto}</span>
          <span style={{ color: PROV_COLORS.edited }}>ludzkie: {counts.edited}</span>
          <span className={unsure ? 'text-error' : 'text-text-dim'}>niepewne: {unsure}</span>
        </div>
        <div className="mt-1 flex h-1 overflow-hidden bg-bg-main">
          <i style={{ width: `${counts.total ? (counts.edited / counts.total) * 100 : 0}%`, background: PROV_COLORS.edited }} />
          <i style={{ width: `${counts.total ? (counts.auto / counts.total) * 100 : 0}%`, background: PROV_COLORS.auto }} />
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        {queue.length === 0 && (
          <li className="border border-dashed border-bg-accent p-2 text-text-dim">
            {st === 'todo' ? 'krok jeszcze nie uruchomiony — „Uruchom krok” na pasku kroków' : 'brak elementów auto do przeglądu w tym kroku'}
          </li>
        )}
        {queue.map((q, i) => (
          <li
            key={q.key}
            onClick={() => {
              setCur(i);
              focus(q);
            }}
            className={`mb-0.5 cursor-pointer border-l-2 bg-bg-main px-1.5 py-0.5 hover:bg-bg-accent ${i === cur ? 'outline outline-1 outline-selected' : ''}`}
            style={{ borderLeftColor: q.flags.length ? '#ff3838' : st === 'approved' ? PROV_COLORS.approved : PROV_COLORS.auto }}
            title={q.flags.join('\n')}
          >
            <div className="truncate text-text-main">{q.label}</div>
            {q.flags.length > 0 && <div className="truncate text-[10px] text-error">{q.flags.join(' · ')}</div>}
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1 border-t border-bg-accent p-2">
        {st === 'approved' ? (
          <button onClick={doUnapprove} disabled={locked} className="border border-bg-accent disabled:opacity-40 px-2 py-1 text-text-dim hover:bg-bg-accent">
            Cofnij zatwierdzenie {meta.glyph}
          </button>
        ) : (
          <button
            onClick={doApprove}
            disabled={!approve.ok || locked}
            className="border border-verified/70 bg-verified/20 px-2 py-1 text-text-main hover:bg-verified/40 disabled:opacity-40"
            title={approve.reason ?? (step === 'gates' ? 'zatwierdza krok i oznacza wszystkie bramki jako sprawdzone' : 'zatwierdza krok')}
            data-testid="approve-step"
          >
            Zatwierdź krok {meta.glyph}
          </button>
        )}
        {!approve.ok && st !== 'approved' && <div className="text-[10px] text-warning">{approve.reason}</div>}
        <div className="text-[10px] text-text-dim">
          <kbd>N</kbd> / <kbd>Shift+N</kbd> następny / poprzedni · klik = zaznacz i przybliż
        </div>
      </div>
    </section>
  );
}
