import { useEffect, useRef, useState } from 'react';
import { Layer, Line, Circle } from 'react-konva';
import type Konva from 'konva';
import type { Page, Gate, Port } from '@kronikarz/shared';
import { autoJunctionMask, autoSegmentMask } from '@kronikarz/shared';
import { canEditElement, issueRelevant } from '../stepView.ts';
import { useStepView } from './stepLook.ts';
import { isLocked, useDocStore } from '../store.ts';
import { withNetPointMoved, type NetPoint } from '../netOps.ts';
import { combineWireSel, movePointTo, planMerge, snapPoint, snapRadius, targetNets, wireSelHas } from '../wireEdit.ts';
import { askMerge, noteMerge, useWireUi } from '../useWireEditing.tsx';
import { createPointDragSession, type PointDrag, type PointDragSession } from '../netPointDrag.ts';
import { useEvent } from '../useEvent.ts';
import { gateBox } from './box.ts';

// Push a point out of any gate body it lands on. Operates in scan coords.
function pushOutOfGates(x: number, y: number, gates: Gate[], margin = 10): { x: number; y: number } {
  let nx = x;
  let ny = y;
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (const g of gates) {
      const { w, h } = gateBox(g);
      // Transform point into gate local frame (handles rotation)
      const rad = (g.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const dx = nx - g.x;
      const dy = ny - g.y;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      const halfW = w / 2 + margin;
      const halfH = h / 2 + margin;
      if (lx > -halfW && lx < halfW && ly > -halfH && ly < halfH) {
        // Inside (with margin). Push along axis of smallest exit distance.
        const dL = lx + halfW;
        const dR = halfW - lx;
        const dT = ly + halfH;
        const dB = halfH - ly;
        const m = Math.min(dL, dR, dT, dB);
        let nlx = lx;
        let nly = ly;
        if (m === dL) nlx = -halfW;
        else if (m === dR) nlx = halfW;
        else if (m === dT) nly = -halfH;
        else nly = halfH;
        // Rotate back
        nx = g.x + nlx * cos - nly * sin;
        ny = g.y + nlx * sin + nly * cos;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x: Math.round(nx), y: Math.round(ny) };
}

// Where the wire attaches to a port (opposite end from the chevron tip).
// Mirrors geometry in PortLayer.
function portOpenEnd(p: Port): { x: number; y: number } {
  const labelWidth = Math.max(60, `${p.connector}${p.pin}`.length * 16 + 12);
  const bw = labelWidth + 16;
  const rot =
    p.side === 'left' ? 0 :
    p.side === 'right' ? 180 :
    p.side === 'top' ? 90 :
    270;
  const rad = (rot * Math.PI) / 180;
  return { x: p.x + bw * Math.cos(rad), y: p.y + bw * Math.sin(rad) };
}

const COLOR_NET = '#39ff14';
const COLOR_ACTIVE = '#FF9800';
const COLOR_DASH = '#39ff14cc';

interface Props {
  page: Page;
  zoom: number;
}

function highlightedNets(_page: Page, selection: ReturnType<typeof useDocStore.getState>['selection']): Set<string> {
  const out = new Set<string>();
  const add = (n: string | null | undefined): void => {
    if (n && n.trim()) out.add(n);
  };
  if (!selection) return out;
  if (selection.kind === 'net') add(selection.name);
  else if (selection.kind === 'segment') add(selection.netName);
  // gate selection no longer expands to all its nets — click a net to see fanout
  return out;
}

export function NetLayer({ page, zoom }: Props): JSX.Element {
  const selection = useDocStore((s) => s.selection);
  const setSelection = useDocStore((s) => s.setSelection);
  const tool = useDocStore((s) => s.tool);
  const editPage = useDocStore((s) => s.editPage);
  const wireSel = useDocStore((s) => s.wireSel);
  const active = highlightedNets(page, selection);
  const flash = useWireUi((s) => s.flash); // ~1 s after a merge (useWireEditing.noteMerge)
  if (flash) active.add(flash);
  const w = 2.2 / zoom;
  const wActive = 4 / zoom;
  // Geometria drutów (przeciąganie, podział, kropki) tylko w ③ / bez kroku; w ④⑤ do odczytu.
  const curStep = useDocStore((s) => s.currentStep);
  const editing = tool === 'edit' && canEditElement(curStep, 'segment', 'geom');
  const issues = useDocStore((s) => s.issues);
  // Bieżący krok: druty to ③ (kolor pochodzenia z auto_segments); czerwone
  // „złe nety” (kody kroku ⑤) tylko bez kroku i w ⑤.
  const step = useDocStore((s) => s.currentStep);
  const sv = useStepView();
  const look = sv.look('wire');
  const badNets = new Set<string>();
  for (const it of issues) {
    if (it.level === 'err' && issueRelevant(it, step) && (
      it.code === 'NET_DISCONNECTED' ||
      it.code === 'NET_ORPHAN_ENDPOINT' ||
      it.code === 'NET_FLOATING' ||
      it.code === 'ENDPOINT_NET_MISMATCH'
    )) {
      if (it.ref) badNets.add(it.ref);
    }
  }

  // Drag of a net point (segment-end handle, auto-junction dot): every
  // endpoint/junction of that net at the drag-start point moves with it (so a
  // junction does not fall apart). While dragging only `pointDrag` changes —
  // the page is rendered with the preview (withNetPointMoved), the store is
  // not touched (no undo entry, auto-save or validation per mouse move). The
  // drag end commits one editPage = one undo step (netPointDrag.ts).
  // onDragMove/onDragEnd must keep one identity across renders: react-konva
  // off()s a changed handler BEFORE setAttrs, so when `draggable` flips
  // (tool leaves edit mid-drag) Konva's stopDrag would fire dragend with no
  // listener and the preview would stick. Hence the session lives in a ref
  // and the handlers are useEvent callbacks.
  const [pointDrag, setPointDrag] = useState<PointDrag | null>(null);
  const sessionRef = useRef<PointDragSession | null>(null);
  // The end snaps like a W wire end (pin / port open end / wire end / inside a
  // wire = T with a dot); joining another net follows planMerge (+ prompt).
  sessionRef.current ??= createPointDragSession({
    preview: setPointDrag,
    commit: (netName, from, to) => {
      const st = useDocStore.getState();
      if (!st.page || isLocked(st)) return;
      const t = snapPoint(st.page, to, snapRadius(st.zoom), { net: netName, at: from });
      const end = t ? { x: t.x, y: t.y } : to;
      if (end.x === from.x && end.y === from.y) return;
      const before = st.page;
      const plan = planMerge(before, [netName, ...targetNets(before, t)]);
      const res = askMerge(before, plan, netName);
      if (!res) return;
      st.editPage((p) => movePointTo(p, netName, from, end, t, res.into, res.from));
      noteMerge(before, plan, res, end);
    },
  });
  const session = sessionRef.current;
  const dragPos = (e: Konva.KonvaEventObject<DragEvent>): NetPoint => ({
    x: Math.round(e.target.x()),
    y: Math.round(e.target.y()),
  });

  const onPointDragStart = (netName: string, x: number, y: number): void => {
    session.start(netName, { x, y });
  };
  // Preview shows where the end will snap (the commit snaps the same way).
  const snapDrag = (pt: NetPoint): NetPoint => {
    const cur = session.current();
    const pg = useDocStore.getState().page;
    const t = cur && pg ? snapPoint(pg, pt, snapRadius(zoom), { net: cur.net, at: cur.from }) : null;
    return t ? { x: t.x, y: t.y } : pt;
  };
  const onPointDragMove = useEvent((e: Konva.KonvaEventObject<DragEvent>): void => {
    session.move(snapDrag(dragPos(e)));
  });
  const onPointDragEnd = useEvent((e: Konva.KonvaEventObject<DragEvent>): void => {
    session.end(dragPos(e));
  });

  // Tool left edit mode during a drag: finish it at the last previewed point
  // (commit if it moved), even if Konva's dragend never reaches us.
  useEffect(() => {
    if (!editing) session.end();
  }, [editing, session]);

  // Build full net set: declared in page.nets + any net referenced by pins/ports/refs.
  // Skip empty/whitespace names — those represent un-routed pins, not a real net.
  const allNetNames = new Set<string>(Object.keys(page.nets).filter((n) => n.trim()));
  for (const g of page.gates) for (const p of g.pins) if (p.net && p.net.trim()) allNetNames.add(p.net);
  for (const port of page.ports ?? []) if (port.net && port.net.trim()) allNetNames.add(port.net);
  for (const cr of page.cross_refs ?? []) if (cr.net && cr.net.trim()) allNetNames.add(cr.net);

  return (
    <Layer visible={look.visible} opacity={look.opacity} listening={look.listening}>
      {Array.from(allNetNames).map((name) => {
        const storedNet = page.nets[name] ?? { pins: [], segments: null, junctions: null };
        const net = pointDrag && pointDrag.net === name
          ? withNetPointMoved(storedNet, pointDrag.from, pointDrag.to)
          : storedNet;
        const isActive = active.has(name);
        const isBad = badNets.has(name);
        const color = isBad ? '#ff3838' : isActive ? COLOR_ACTIVE : COLOR_NET;
        const selectedSegment =
          selection?.kind === 'segment' && selection.netName === name ? selection.segmentIdx : -1;

        const segments = net.segments ?? [];
        const dashed = net.segments === null;
        const segAuto = autoSegmentMask(net);
        const juncAuto = autoJunctionMask(net);
        const segColor = (si: number): string =>
          isBad || isActive ? color : sv.prov('wire', segAuto[si] ? 'auto' : 'edited') ?? color;
        const juncColor = (ji: number): string =>
          isBad || isActive ? color : sv.prov('wire', juncAuto[ji] ? 'auto' : 'edited') ?? color;

        // Dashed placeholders connecting all endpoints touching this net.
        // We scan every gate pin's `.net` field directly (source of truth)
        // rather than relying on `net.pins[]` which may be out of sync.
        const placeholders: Array<[number, number, number, number]> = [];
        if (dashed) {
          const endpoints: Array<{ x: number; y: number }> = [];
          const seen = new Set<string>();
          const addPt = (x: number, y: number): void => {
            const key = `${x},${y}`;
            if (seen.has(key)) return;
            seen.add(key);
            endpoints.push({ x, y });
          };
          for (const g of page.gates) {
            for (const p of g.pins) {
              if (p.net === name) addPt(p.px, p.py);
            }
          }
          for (const port of page.ports ?? []) {
            if (port.net === name) {
              const oe = portOpenEnd(port);
              addPt(oe.x, oe.y);
            }
          }
          for (const cr of page.cross_refs ?? []) {
            if (cr.net === name) addPt(cr.x, cr.y);
          }
          // Orphan ports / cross_refs: net only touches an edge endpoint, no
          // gate pin consumes it on this page. Render a short stub pointing
          // into the page interior so the user sees a dangling net.
          if (endpoints.length < 2) {
            const STUB = 40;
            for (const port of page.ports ?? []) {
              if (port.net !== name) continue;
              const oe = portOpenEnd(port);
              // stub points INTO the page from the open end (= away from chevron tip)
              const dx = port.side === 'left' ? STUB : port.side === 'right' ? -STUB : 0;
              const dy = port.side === 'top' ? STUB : port.side === 'bottom' ? -STUB : 0;
              placeholders.push([oe.x, oe.y, oe.x + dx, oe.y + dy]);
            }
            for (const cr of page.cross_refs ?? []) {
              if (cr.net !== name) continue;
              const dx = cr.side === 'left' ? STUB : cr.side === 'right' ? -STUB : 0;
              const dy = cr.side === 'top' ? STUB : cr.side === 'bottom' ? -STUB : 0;
              placeholders.push([cr.x, cr.y, cr.x + dx, cr.y + dy]);
            }
          }
          // Connect to a centroid for a clean star topology when 3+ endpoints
          if (endpoints.length === 2) {
            const a = endpoints[0]!;
            const b = endpoints[1]!;
            placeholders.push([a.x, a.y, b.x, b.y]);
          } else if (endpoints.length >= 3) {
            const cx0 = endpoints.reduce((s, p) => s + p.x, 0) / endpoints.length;
            const cy0 = endpoints.reduce((s, p) => s + p.y, 0) / endpoints.length;
            const c = pushOutOfGates(cx0, cy0, page.gates);
            for (const p of endpoints) {
              placeholders.push([p.x, p.y, c.x, c.y]);
            }
          }
        }

        // Auto-junctions: any point where 3+ segment endpoints (real OR
        // placeholder) of THIS net meet → render a filled dot so the user
        // can tell a connection from a mere crossing.
        const autoJunctions: Array<[number, number]> = [];
        {
          const count = new Map<string, { x: number; y: number; n: number }>();
          const bump = (x: number, y: number): void => {
            const k = `${x},${y}`;
            const e = count.get(k);
            if (e) e.n += 1;
            else count.set(k, { x, y, n: 1 });
          };
          for (const s of segments) { bump(s[0], s[1]); bump(s[2], s[3]); }
          for (const s of placeholders) { bump(s[0], s[1]); bump(s[2], s[3]); }
          for (const e of count.values()) {
            if (e.n >= 3) autoJunctions.push([e.x, e.y]);
          }
        }

        return (
          <>
            {segments.map((s, si) => {
              const inWireSel = wireSelHas(wireSel, name, s);
              const selected = selectedSegment === si || inWireSel;
              // W trybie view: nawet zaznaczony segment renderujemy jak caly net
              // (zeby widziec spojnosc geometrii). Niebieski tylko w edit i w zaznaczeniu drutów.
              const showAsSelected = (selected && editing) || inWireSel;
              const segActive = selected || isActive;
              return (
                <Line
                  key={`${name}-s-${si}`}
                  points={[s[0], s[1], s[2], s[3]]}
                  stroke={showAsSelected ? '#2196F3' : (segActive ? COLOR_ACTIVE : segColor(si))}
                  strokeWidth={selected ? wActive * 1.5 : segActive ? wActive : w}
                  dash={selected ? [12 / zoom, 6 / zoom] : undefined}
                  hitStrokeWidth={Math.max(8, w * 4)}
                  onClick={(e) => {
                    e.cancelBubble = true;
                    if (tool === 'wire') return; // W: płótno (useWireEditing)
                    // Shift+klik = dodaj / zdejmij drut z zaznaczenia drutów (Delete usuwa wszystkie).
                    if (e.evt.shiftKey && canEditElement(curStep, 'segment', 'geom')) {
                      const st = useDocStore.getState();
                      st.setWireSel(combineWireSel(st.wireSel, { segs: [{ net: name, seg: [...s] }], juncs: [] }, true));
                      return;
                    }
                    // Alt+klik w trybie edit = split segmentu w miejscu kliku (projekcja na linie)
                    if (editing && e.evt.altKey) {
                      const stage = e.target.getStage();
                      if (!stage) return;
                      const ptr = stage.getPointerPosition();
                      if (!ptr) return;
                      const sx = stage.x();
                      const sy = stage.y();
                      const sc = stage.scaleX();
                      let px = Math.round((ptr.x - sx) / sc);
                      let py = Math.round((ptr.y - sy) / sc);
                      // Projekcja na segment
                      const ddx = s[2] - s[0];
                      const ddy = s[3] - s[1];
                      const len2 = ddx * ddx + ddy * ddy;
                      if (len2 > 0) {
                        let t = ((px - s[0]) * ddx + (py - s[1]) * ddy) / len2;
                        t = Math.max(0, Math.min(1, t));
                        px = Math.round(s[0] + t * ddx);
                        py = Math.round(s[1] + t * ddy);
                      }
                      editPage((p) => {
                        const segs = p.nets[name]?.segments;
                        if (!segs) return;
                        const cur = segs[si];
                        if (!cur) return;
                        segs.splice(si, 1, [cur[0], cur[1], px, py], [px, py, cur[2], cur[3]]);
                        // Dodaj kropke junction (manual)
                        const net = p.nets[name];
                        if (net) {
                          net.junctions ??= [];
                          if (!net.junctions.some((j) => j[0] === px && j[1] === py)) net.junctions.push([px, py]);
                        }
                      });
                      return;
                    }
                    setSelection({ kind: 'segment', netName: name, segmentIdx: si });
                  }}
                />
              );
            })}
            {placeholders.map((s, i) => (
              <Line
                key={`${name}-p-${i}`}
                points={[s[0], s[1], s[2], s[3]]}
                stroke={isActive ? color : COLOR_DASH}
                strokeWidth={isActive ? wActive : w}
                dash={[6, 4]}
                hitStrokeWidth={Math.max(8, w * 4)}
                onClick={(e) => {
                  e.cancelBubble = true;
                  if (tool === 'wire') return;
                  setSelection({ kind: 'net', name });
                }}
              />
            ))}
            {(() => {
              // Dedup: jezeli ten sam punkt jest tez w net.junctions, pomin auto.
              const manualSet = new Set((net.junctions ?? []).map((j) => `${j[0]},${j[1]}`));
              return autoJunctions
                .filter((j) => !manualSet.has(`${j[0]},${j[1]}`))
                .map((j, ji) => (
                  <Circle
                    key={`${name}-aj-${ji}`}
                    x={j[0]}
                    y={j[1]}
                    radius={Math.max(4, 5 / zoom)}
                    fill={color}
                    draggable={editing}
                    onDragStart={() => onPointDragStart(name, j[0], j[1])}
                    onDragMove={onPointDragMove}
                    onDragEnd={onPointDragEnd}
                    onClick={(e) => {
                      e.cancelBubble = true;
                      if (tool === 'wire') return;
                      setSelection({ kind: 'net', name });
                    }}
                  />
                ));
            })()}
            {(net.junctions ?? []).map((j, ji) => {
              // Znajdź segment na ktorym lezy junction (najblizszy).
              // Przy drag ograniczamy ruch do tego segmentu (projekcja na linie).
              let nearestSeg = -1;
              let nearestD = Infinity;
              for (let i = 0; i < segments.length; i++) {
                const s = segments[i]!;
                const dx = s[2] - s[0];
                const dy = s[3] - s[1];
                const len2 = dx * dx + dy * dy;
                if (len2 === 0) continue;
                let t = ((j[0] - s[0]) * dx + (j[1] - s[1]) * dy) / len2;
                t = Math.max(0, Math.min(1, t));
                const px = s[0] + t * dx;
                const py = s[1] + t * dy;
                const d = (px - j[0]) ** 2 + (py - j[1]) ** 2;
                if (d < nearestD) { nearestD = d; nearestSeg = i; }
              }
              return (
                <Circle
                  key={`${name}-j-${ji}`}
                  x={j[0]}
                  y={j[1]}
                  radius={4}
                  fill={juncColor(ji)}
                  stroke={wireSel?.juncs.some((w) => w.net === name && w.x === j[0] && w.y === j[1]) ? '#2196F3' : undefined}
                  strokeWidth={3 / zoom}
                  draggable={editing && nearestSeg >= 0}
                  dragBoundFunc={function (this: Konva.Node, absPos) {
                    const stage = this.getStage();
                    if (!stage || nearestSeg < 0) return absPos;
                    const sx = stage.x();
                    const sy = stage.y();
                    const sc = stage.scaleX();
                    const scanX = (absPos.x - sx) / sc;
                    const scanY = (absPos.y - sy) / sc;
                    const s = segments[nearestSeg]!;
                    const dx = s[2] - s[0];
                    const dy = s[3] - s[1];
                    const len2 = dx * dx + dy * dy;
                    let t = len2 === 0 ? 0 : ((scanX - s[0]) * dx + (scanY - s[1]) * dy) / len2;
                    t = Math.max(0, Math.min(1, t));
                    const px = s[0] + t * dx;
                    const py = s[1] + t * dy;
                    return { x: px * sc + sx, y: py * sc + sy };
                  }}
                  onDragEnd={(e) => {
                    e.cancelBubble = true;
                    const nx = Math.round(e.target.x());
                    const ny = Math.round(e.target.y());
                    editPage((p) => {
                      const js = p.nets[name]?.junctions;
                      if (js && js[ji]) { js[ji]![0] = nx; js[ji]![1] = ny; }
                    });
                  }}
                  onClick={(e) => {
                    e.cancelBubble = true;
                    if (tool === 'wire') return;
                    if (editing) {
                      editPage((p) => {
                        const js = p.nets[name]?.junctions;
                        if (js) js.splice(ji, 1);
                      });
                    } else {
                      setSelection({ kind: 'net', name });
                    }
                  }}
                />
              );
            })}
            {/* Drag handles only for the SELECTED segment (avoid handle spam) */}
            {editing && selectedSegment >= 0 && segments[selectedSegment] &&
              [0, 1].map((endIdx) => {
                const s = segments[selectedSegment]!;
                return (
                  <Circle
                    key={`${name}-h-${selectedSegment}-${endIdx}`}
                    x={s[endIdx * 2]!}
                    y={s[endIdx * 2 + 1]!}
                    radius={6 / zoom + 2}
                    fill="#2196F3"
                    stroke="#39ff14"
                    strokeWidth={1 / zoom}
                    draggable
                    onDragStart={() => onPointDragStart(name, s[endIdx * 2]!, s[endIdx * 2 + 1]!)}
                    onDragMove={onPointDragMove}
                    onDragEnd={onPointDragEnd}
                    onClick={(e) => {
                      e.cancelBubble = true;
                      setSelection({ kind: 'segment', netName: name, segmentIdx: selectedSegment });
                    }}
                  />
                );
              })}
          </>
        );
      })}
    </Layer>
  );
}
