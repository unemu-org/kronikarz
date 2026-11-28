// Kolejka przeglądu bieżącego kroku (kr-9p8.20, wersja minimalna — kr-9p8.7
// ją rozbuduje): elementy kroku z `src: auto`, najpierw niepewne; klik albo
// N / Shift+N → zaznacz i przybliż. Na dole „Zatwierdź krok” / „Cofnij
// zatwierdzenie” (editPage — stan kroku nie jest treścią).
import { useEffect, useMemo, useState } from 'react';
import { stepStatus } from '@kronikarz/shared';
import { isLocked, parsePageFilePath, useDocStore } from './store.ts';
import { plainKey } from './hotkeys.ts';
import { liveSuspicious, useWireUi } from './useWireEditing.tsx';
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
  // Scalenia dwóch netów z ≥ 2 końcówkami każdy (W / J / przeciągnięcie końca) — tylko ta sesja.
  const suspiciousAll = useWireUi((s) => s.suspicious);
  const suspicious = currentStep === 'wires' || currentStep === 'nets' ? liveSuspicious(suspiciousAll, page, pagePath) : [];
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
        {suspicious.map((m, i) => (
          <li
            key={`sm-${i}`}
            onClick={() => {
              useDocStore.getState().setSelection({ kind: 'net', name: m.into });
              window.dispatchEvent(new CustomEvent('kronikarz:zoom-to', { detail: { x: m.x - 120, y: m.y - 90, w: 240, h: 180 } }));
            }}
            className="mb-0.5 cursor-pointer border-l-2 border-l-warning bg-bg-main px-1.5 py-0.5 hover:bg-bg-accent"
            title="scalenie dwóch netów, z których każdy miał ≥ 2 końcówki — sprawdź, czy drut nie trafił w zły net (Ctrl+Z cofa, J / T / X rozdziela)"
            data-testid="suspicious-merge"
          >
            <div className="truncate text-text-main">
              ⚠ scalono {m.from.join(', ')} → {m.into}
            </div>
            <div className="truncate text-[10px] text-warning">{m.endpoints} końcówek · podejrzane scalenie (ta sesja)</div>
          </li>
        ))}
        {queue.length === 0 && suspicious.length === 0 && (
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
        {(step === 'wires' || step === 'nets') && (
          <div className="text-[10px] text-text-dim" data-testid="wire-keys">
            druty (V / E / W, kursor nad drutem): <kbd>X</kbd> usuń · <kbd>J</kbd> kropka na skrzyżowaniu / T (dodaj / usuń) ·{' '}
            <kbd>T</kbd> przetnij · <kbd>W</kbd> rysuj: klik–klik, przyciąga do pinów / końców / drutów, 2×klik / Enter =
            wolny koniec, Esc · prostokąt (Alt = dotknięte, Shift = dodaj / zdejmij) + <kbd>Del</kbd> · E: przeciągnij koniec
            zaznaczonego odcinka · <kbd>Ctrl+Z</kbd> cofa każdą akcję
          </div>
        )}
      </div>
    </section>
  );
}
