import { useEffect, useRef as useReactRef, useState } from 'react';
import type { Gate, Pin, Side } from '@kronikarz/shared';
import { useDocStore } from './store.ts';

interface Props {
  x: number; // scan coords
  y: number;
  onClose: () => void;
}

type Kind = 'ic' | 'resistor' | 'capacitor' | 'jumper';

export function AddGateDialog({ x, y, onClose }: Props): JSX.Element {
  const editPage = useDocStore((s) => s.editPage);
  const editPackage = useDocStore((s) => s.editPackage);
  const pkg = useDocStore((s) => s.pkg);
  const setSelection = useDocStore((s) => s.setSelection);
  const [kind, setKind] = useState<Kind>('ic');
  const [ref, setRef] = useState('');
  const refTouchedRef = useReactRef(false);
  // Auto-fill ref with next free Rn/Cn/JPn when kind changes and user hasn't typed.
  useEffect(() => {
    if (refTouchedRef.current) return;
    if (kind === 'ic') { setRef(''); return; }
    const prefix = kind === 'resistor' ? 'R' : kind === 'capacitor' ? 'C' : 'JP';
    setRef(nextFreeRefByPrefix(pkg, prefix));
  }, [kind, pkg]);
  const [gate, setGate] = useState('');
  const [ic, setIc] = useState('');
  const [value, setValue] = useState('');
  const [polarized, setPolarized] = useState(false);
  const [positions, setPositions] = useState('D,C');

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!ref) return;

    if (kind === 'ic') {
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

      if (pkg && icSuffix) {
        editPackage((p) => {
          const existing = p.components[ref];
          if (!existing) {
            p.components[ref] = {
              ic: icSuffix,
              gates: gateLetter ? { [gateLetter]: { page: pageId(pkg) ?? '' } } : {},
            };
          } else if (existing.ic !== null && 'gates' in existing && gateLetter && !existing.gates[gateLetter]) {
            existing.gates[gateLetter] = { page: pageId(pkg) ?? '' };
          }
        });
      }

      if (newIdx >= 0) setSelection({ kind: 'gate', idx: newIdx });
      onClose();
      return;
    }

    // Passive (resistor / capacitor / jumper)
    const refTrim = ref.trim();
    const valueTrim = value.trim();
    const posList = kind === 'jumper'
      ? positions.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
    const pins = kind === 'jumper' ? jumperPins(x, y, posList.length) : passivePins(x, y, 0);
    let newIdx = -1;
    editPage((page) => {
      const newGate: Gate = {
        ref: refTrim,
        gate: null,
        x,
        y,
        rotation: 0,
        pins,
        value: kind === 'jumper' ? undefined : (valueTrim || undefined),
        verified: false,
        note: null,
      };
      page.gates.push(newGate);
      newIdx = page.gates.length - 1;
    });

    if (pkg) {
      editPackage((p) => {
        const existing = p.components[refTrim];
        const pid = pageId(pkg) ?? '';
        if (!existing) {
          if (kind === 'jumper') {
            p.components[refTrim] = {
              ic: null,
              type: 'jumper',
              positions: posList,
              selected: null,
              pages: pid ? [pid] : [],
            };
          } else {
            p.components[refTrim] = {
              ic: null,
              type: kind,
              value: valueTrim,
              ...(kind === 'capacitor' && polarized ? { polarized: true } : {}),
              pages: pid ? [pid] : [],
            };
          }
        } else if (existing.ic === null) {
          if (!existing.pages.includes(pid)) existing.pages.push(pid);
          if (existing.type !== 'jumper' && valueTrim && !existing.value) existing.value = valueTrim;
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
        className="w-80 space-y-2 border border-phosphor bg-bg-panel p-3 text-xs"
      >
        <h2 className="font-bold text-phosphor">Nowy element @ {x},{y}</h2>
        <div className="flex items-center gap-2">
          <label className="w-12 text-text-dim">typ</label>
          <div className="flex flex-1 gap-2">
            {(['ic', 'resistor', 'capacitor', 'jumper'] as Kind[]).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                <span>{k === 'ic' ? 'IC' : k === 'resistor' ? 'R' : k === 'capacitor' ? 'C' : 'JP'}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="w-12 text-text-dim">ref</label>
          <input
            autoFocus
            className="flex-1 bg-bg-accent px-1 py-0.5"
            value={ref}
            onChange={(e) => { refTouchedRef.current = true; setRef(e.target.value); }}
            placeholder={kind === 'ic' ? 'M22' : kind === 'resistor' ? 'R4' : kind === 'capacitor' ? 'C1' : 'JP1'}
          />
        </div>
        {kind === 'ic' && (
          <>
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
          </>
        )}
        {(kind === 'resistor' || kind === 'capacitor') && (
          <>
            <div className="flex items-center gap-2">
              <label className="w-12 text-text-dim">wartość</label>
              <input
                className="flex-1 bg-bg-accent px-1 py-0.5"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={kind === 'resistor' ? '1k' : '0,1μF'}
              />
            </div>
            {kind === 'capacitor' && (
              <div className="flex items-center gap-2">
                <label className="w-12 text-text-dim">polar</label>
                <input
                  type="checkbox"
                  checked={polarized}
                  onChange={(e) => setPolarized(e.target.checked)}
                />
                <span className="text-text-dim">polaryzowany</span>
              </div>
            )}
          </>
        )}
        {kind === 'jumper' && (
          <div className="flex items-center gap-2">
            <label className="w-12 text-text-dim">pozycje</label>
            <input
              className="flex-1 bg-bg-accent px-1 py-0.5"
              value={positions}
              onChange={(e) => setPositions(e.target.value)}
              placeholder="D,C"
            />
          </div>
        )}
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
  const p = useDocStore.getState().page;
  return p ? p.page : pkg.package.pages[0]?.id ?? null;
}

// Scan package.components for max N in prefix+digits refs, return prefix+(N+1).
function nextFreeRefByPrefix(pkg: ReturnType<typeof useDocStore.getState>['pkg'], prefix: string): string {
  if (!pkg) return `${prefix}1`;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const key of Object.keys(pkg.components)) {
    const m = re.exec(key);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

// One pin per jumper position, in a row.
export function jumperPins(cx: number, cy: number, count: number): Pin[] {
  const STEP = 22;
  const n = Math.max(1, count);
  const startX = cx - ((n - 1) * STEP) / 2;
  const pins: Pin[] = [];
  for (let i = 0; i < n; i++) {
    pins.push({ num: i + 1, side: 'bottom', net: '', px: Math.round(startX + i * STEP), py: cy });
  }
  return pins;
}

// Two pins on opposite ends aligned with rotation axis.
// Default lead length matches resistor body width (~50px tip-to-tip).
export function passivePins(cx: number, cy: number, rotation: number): Pin[] {
  const L = 28; // half-distance tip-to-center
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // local: pin1 at (-L,0), pin2 at (+L,0)
  const p1x = Math.round(cx + -L * cos);
  const p1y = Math.round(cy + -L * sin);
  const p2x = Math.round(cx + L * cos);
  const p2y = Math.round(cy + L * sin);
  // sides per rotation: horizontal → left/right, vertical → top/bottom
  let s1: Side = 'left';
  let s2: Side = 'right';
  if (rotation === 90) { s1 = 'top'; s2 = 'bottom'; }
  else if (rotation === 180) { s1 = 'right'; s2 = 'left'; }
  else if (rotation === 270) { s1 = 'bottom'; s2 = 'top'; }
  return [
    { num: 1, side: s1, net: '', px: p1x, py: p1y },
    { num: 2, side: s2, net: '', px: p2x, py: p2y },
  ];
}
