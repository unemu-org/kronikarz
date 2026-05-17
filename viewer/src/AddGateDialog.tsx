import { useState } from 'react';
import type { Gate } from '@kronikarz/shared';
import { useDocStore } from './store.ts';

interface Props {
  x: number; // scan coords
  y: number;
  onClose: () => void;
}

export function AddGateDialog({ x, y, onClose }: Props): JSX.Element {
  const editPage = useDocStore((s) => s.editPage);
  const editPackage = useDocStore((s) => s.editPackage);
  const pkg = useDocStore((s) => s.pkg);
  const setSelection = useDocStore((s) => s.setSelection);
  const [ref, setRef] = useState('');
  const [gate, setGate] = useState('');
  const [ic, setIc] = useState('');

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!ref) return;
    const gateLetter = gate.trim() || autoLetter(pkg, ref);
    const icSuffix = ic.trim() || null;

    let newIdx = -1;
    editPage((page) => {
      const newGate: Gate = {
        ref: ref.trim(),
        gate: gateLetter || null,
        x,
        y,
        rotation: 0,
        pins: [],
        verified: false,
        note: null,
      };
      page.gates.push(newGate);
      newIdx = page.gates.length - 1;
    });

    // Sync into package.yaml
    if (pkg) {
      editPackage((p) => {
        const existing = p.components[ref];
        if (!existing) {
          if (icSuffix) {
            p.components[ref] = {
              ic: icSuffix,
              gates: gateLetter ? { [gateLetter]: { page: pageId(pkg) ?? '' } } : {},
            };
          } else {
            p.components[ref] = {
              ic: null,
              type: 'unknown',
              pages: [],
            } as never;
          }
        } else if (existing.ic !== null && 'gates' in existing && gateLetter && !existing.gates[gateLetter]) {
          existing.gates[gateLetter] = { page: pageId(pkg) ?? '' };
        }
      });
    }

    if (newIdx >= 0) setSelection({ kind: 'gate', idx: newIdx });
    onClose();
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-72 space-y-2 border border-phosphor bg-bg-panel p-3 text-xs"
      >
        <h2 className="font-bold text-phosphor">Nowa bramka @ {x},{y}</h2>
        <div className="flex items-center gap-2">
          <label className="w-12 text-text-dim">ref</label>
          <input
            autoFocus
            className="flex-1 bg-bg-accent px-1 py-0.5"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="M22"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-12 text-text-dim">gate</label>
          <input
            className="flex-1 bg-bg-accent px-1 py-0.5"
            value={gate}
            onChange={(e) => setGate(e.target.value)}
            placeholder="A (auto jeśli puste)"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-12 text-text-dim">ic</label>
          <input
            className="flex-1 bg-bg-accent px-1 py-0.5"
            value={ic}
            onChange={(e) => setIc(e.target.value)}
            placeholder="04"
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            className="flex-1 bg-phosphor-dim px-2 py-1 text-bg-main hover:bg-phosphor"
          >
            Dodaj
          </button>
          <button type="button" className="px-2 py-1 text-text-dim" onClick={onClose}>
            Anuluj
          </button>
        </div>
      </form>
    </div>
  );
}

function autoLetter(pkg: ReturnType<typeof useDocStore.getState>['pkg'], ref: string): string {
  if (!pkg) return 'A';
  const c = pkg.components[ref];
  if (!c || c.ic === null) return 'A';
  const used = new Set(Object.keys(c.gates));
  for (const l of 'ABCDEFGHIJKLMNOP') {
    if (!used.has(l)) return l;
  }
  return 'A';
}

function pageId(pkg: NonNullable<ReturnType<typeof useDocStore.getState>['pkg']>): string | null {
  // The active page is the one currently in store; we read from there
  const p = useDocStore.getState().page;
  return p ? p.page : pkg.package.pages[0]?.id ?? null;
}
