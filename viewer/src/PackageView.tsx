import { useState } from 'react';
import { useDocStore } from './store.ts';
import { navigate } from './router.ts';
import { PackageAutoRun, StepMarks, usePagesLive } from './StepMarks.tsx';

type Tab = 'schemat' | 'pcb-front' | 'pcb-back';

export function PackageView(): JSX.Element | null {
  const pkg = useDocStore((s) => s.pkg);
  const icMap = useDocStore((s) => s.icMap);
  const route = useDocStore((s) => s.route);
  const [tab, setTab] = useState<Tab>('schemat');
  const pages = usePagesLive();

  if (!pkg) return null;

  const pcb = pkg.package.pcb;
  const components = pkg.components ?? {};
  const refs = Object.keys(components).sort();

  let bg: string | null = null;
  if (tab === 'pcb-front' && pcb?.front) bg = `/files/MJC-400/${pkg.package.id}/${pcb.front}`;
  if (tab === 'pcb-back' && pcb?.back) bg = `/files/MJC-400/${pkg.package.id}/${pcb.back}`;

  return (
    <div className="flex flex-1 overflow-hidden">
      <main className="flex flex-1 flex-col">
        <div className="flex gap-1 border-b border-bg-accent bg-bg-panel px-3 py-1 text-xs">
          <TabBtn label="Schemat" on={tab === 'schemat'} onClick={() => setTab('schemat')} />
          <TabBtn label="PCB Front" on={tab === 'pcb-front'} onClick={() => setTab('pcb-front')} disabled={!pcb?.front} />
          <TabBtn label="PCB Back" on={tab === 'pcb-back'} onClick={() => setTab('pcb-back')} disabled={!pcb?.back} />
        </div>
        <div className="relative flex-1 overflow-hidden bg-bg-main">
          {tab === 'schemat' && (
            <div className="border-b border-bg-accent bg-bg-panel px-3 py-1 text-xs">
              <PackageAutoRun pkg={pkg.package.id} />
            </div>
          )}
          {tab === 'schemat' && (
            <div className="grid grid-cols-3 gap-2 p-3 text-xs sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6">
              {pkg.package.pages.map((p) => (
                <button
                  key={p.id}
                  onClick={() => navigate({ mode: 'page', pkg: pkg.package.id, page: p.id })}
                  className="flex flex-col items-center gap-1 border border-bg-accent bg-bg-panel p-2 hover:border-phosphor"
                >
                  <img
                    src={`/files/MJC-400/${pkg.package.id}/${p.scan}`}
                    alt={p.id}
                    className="h-24 w-full object-contain"
                    loading="lazy"
                  />
                  <span className="text-phosphor">{p.id}</span>
                  <span className="text-text-dim">{p.status}</span>
                  <StepMarks page={pages.get(p.id)} />
                </button>
              ))}
            </div>
          )}
          {bg && (
            <img src={bg} alt="PCB" className="absolute inset-0 m-auto max-h-full max-w-full object-contain" />
          )}
          {(tab === 'pcb-front' || tab === 'pcb-back') && !bg && (
            <div className="flex h-full items-center justify-center text-text-dim">brak zdjecia PCB</div>
          )}
        </div>
      </main>
      <aside className="w-72 shrink-0 overflow-y-auto border-l border-bg-accent bg-bg-panel p-2 text-xs">
        <h2 className="mb-2 font-bold text-phosphor">{pkg.package.id}</h2>
        <div className="text-text-dim">
          {pkg.package.name} · {pkg.package.status}
        </div>
        <div className="text-text-dim">stron: {pkg.package.pages.length}</div>
        <hr className="my-3 border-bg-accent" />
        <h3 className="mb-1 text-text-dim">REJESTR IC ({refs.length})</h3>
        <table className="w-full">
          <tbody>
            {refs.map((ref) => {
              const c = components[ref];
              if (!c) return null;
              const ic = c.ic ?? null;
              const icDef = ic && icMap ? icMap[ic] : null;
              let counters = '';
              if (c.ic !== null && 'gates' in c) {
                const total = Object.keys(c.gates).length;
                const mapped = Object.values(c.gates).filter((g) => g !== null).length;
                counters = `${mapped}/${total}`;
              } else if (c.ic === null && 'pages' in c) {
                counters = c.pages.length > 0 ? `${c.pages.length} stron` : '—';
              }
              const firstPage =
                c.ic !== null && 'gates' in c
                  ? Object.values(c.gates).find((g) => g)?.page
                  : c.ic === null && 'pages' in c
                    ? c.pages[0]
                    : undefined;
              return (
                <tr key={ref}>
                  <td>
                    <button
                      onClick={() =>
                        firstPage &&
                        navigate({ mode: 'page', pkg: pkg.package.id, page: firstPage })
                      }
                      className="text-left text-phosphor hover:underline disabled:text-text-dim"
                      disabled={!firstPage}
                    >
                      {ref}
                    </button>
                  </td>
                  <td className="text-text-dim">{ic ?? '—'}</td>
                  <td className="text-text-dim">{icDef?.name ?? (c.ic === null ? c.type : '?')}</td>
                  <td className="text-right text-text-dim">{counters}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <hr className="my-3 border-bg-accent" />
        <BomSummary />
      </aside>
    </div>
  );
}

function TabBtn({
  label,
  on,
  onClick,
  disabled,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-0.5 ${
        on ? 'bg-phosphor-dim text-bg-main' : 'text-text-main hover:bg-bg-accent'
      } disabled:text-text-dim disabled:hover:bg-transparent`}
    >
      {label}
    </button>
  );
}

function BomSummary(): JSX.Element {
  const pkg = useDocStore((s) => s.pkg);
  if (!pkg) return <></>;
  const comps = pkg.components ?? {};
  const byType: Record<string, number> = {};
  let icCount = 0;
  let passiveCount = 0;
  for (const c of Object.values(comps)) {
    if (c.ic !== null) {
      icCount += 1;
      const key = c.ic;
      byType[key] = (byType[key] ?? 0) + 1;
    } else {
      passiveCount += 1;
      const key = c.type ?? 'passive';
      byType[key] = (byType[key] ?? 0) + 1;
    }
  }
  return (
    <>
      <h3 className="mb-1 text-text-dim">
        BOM ({icCount} IC + {passiveCount} pasywnych)
      </h3>
      <ul>
        {Object.entries(byType)
          .sort(([, a], [, b]) => b - a)
          .map(([k, n]) => (
            <li key={k}>
              <span className="text-phosphor">{k}</span>{' '}
              <span className="text-text-dim">× {n}</span>
            </li>
          ))}
      </ul>
    </>
  );
}
