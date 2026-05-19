import { useRef } from 'react';
import { Layer, Circle, Text } from 'react-konva';
import type Konva from 'konva';
import type { Gate } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import { snapPinToEdge } from './box.ts';

interface Props {
  gates: Gate[];
}

export function PinLayer({ gates }: Props): JSX.Element {
  const tool = useDocStore((s) => s.tool);
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const editPage = useDocStore((s) => s.editPage);
  const page = useDocStore((s) => s.page);
  const editing = tool === 'edit';

  // Orphan pin = pin.net is empty OR its net has <2 total endpoints.
  const netUsage = new Map<string, number>();
  if (page) {
    const bump = (n: string | null | undefined) => {
      if (!n || !n.trim()) return;
      netUsage.set(n, (netUsage.get(n) ?? 0) + 1);
    };
    for (const g of page.gates) for (const pin of g.pins) bump(pin.net);
    for (const port of page.ports ?? []) bump(port.net);
    for (const cr of page.cross_refs ?? []) bump(cr.net);
  }
  const isOrphan = (netName: string | null | undefined): boolean => {
    if (!netName || !netName.trim()) return true;
    return (netUsage.get(netName) ?? 0) < 2;
  };
  const dragOrigRef = useRef<{ px: number; py: number } | null>(null);
  const armedPin =
    selection?.kind === 'pin' ? { g: selection.gateIdx, p: selection.pinIdx } : null;

  // Highlight rules:
  //   gate selection  → only that gate's own pins glow (avoids fanout spam)
  //   net / segment   → all pins on that named net glow
  // Empty/whitespace net names are ignored.
  const activeNets = new Set<string>();
  const addNet = (n: string | null | undefined): void => {
    if (n && n.trim()) activeNets.add(n);
  };
  if (selection?.kind === 'net') addNet(selection.name);
  else if (selection?.kind === 'segment') addNet(selection.netName);
  const selectedGateIdx = selection?.kind === 'gate' ? selection.idx : -1;

  const onPinClick = (gi: number, pi: number) => {
    if (tool === 'wire') {
      const g = gates[gi];
      const pin = g?.pins[pi];
      if (!pin) return;
      const autoNet = `NET_${g!.ref}${g!.gate ? `_${g!.gate}` : ''}_${pin.num}`;
      window.dispatchEvent(new CustomEvent('kronikarz:wire-endpoint-click', {
        detail: { x: pin.px, y: pin.py, netName: pin.net, autoNet },
      }));
      return;
    }
    if (!editing) {
      setSelection({ kind: 'gate', idx: gi });
      return;
    }
    if (!armedPin) {
      setSelection({ kind: 'pin', gateIdx: gi, pinIdx: pi });
      return;
    }
    if (armedPin.g === gi && armedPin.p === pi) {
      setSelection(null);
      return;
    }
    // Two pins → create a segment in the first pin's net + ensure both share net name
    const a = gates[armedPin.g]?.pins[armedPin.p];
    const b = gates[gi]?.pins[pi];
    if (!a || !b) {
      setSelection(null);
      return;
    }
    const netA = a.net;
    const netB = b.net;
    editPage((page) => {
      // Unify nets: rename netB → netA on the target pin (only that pin),
      // or merge entire net if names already match.
      const targetGate = page.gates[gi];
      const targetPin = targetGate?.pins[pi];
      if (targetPin) targetPin.net = netA;

      // Move pin reference in nets map if needed
      const netRecord = page.nets[netA] ?? { pins: [], segments: null, junctions: null };
      const pidB = `${gates[gi]!.ref}${gates[gi]!.gate ? `.${gates[gi]!.gate}` : ''}.${b.num}`;
      if (!netRecord.pins.includes(pidB)) netRecord.pins.push(pidB);
      page.nets[netA] = netRecord;

      // Remove pin from old netB
      if (netB && netB !== netA && page.nets[netB]) {
        const oldNet = page.nets[netB]!;
        oldNet.pins = oldNet.pins.filter((p) => p !== pidB);
        if (oldNet.pins.length === 0) delete page.nets[netB];
      }

      // Append segment
      const segments = netRecord.segments ?? [];
      segments.push([a.px, a.py, b.px, b.py]);
      netRecord.segments = segments;
    });
    setSelection({ kind: 'net', name: netA });
  };

  return (
    <Layer>
      {gates.flatMap((g, gi) =>
        g.pins.map((p, pi) => {
          const armed = armedPin && armedPin.g === gi && armedPin.p === pi;
          const active = activeNets.has(p.net) || gi === selectedGateIdx;
          const orphan = isOrphan(p.net);
          const strokeColor = armed || active ? '#39ff14' : orphan ? '#ff3030' : undefined;
          const strokeW = armed ? 2 : active ? 1.5 : orphan ? 2.5 : 0;
          return (
            <Circle
              key={`${gi}-${pi}-d`}
              x={p.px}
              y={p.py}
              radius={armed ? 10 : active ? 8 : orphan ? 8 : 6}
              fill={armed ? '#2196F3' : active ? '#FF9800' : '#39ff14'}
              stroke={strokeColor}
              strokeWidth={strokeW}
              draggable={editing}
              dragBoundFunc={function (this: Konva.Node, absPos) {
                const stage = this.getStage();
                if (!stage) return absPos;
                const sx = stage.x();
                const sy = stage.y();
                const sc = stage.scaleX();
                const scanX = (absPos.x - sx) / sc;
                const scanY = (absPos.y - sy) / sc;
                const gate = gates[gi]!;
                const snap = snapPinToEdge(gate, scanX, scanY);
                return {
                  x: snap.px * sc + sx,
                  y: snap.py * sc + sy,
                };
              }}
              onDragStart={(e) => {
                e.cancelBubble = true;
                dragOrigRef.current = { px: p.px, py: p.py };
              }}
              onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => {
                e.cancelBubble = true;
                const node = e.target;
                const scanX = node.x();
                const scanY = node.y();
                const gate = gates[gi]!;
                const snap = snapPinToEdge(gate, scanX, scanY);
                const orig = dragOrigRef.current;
                dragOrigRef.current = null;
                if (!orig) return;
                if (orig.px === snap.px && orig.py === snap.py) return;
                editPage((page) => {
                  const tg = page.gates[gi];
                  const tp = tg?.pins[pi];
                  if (!tp) return;
                  tp.px = snap.px;
                  tp.py = snap.py;
                  tp.side = snap.side;
                  // Translate matching net segment endpoints + junctions
                  for (const net of Object.values(page.nets)) {
                    if (net.segments) {
                      for (const seg of net.segments) {
                        for (let endi = 0; endi < 2; endi++) {
                          if (seg[endi * 2] === orig.px && seg[endi * 2 + 1] === orig.py) {
                            seg[endi * 2] = snap.px;
                            seg[endi * 2 + 1] = snap.py;
                          }
                        }
                      }
                    }
                    if (net.junctions) {
                      for (const j of net.junctions) {
                        if (j[0] === orig.px && j[1] === orig.py) {
                          j[0] = snap.px;
                          j[1] = snap.py;
                        }
                      }
                    }
                  }
                });
              }}
              onClick={(e) => {
                e.cancelBubble = true;
                onPinClick(gi, pi);
              }}
              onTap={() => onPinClick(gi, pi)}
            />
          );
        }),
      )}
      {gates.flatMap((g, gi) =>
        g.pins.map((p, pi) => {
          // Above the pin AND offset to the outside, so horizontal wires
          // can enter the pin without crossing the number.
          const labelText = String(p.num);
          const labelW = Math.max(12, labelText.length * 12);
          let dx = 0;
          let dy = -22;
          if (p.side === 'left') dx = -labelW - 6;
          else if (p.side === 'right') dx = 12;
          else if (p.side === 'bottom') dy = 12;
          return (
            <Text
              key={`label-${gi}-${pi}`}
              x={p.px + dx}
              y={p.py + dy}
              text={String(p.num)}
              fontSize={20}
              fontFamily="IBM Plex Mono"
              fill="#FFC107"
              fontStyle="bold"
              listening={false}
            />
          );
        }),
      )}
    </Layer>
  );
}
