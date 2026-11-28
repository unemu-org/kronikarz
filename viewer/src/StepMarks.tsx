// Znaczki stanu kroków ①–⑤ strony (lista stron, widok pakietu) i zbiorczy
// przebieg „następny krok na wszystkich stronach” (kr-9p8.20).
import { useState } from 'react';
import type { Page } from '@kronikarz/shared';
import { flushSavesOrAlert, parsePageFilePath, useDocStore } from './store.ts';
import { pollAutoStatus, postAuto } from './autoRun.ts';
import { AutoResult } from './StepBar.tsx';
import { STATUS_LABEL, STEP_META, autoBody, autoReplyMessage, shouldRefreshPackage, stepMarks, type AutoMessage } from './stepView.ts';

/** Strony pakietu z dysku (allPages), otwarta strona w wersji z edycji. */
export function usePagesLive(): Map<string, Page> {
  const allPages = useDocStore((s) => s.allPages);
  const page = useDocStore((s) => s.page);
  const pagePath = useDocStore((s) => s.pagePath);
  const openId = pagePath ? parsePageFilePath(pagePath)?.pageId : undefined;
  if (!page || !openId) return allPages;
  const m = new Map(allPages);
  m.set(openId, page);
  return m;
}

export function StepMarks({ page }: { page: Page | undefined }): JSX.Element {
  const marks = stepMarks(page);
  return (
    <span
      className="tracking-wider"
      title={marks.map((m) => `${STEP_META[m.step].glyph} ${STEP_META[m.step].name}: ${STATUS_LABEL[m.status]}`).join('\n')}
      data-testid="step-marks"
    >
      {marks.map((m) => (
        <span key={m.step} style={{ color: m.color }}>
          {m.mark}
        </span>
      ))}
    </span>
  );
}

/**
 * „Uruchom następny krok na wszystkich stronach”: POST /auto {page: 'all',
 * step: 'next'} z potwierdzeniem; w trakcie GET /auto/status; potem wynik
 * per strona i ponowne wczytanie pakietu (znaczki, otwarte dane).
 */
export function PackageAutoRun({ pkg }: { pkg: string }): JSX.Element {
  const [running, setRunning] = useState<{ since: number; now: number } | null>(null);
  const [msg, setMsg] = useState<AutoMessage | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const anyRun = useDocStore((s) => s.autoRuns > 0); // jeden przebieg naraz w karcie

  async function run() {
    if (running || anyRun) return;
    if (
      !window.confirm(
        `Uruchomić następny krok na wszystkich stronach pakietu ${pkg}?\n` +
          `Na każdej stronie przebiegnie pierwszy niezatwierdzony krok, którego poprzednik jest zatwierdzony.` +
          (dryRun ? '\n(podgląd: nic nie zostanie zapisane)' : '\nStrony zostaną zapisane (kopie .bak).'),
      )
    )
      return;
    if (!(await flushSavesOrAlert('Następny krok na wszystkich stronach'))) return;
    setMsg(null);
    const since = Date.now();
    setRunning({ since, now: since });
    const stop = pollAutoStatus(() => setRunning((r) => r && { ...r, now: Date.now() }));
    try {
      const { status, data } = await postAuto(autoBody(pkg, 'all', 'next', { dryRun }));
      const m = autoReplyMessage(status, data);
      setMsg(m);
      // Zapisane strony → wczytaj pakiet od nowa (nowy obiekt trasy = loader),
      // ale tylko, gdy użytkownik nadal jest w widoku tego pakietu — bieżąca
      // trasa ze store, nigdy ta sprzed przebiegu.
      const now = useDocStore.getState().route;
      if ((m.written.length > 0 || m.uncertain) && shouldRefreshPackage(now, pkg)) useDocStore.getState().setRoute({ ...now });
    } finally {
      stop();
      setRunning(null);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={run}
          disabled={!!running || anyRun}
          className="border border-phosphor-dim bg-phosphor-dim/30 px-2 py-0.5 text-text-main hover:bg-phosphor-dim disabled:opacity-50"
          title="POST /auto {page: all, step: next}"
          data-testid="run-next-all"
        >
          {running ? `⏳ trwa… ${Math.round((running.now - running.since) / 1000)} s` : '▶ Uruchom następny krok na wszystkich stronach'}
        </button>
        <label className="flex cursor-pointer items-center gap-1 text-text-dim">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          podgląd (dry-run)
        </label>
      </div>
      {msg && <AutoResult msg={msg} onClose={() => setMsg(null)} />}
    </div>
  );
}
