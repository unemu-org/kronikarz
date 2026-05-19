import { useState } from 'react';
import type { Port, Side } from '@kronikarz/shared';
import { useDocStore } from './store.ts';

interface Props {
  x: number;
  y: number;
  onClose: () => void;
}

const SIDES: Side[] = ['left', 'right', 'top', 'bottom'];

export function AddPortDialog({ x, y, onClose }: Props): JSX.Element {
  const editPage = useDocStore((s) => s.editPage);
  const setSelection = useDocStore((s) => s.setSelection);
  const [connector, setConnector] = useState('');
  const [pin, setPin] = useState('');
  const [label, setLabel] = useState('');
  const [net, setNet] = useState('');
  const [side, setSide] = useState<Side>('left');

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const c = connector.trim().toUpperCase();
    const pn = parseInt(pin, 10);
    if (!c || !Number.isFinite(pn)) return;
    const pid = `${c}${pn}`;
    const port: Port = {
      connector: c,
      pin: pn,
      label: label.trim() || pid,
      net: net.trim() || label.trim() || pid,
      x,
      y,
      side,
    };
    let newIdx = -1;
    editPage((p) => {
      const arr = (p.ports ??= []);
      arr.push(port);
      newIdx = arr.length - 1;
    });
    if (newIdx >= 0) setSelection({ kind: 'port', idx: newIdx });
    onClose();
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-80 space-y-2 border border-phosphor bg-bg-panel p-3 text-xs"
      >
        <h2 className="font-bold text-phosphor">Nowy port @ {x},{y}</h2>
        <Row label="connector">
          <input autoFocus value={connector} onChange={(e) => setConnector(e.target.value)} placeholder="A" className="flex-1 bg-bg-accent px-1 py-0.5" />
        </Row>
        <Row label="pin">
          <input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="50" className="flex-1 bg-bg-accent px-1 py-0.5" />
        </Row>
        <Row label="label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="-BLR (auto = connector)" className="flex-1 bg-bg-accent px-1 py-0.5" />
        </Row>
        <Row label="net">
          <input value={net} onChange={(e) => setNet(e.target.value)} placeholder="(auto = label)" className="flex-1 bg-bg-accent px-1 py-0.5" />
        </Row>
        <Row label="side">
          <select value={side} onChange={(e) => setSide(e.target.value as Side)} className="flex-1 bg-bg-accent px-1 py-0.5">
            {SIDES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Row>
        <div className="flex gap-2 pt-1">
          <button type="submit" className="flex-1 bg-phosphor-dim px-2 py-1 text-bg-main hover:bg-phosphor">Dodaj</button>
          <button type="button" className="px-2 py-1 text-text-dim" onClick={onClose}>Anuluj</button>
        </div>
      </form>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 text-text-dim">{label}</label>
      {children}
    </div>
  );
}
