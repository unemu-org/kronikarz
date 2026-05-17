import { Layer, Circle, Text } from 'react-konva';
import type { Gate } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';

interface Props {
  gates: Gate[];
}

export function PinLayer({ gates }: Props): JSX.Element {
  const tool = useDocStore((s) => s.tool);
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const editPage = useDocStore((s) => s.editPage);
  const editing = tool === 'edit';
  const armedPin =
    selection?.kind === 'pin' ? { g: selection.gateIdx, p: selection.pinIdx } : null;

  const onPinClick = (gi: number, pi: number) => {
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
          return (
            <Circle
              key={`${gi}-${pi}-d`}
              x={p.px}
              y={p.py}
              radius={armed ? 9 : 6}
              fill={armed ? '#2196F3' : '#39ff14'}
              stroke={armed ? '#39ff14' : undefined}
              strokeWidth={armed ? 2 : 0}
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
          let dx = 0;
          let dy = -24;
          if (p.side === 'left') {
            dx = -34;
            dy = -10;
          } else if (p.side === 'right') {
            dx = 10;
            dy = -10;
          } else if (p.side === 'bottom') {
            dy = 8;
          }
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
