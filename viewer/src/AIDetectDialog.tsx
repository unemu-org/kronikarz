import { useState } from 'react';
import type { Gate, Pin, Port, CrossRef, Side, Rotation } from '@kronikarz/shared';
import { useDocStore } from './store.ts';

export interface RoiRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AiDetection {
  class: string;
  ref: string | null;
  gate: string | null;
  ic: string | null;
  rotation: number;
  x: number;
  y: number;
  pins?: Array<{ num: number; side: Side; net: string | null; px: number; py: number; label?: string }>;
  label_left?: string | null;
  label_right?: string | null;
  port_connector?: string | null;
  port_label?: string | null;
  port_side?: Side | null;
  cross_pages?: string[] | null;
  cross_label?: string | null;
  note?: string | null;
}

interface Props {
  roi: RoiRect;
  detections: AiDetection[];
  onClose: () => void;
}

const CLASS_OPTIONS = [
  'nand2', 'nand3', 'nand4', 'nand8', 'inv', 'and2', 'or2', 'xor2',
  'dff', 'dff_quad', 'port', 'cross_ref', 'power_vcc', 'power_gnd', 'unknown',
];

export function AIDetectDialog({ roi, detections, onClose }: Props): JSX.Element {
  const editPage = useDocStore((s) => s.editPage);
  const route = useDocStore((s) => s.route);
  const page = useDocStore((s) => s.page);
  const [items, setItems] = useState<AiDetection[]>(
    detections.length ? detections : [{ class: 'unknown', ref: '', gate: null, ic: null, rotation: 0, x: roi.x + roi.w / 2, y: roi.y + roi.h / 2 }],
  );
  const [busy, setBusy] = useState(false);

  function patch(i: number, p: Partial<AiDetection>): void {
    setItems((arr) => arr.map((d, idx) => (idx === i ? { ...d, ...p } : d)));
  }

  function removeItem(i: number): void {
    setItems((arr) => arr.filter((_, idx) => idx !== i));
  }

  async function confirm(): Promise<void> {
    if (!page || !route.pkg) return;
    setBusy(true);
    try {
      editPage((p) => {
        for (const d of items) {
          if (d.class === 'port') {
            const newPort: Port = {
              connector: d.port_connector ?? '',
              label: d.port_label ?? '',
              net: d.port_label ?? '',
              x: d.x,
              y: d.y,
              side: (d.port_side ?? 'left') as Side,
            };
            (p.ports ??= []).push(newPort);
          } else if (d.class === 'cross_ref') {
            const newRef: CrossRef = {
              net: d.cross_label ?? '',
              label: d.cross_label ?? '',
              pages: d.cross_pages ?? [],
              x: d.x,
              y: d.y,
              side: (d.port_side ?? 'right') as Side,
            };
            (p.cross_refs ??= []).push(newRef);
          } else if (d.class === 'power_vcc' || d.class === 'power_gnd') {
            p.power.push({
              type: d.class === 'power_vcc' ? 'VCC' : 'GND',
              x: d.x,
              y: d.y,
              net: d.class === 'power_vcc' ? 'VCC' : 'GND',
            });
          } else {
            // Treat as a gate
            const pins: Pin[] = (d.pins ?? []).map((pn) => ({
              num: pn.num,
              side: pn.side,
              net: pn.net ?? '',
              px: pn.px,
              py: pn.py,
            }));
            const newGate: Gate = {
              ref: d.ref || '',
              gate: d.gate,
              x: d.x,
              y: d.y,
              rotation: ((d.rotation || 0) as Rotation),
              pins,
              label_left: d.label_left ?? undefined,
              label_right: d.label_right ?? undefined,
              verified: false,
              note: d.note ?? null,
            };
            p.gates.push(newGate);
          }
        }
      });

      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); confirm(); }}
        className="max-h-[90vh] w-[480px] space-y-3 overflow-y-auto border border-phosphor bg-bg-panel p-3 text-xs"
      >
        <h2 className="font-bold text-phosphor">
          AI Detect @ {roi.x},{roi.y} ({roi.w}×{roi.h}) — {items.length} obiekt(ów)
        </h2>
        {items.length === 0 && (
          <p className="text-text-dim">Brak wykryć. Dodaj ręcznie albo anuluj.</p>
        )}
        {items.map((d, i) => (
          <div key={i} className="space-y-1 border border-bg-accent p-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-phosphor">#{i + 1}</span>
              <button type="button" onClick={() => removeItem(i)} className="text-text-dim hover:text-red-400">
                ✕
              </button>
            </div>
            <Row label="class">
              <select
                value={d.class}
                onChange={(e) => patch(i, { class: e.target.value })}
                className="flex-1 bg-bg-accent px-1 py-0.5"
              >
                {CLASS_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Row>
            {d.class === 'port' ? (
              <>
                <Row label="conn"><Input v={d.port_connector ?? ''} on={(v) => patch(i, { port_connector: v })} /></Row>
                <Row label="label"><Input v={d.port_label ?? ''} on={(v) => patch(i, { port_label: v })} /></Row>
                <Row label="side">
                  <select value={d.port_side ?? 'left'} onChange={(e) => patch(i, { port_side: e.target.value as Side })} className="flex-1 bg-bg-accent px-1 py-0.5">
                    <option value="left">left</option><option value="right">right</option>
                    <option value="top">top</option><option value="bottom">bottom</option>
                  </select>
                </Row>
              </>
            ) : d.class === 'cross_ref' ? (
              <>
                <Row label="label"><Input v={d.cross_label ?? ''} on={(v) => patch(i, { cross_label: v })} /></Row>
                <Row label="pages">
                  <Input
                    v={(d.cross_pages ?? []).join(',')}
                    on={(v) => patch(i, { cross_pages: v.split(',').map((s) => s.trim()).filter(Boolean) })}
                  />
                </Row>
              </>
            ) : d.class.startsWith('power_') ? null : (
              <>
                <Row label="ref"><Input v={d.ref ?? ''} on={(v) => patch(i, { ref: v })} placeholder="M54" /></Row>
                <Row label="gate"><Input v={d.gate ?? ''} on={(v) => patch(i, { gate: v })} placeholder="A" /></Row>
                <Row label="ic"><Input v={d.ic ?? ''} on={(v) => patch(i, { ic: v })} placeholder="00" /></Row>
                <Row label="rot">
                  <select value={d.rotation} onChange={(e) => patch(i, { rotation: Number(e.target.value) })} className="flex-1 bg-bg-accent px-1 py-0.5">
                    <option value={0}>0</option><option value={90}>90</option>
                    <option value={180}>180</option><option value={270}>270</option>
                  </select>
                </Row>
                {(d.pins?.length ?? 0) > 0 && (
                  <div className="text-text-dim">pins: {d.pins!.map((p) => `${p.num}/${p.side}`).join(', ')}</div>
                )}
              </>
            )}
            <div className="flex gap-2 text-text-dim">
              <span>x:</span>
              <input type="number" value={d.x} onChange={(e) => patch(i, { x: Number(e.target.value) })} className="w-20 bg-bg-accent px-1" />
              <span>y:</span>
              <input type="number" value={d.y} onChange={(e) => patch(i, { y: Number(e.target.value) })} className="w-20 bg-bg-accent px-1" />
            </div>
          </div>
        ))}
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={busy || items.length === 0}
            className="flex-1 bg-phosphor-dim px-2 py-1 text-bg-main hover:bg-phosphor disabled:opacity-50"
          >
            {busy ? '...' : 'Wstaw'}
          </button>
          <button type="button" className="px-2 py-1 text-text-dim" onClick={onClose}>Anuluj</button>
        </div>
      </form>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <label className="w-12 text-text-dim">{label}</label>
      {children}
    </div>
  );
}

function Input({ v, on, placeholder }: { v: string; on: (v: string) => void; placeholder?: string }): JSX.Element {
  return (
    <input
      value={v}
      onChange={(e) => on(e.target.value)}
      placeholder={placeholder}
      className="flex-1 bg-bg-accent px-1 py-0.5"
    />
  );
}
