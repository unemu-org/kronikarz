import { useDocStore } from './store.ts';

export function SaveToast(): JSX.Element | null {
  const status = useDocStore((s) => s.saveStatus);
  const err = useDocStore((s) => s.saveError);
  if (status === 'idle') return null;
  const cls =
    status === 'saving'
      ? 'border-warning text-warning'
      : status === 'error'
        ? 'border-error text-error'
        : 'border-text-dim text-text-dim';
  const label =
    status === 'pending'
      ? 'zmiana...'
      : status === 'saving'
        ? 'zapisuje'
        : `błąd: ${err ?? '?'}`;
  return (
    <div
      className={`pointer-events-none fixed bottom-3 right-3 z-50 border bg-bg-panel px-2 py-1 text-xs ${cls}`}
    >
      {label}
    </div>
  );
}
