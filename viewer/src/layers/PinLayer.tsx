import { useRef } from 'react';
import { Layer, Circle, Text } from 'react-konva';
import type Konva from 'konva';
import type { Gate } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import { snapPinToEdge } from './box.ts';
import { connectPins, mergeDropsCross, planConnect } from '../netOps.ts';

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

  const pkg = useDocStore((s) => s.pkg);
  // Gates whose component is a jumper: pin numeric labels suppressed (the
  // pad letter is rendered by JumperShape instead).
  const isJumperGate = (g: Gate): boolean => {
    const c = pkg?.components[g.ref];
    return !!c && c.ic === null && c.type === 'jumper';
  };
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
    // Two pins → both on one net (a's, else b's, else a fresh NET_<b>) + a
    // segment a→b. Only these two pins change net; rules live in netOps.
    const a = gates[armedPin.g]?.pins[armedPin.p];
    const gb = gates[gi];
    const b = gb?.pins[pi];
    if (!a || !gb || !b) {
      setSelection(null);
      return;
    }
    const fallback = `NET_${gb.ref}${gb.gate ? `_${gb.gate}` : ''}_${b.num}`;
    const pa = { gateIdx: armedPin.g, pinIdx: armedPin.p };
    const pb = { gateIdx: gi, pinIdx: pi };
    const cur = useDocStore.getState().page;
    if (!cur) return;
    const plan = planConnect(cur, pa, pb, fallback);
    if (plan.status === 'missing') {
      setSelection(null);
      return;
    }
    if (plan.status === 'noop') {
      setSelection({ kind: 'net', name: plan.net });
      return;
    }
    if (plan.status === 'merge') {
      const dropped = mergeDropsCross(cur, plan.from, plan.into);
      const ok = window.confirm(
        `Połączyć net „${plan.from}” z „${plan.into}”?\n` +
        `Wszystkie końcówki i segmenty „${plan.from}” przejdą do „${plan.into}”.` +
        (dropped ? `\nUwaga: cross „${plan.from}” (→ ${dropped.page} ${dropped.label}) zostanie usunięty, zostaje cross „${plan.into}”.` : ''),
      );
      if (!ok) {
        setSelection(null); // connect cancelled, nothing changed
        return;
      }
    }
    const name = plan.status === 'merge' ? plan.into : plan.net;
    editPage((page) => {
      connectPins(page, pa, pb, fallback, { allowMerge: plan.status === 'merge' });
    });
    setSelection({ kind: 'net', name });
  };

  return (
    <Layer>
      {gates.flatMap((g, gi) =>
        g.pins.map((p, pi) => {
          if (p.disconnected) return null;
          const armed = armedPin && armedPin.g === gi && armedPin.p === pi;
          const active = activeNets.has(p.net) || gi === selectedGateIdx;
          const orphan = isOrphan(p.net);
          const jumper = isJumperGate(g);
          const strokeColor = armed || active ? '#39ff14' : orphan ? '#ff3030' : jumper ? '#FFC107' : undefined;
          const strokeW = jumper ? 2 : armed ? 2 : active ? 1.5 : orphan ? 2.5 : 0;
          return (
            <Circle
              key={`${gi}-${pi}-d`}
              x={p.px}
              y={p.py}
              radius={armed ? 10 : active ? 8 : orphan ? 8 : 6}
              fill={jumper ? 'rgba(13,17,23,0.7)' : armed ? '#2196F3' : active ? '#FF9800' : '#39ff14'}
              stroke={strokeColor}
              strokeWidth={strokeW}
              draggable={editing && !jumper}
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
          if (p.disconnected) return null;
          if (isJumperGate(g)) return null;
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
