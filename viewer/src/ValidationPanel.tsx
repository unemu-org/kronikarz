import { useState } from 'react';
import type { Issue } from '@kronikarz/shared';
import { parsePageFilePath, useDocStore } from './store.ts';
import { navigate } from './router.ts';
import { STEP_META, groupIssues, issueStepOf } from './stepView.ts';

export function ValidationPanel(): JSX.Element {
  const issues = useDocStore((s) => s.issues);
  const route = useDocStore((s) => s.route);
  const project = useDocStore((s) => s.project);
  const pkg = useDocStore((s) => s.pkg);
  const setSelection = useDocStore((s) => s.setSelection);
  // Strona: tylko problemy bieżącego kroku (i „inne” bez kroku), chyba że
  // „wszystkie”. Bez kroku / ⑥ / poza stroną — wszystko jak dotąd.
  const currentStep = useDocStore((s) => s.currentStep);
  const pagePath = useDocStore((s) => s.pagePath);
  const [all, setAll] = useState(false);
  const filtering = route.mode === 'page' && currentStep !== null && currentStep !== 'kicad';
  const pageId = pagePath ? parsePageFilePath(pagePath)?.pageId : undefined;
  const groups = groupIssues(issues, route.mode === 'page' ? currentStep : null, all, pageId);
  const shown = [...groups.step, ...groups.other];

  const counts = shown.reduce(
    (a, i) => ({ ...a, [i.level]: (a[i.level] ?? 0) + 1 }),
    { err: 0, warn: 0, info: 0 } as Record<'err' | 'warn' | 'info', number>,
  );

  function onIssueClick(code: string, ref?: string) {
    if (!ref) return;
    // Issues with ref like "M5.A" → if in page, select that gate
    if (route.mode === 'page' && useDocStore.getState().page) {
      const page = useDocStore.getState().page!;
      const refRoot = ref.split('.')[0];
      const idx = page.gates.findIndex((g) => g.ref === refRoot);
      if (idx >= 0) {
        setSelection({ kind: 'gate', idx });
        return;
      }
      if (page.nets[ref]) {
        setSelection({ kind: 'net', name: ref });
        return;
      }
    }
    // Backplane signal etc — try jump to first package containing it
    if (project) {
      for (const p of project.packages) {
        if (ref.startsWith(p.id)) {
          navigate({ mode: 'package', pkg: p.id });
          return;
        }
      }
    }
  }

  return (
    <section className="border-t border-bg-accent bg-bg-panel p-2 text-xs">
      <div className="flex items-center gap-3">
        <h3 className="font-bold text-text-dim">WALIDACJA</h3>
        {filtering && (
          <span className="text-text-dim">
            {all ? 'wszystkie kroki' : `krok ${STEP_META[currentStep].glyph} ${STEP_META[currentStep].name}`}
          </span>
        )}
        <span className="text-error">{counts.err} err</span>
        <span className="text-warning">{counts.warn} warn</span>
        <span className="text-text-dim">{counts.info} info</span>
        {filtering && !all && groups.hidden > 0 && (
          <span className="text-text-dim">(ukryte: {groups.hidden} — inne kroki / strony)</span>
        )}
        {filtering && (
          <label className="ml-auto flex cursor-pointer items-center gap-1 text-text-dim">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            wszystkie
          </label>
        )}
        <span className={filtering ? 'text-text-dim' : 'ml-auto text-text-dim'}>
          {pkg ? `${pkg.package.id}` : project ? project.project.name : '—'}
        </span>
      </div>
      <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-[10px]">
        {shown.length === 0 && (
          <li className="text-text-dim">{filtering && !all ? '— brak problemów w tym kroku —' : '— brak problemów —'}</li>
        )}
        {groups.step.map((i, k) => (
          <IssueRow key={`s${k}`} issue={i} onClick={() => onIssueClick(i.code, i.ref)} />
        ))}
        {groups.other.length > 0 && <li className="pt-0.5 text-text-dim">inne (bez kroku):</li>}
        {groups.other.map((i, k) => (
          <IssueRow key={`o${k}`} issue={i} onClick={() => onIssueClick(i.code, i.ref)} />
        ))}
      </ul>
    </section>
  );
}

function IssueRow({ issue: i, onClick }: { issue: Issue; onClick: () => void }): JSX.Element {
  const st = issueStepOf(i);
  return (
    <li
      className={`cursor-pointer hover:bg-bg-accent ${
        i.level === 'err' ? 'text-error' : i.level === 'warn' ? 'text-warning' : 'text-text-dim'
      }`}
      onClick={onClick}
      title={i.ref ?? ''}
    >
      <span className="font-bold">{i.level.toUpperCase()}</span>{' '}
      <span className="text-text-dim">{st ? STEP_META[st].glyph : '·'}</span> {i.code}: {i.message}
    </li>
  );
}
