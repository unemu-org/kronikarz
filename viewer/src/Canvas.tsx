import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Rect, Group, Text, Line } from 'react-konva';
import type Konva from 'konva';
import { useDocStore, runRewrite, postRewrite, pageFilePath, type VisionZone, type ZoneRole } from './store.ts';
import { apiWrite } from './api.ts';
import { ImageLayer } from './layers/ImageLayer.tsx';
import { GateLayer } from './layers/GateLayer.tsx';
import { PinLayer } from './layers/PinLayer.tsx';
import { NetLayer } from './layers/NetLayer.tsx';
import { PowerLayer } from './layers/PowerLayer.tsx';
import { CrossPageLayer } from './layers/CrossPageLayer.tsx';
import { PortLayer } from './layers/PortLayer.tsx';
import { CrossRefLayer } from './layers/CrossRefLayer.tsx';
import { AddGateDialog } from './AddGateDialog.tsx';
import { AddCrossRefDialog } from './AddCrossRefDialog.tsx';
import { AddPortDialog } from './AddPortDialog.tsx';
import { AddAnnotationDialog } from './AddAnnotationDialog.tsx';
import { AnnotationLayer } from './layers/AnnotationLayer.tsx';
import { DecorationLayer } from './layers/DecorationLayer.tsx';
import type { Decoration } from '@kronikarz/shared';
import { AIDetectDialog, type AiDetection, type RoiRect } from './AIDetectDialog.tsx';

export function Canvas(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [addAt, setAddAt] = useState<{ x: number; y: number } | null>(null);
  const [addXrefAt, setAddXrefAt] = useState<{ x: number; y: number } | null>(null);
  const [addPortAt, setAddPortAt] = useState<{ x: number; y: number } | null>(null);
  const [addAnnAt, setAddAnnAt] = useState<{ x: number; y: number } | null>(null);
  const [placingGate, setPlacingGate] = useState(false);
  const [placingXref, setPlacingXref] = useState(false);
  const [placingPort, setPlacingPort] = useState(false);
  const [placingAnn, setPlacingAnn] = useState(false);
  const [placingDeco, setPlacingDeco] = useState<null | 'line' | 'rect' | 'ellipse'>(null);
  const [placingPower, setPlacingPower] = useState<null | string>(null);
  const selectDragRef = useRef<{ x0: number; y0: number } | null>(null);
  const [selectRect, setSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const setMulti = useDocStore((s) => s.setMulti);
  const decoDragRef = useRef<{ x0: number; y0: number } | null>(null);
  const [decoDraft, setDecoDraft] = useState<Decoration | null>(null);
  const middlePanRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number } | null>(null);
  const [middlePanning, setMiddlePanning] = useState(false);
  const ctrlDragRef = useRef<{
    mode: 'pan' | 'zoom';
    startX: number;
    startY: number;
    viewX: number;
    viewY: number;
    scale: number;
  } | null>(null);
  const [ctrlDragging, setCtrlDragging] = useState<null | 'pan' | 'zoom'>(null);
  const roiDragRef = useRef<{ x0: number; y0: number } | null>(null);
  const [roiRect, setRoiRect] = useState<RoiRect | null>(null);
  const [roiResult, setRoiResult] = useState<{ roi: RoiRect; detections: AiDetection[] } | null>(null);
  const [roiBusy, setRoiBusy] = useState(false);
  const [zones, setZones] = useState<VisionZone[]>([]);
  const [zoneSelected, setZoneSelected] = useState<number>(-1);
  const zoneDragRef = useRef<{ x0: number; y0: number } | null>(null);
  const [zoneDraft, setZoneDraft] = useState<VisionZone | null>(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const zonesLoadedRef = useRef<string>('');
  const zonesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wireDraft, setWireDraft] = useState<{
    netName: string;
    startX: number;
    startY: number;
    vertices: Array<{ x: number; y: number }>;
  } | null>(null);
  const [wireCursor, setWireCursor] = useState<{ x: number; y: number } | null>(null);
  const wireOrtho = useDocStore((s) => s.wireOrtho);
  const page = useDocStore((s) => s.page);
  const route = useDocStore((s) => s.route);
  const loading = useDocStore((s) => s.loading);
  const opacity = useDocStore((s) => s.scanOpacity);
  const overlaysVisible = useDocStore((s) => s.overlaysVisible);
  const setOverlaysVisible = useDocStore((s) => s.setOverlaysVisible);
  const setSelection = useDocStore((s) => s.setSelection);
  const setZoom = useDocStore((s) => s.setZoom);
  const setOpacity = useDocStore((s) => s.setScanOpacity);
  const setTool = useDocStore((s) => s.setTool);
  const editPage = useDocStore((s) => s.editPage);
  const editPackage = useDocStore((s) => s.editPackage);
  const pkg = useDocStore((s) => s.pkg);
  const undo = useDocStore((s) => s.undo);
  const redo = useDocStore((s) => s.redo);
  const selection = useDocStore((s) => s.selection);
  const tool = useDocStore((s) => s.tool);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Middle-mouse-button drag pan (raw DOM, Konva draggable handles only left)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      middlePanRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        viewX: view.x,
        viewY: view.y,
      };
      setMiddlePanning(true);
    };
    const onMove = (e: MouseEvent) => {
      const s = middlePanRef.current;
      if (!s) return;
      setView({
        x: s.viewX + (e.clientX - s.startX),
        y: s.viewY + (e.clientY - s.startY),
        scale: view.scale,
      });
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 1) return;
      middlePanRef.current = null;
      setMiddlePanning(false);
    };
    const onAux = (e: MouseEvent) => {
      // Prevent default middle-click scroll/clipboard
      if (e.button === 1) e.preventDefault();
    };
    // Ctrl + left drag → pan; Ctrl + right drag → zoom (drag up = zoom in)
    const onCtrlDown = (e: MouseEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      const mode: 'pan' | 'zoom' = e.button === 2 ? 'zoom' : 'pan';
      ctrlDragRef.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        viewX: view.x,
        viewY: view.y,
        scale: view.scale,
      };
      setCtrlDragging(mode);
    };
    const onCtrlMove = (e: MouseEvent) => {
      const s = ctrlDragRef.current;
      if (!s) return;
      if (s.mode === 'pan') {
        setView({
          x: s.viewX + (e.clientX - s.startX),
          y: s.viewY + (e.clientY - s.startY),
          scale: s.scale,
        });
      } else {
        const dy = s.startY - e.clientY; // up = zoom in
        const factor = Math.exp(dy * 0.005);
        const newScale = Math.max(0.05, Math.min(20, s.scale * factor));
        const rect = el.getBoundingClientRect();
        const px = s.startX - rect.left;
        const py = s.startY - rect.top;
        const mx = (px - s.viewX) / s.scale;
        const my = (py - s.viewY) / s.scale;
        setView({
          x: px - mx * newScale,
          y: py - my * newScale,
          scale: newScale,
        });
      }
    };
    const onCtrlUp = () => {
      if (!ctrlDragRef.current) return;
      ctrlDragRef.current = null;
      setCtrlDragging(null);
    };
    const onContextMenu = (e: MouseEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    el.addEventListener('mousedown', onDown);
    el.addEventListener('mousedown', onCtrlDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mousemove', onCtrlMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mouseup', onCtrlUp);
    el.addEventListener('auxclick', onAux);
    el.addEventListener('contextmenu', onContextMenu);
    return () => {
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('mousedown', onCtrlDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousemove', onCtrlMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mouseup', onCtrlUp);
      el.removeEventListener('auxclick', onAux);
      el.removeEventListener('contextmenu', onContextMenu);
    };
  }, [view.x, view.y, view.scale]);

  useEffect(() => {
    setZoom(view.scale);
  }, [view.scale, setZoom]);

  function fitToScreen() {
    if (!page) return;
    const [sw, sh] = page.scan_size;
    const scale = Math.min(size.w / sw, size.h / sh) * 0.95;
    setView({
      x: (size.w - sw * scale) / 2,
      y: (size.h - sh * scale) / 2,
      scale,
    });
  }

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        setSpaceDown(true);
        e.preventDefault();
      }
      if (e.key === '0') fitToScreen();
      if (e.key === '1') setView({ x: 0, y: 0, scale: 1 });
      if (e.key === '2') setView({ x: 0, y: 0, scale: 2 });
      if (e.key === '[') setOpacity(Math.max(0, opacity - 0.1));
      if (e.key === ']') setOpacity(Math.min(1, opacity + 0.1));
      if (e.key === '\\') setOpacity(opacity > 0 ? 0 : 0.7);
      if (e.key === 'Escape') {
        if (placingGate) setPlacingGate(false);
        else if (placingXref) setPlacingXref(false);
        else if (placingPort) setPlacingPort(false);
        else if (placingAnn) setPlacingAnn(false);
        else if (placingDeco) { setPlacingDeco(null); setDecoDraft(null); decoDragRef.current = null; }
        else if (placingPower) setPlacingPower(null);
        else if (wireDraft) { setWireDraft(null); setWireCursor(null); }
        else setSelection(null);
      }
      if (e.key === 'Backspace' && wireDraft && wireDraft.vertices.length > 0) {
        e.preventDefault();
        setWireDraft({ ...wireDraft, vertices: wireDraft.vertices.slice(0, -1) });
      }
      if (e.key === 'c' || e.key === 'C') {
        if (tool === 'edit') setPlacingGate(true);
      }
      if (e.key === 'v' || e.key === 'V') setTool('select');
      if (e.key === 'e' || e.key === 'E') setTool('edit');
      if (e.key === 'r' || e.key === 'R') setTool('roi');
      if (e.key === 'w' || e.key === 'W') setTool('wire');
      if (e.key === 'z' || e.key === 'Z') setTool('zones');
      if (tool === 'zones' && zoneSelected >= 0 && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        setZones((prev) => prev.filter((_, i) => i !== zoneSelected));
        setZoneSelected(-1);
      }
      if (e.key === 'h' || e.key === 'H') setOverlaysVisible(!useDocStore.getState().overlaysVisible);
      if (e.key === 'k' || e.key === 'K') {
        if (selection?.kind === 'gate') {
          const idx = selection.idx;
          editPage((p) => {
            const g = p.gates[idx];
            if (g) g.verified = !g.verified;
          });
        }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (tool === 'edit' && selection?.kind === 'gate') {
          const idx = selection.idx;
          editPage((p) => { p.gates.splice(idx, 1); });
          setSelection(null);
        } else if (tool === 'edit' && selection?.kind === 'segment') {
          const { netName, segmentIdx } = selection;
          editPage((p) => {
            const segs = p.nets[netName]?.segments;
            if (segs) segs.splice(segmentIdx, 1);
          });
          setSelection({ kind: 'net', name: netName });
        } else if (tool === 'edit' && selection?.kind === 'power') {
          const idx = selection.idx;
          editPage((p) => { p.power.splice(idx, 1); });
          setSelection(null);
        } else if (tool === 'edit' && selection?.kind === 'annotation') {
          const idx = selection.idx;
          editPage((p) => { p.annotations?.splice(idx, 1); });
          setSelection(null);
        } else if (tool === 'edit' && selection?.kind === 'decoration') {
          const idx = selection.idx;
          editPage((p) => { p.decorations?.splice(idx, 1); });
          setSelection(null);
        } else if (tool === 'edit' && selection?.kind === 'port') {
          const idx = selection.idx;
          editPage((p) => { p.ports?.splice(idx, 1); });
          setSelection(null);
        } else if (tool === 'edit' && selection?.kind === 'cross_ref') {
          const idx = selection.idx;
          editPage((p) => { p.cross_refs?.splice(idx, 1); });
          setSelection(null);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      // Copy/paste annotation lub decoration (Ctrl+C / Ctrl+V)
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && page) {
        if (selection?.kind === 'annotation') {
          e.preventDefault();
          const a = page.annotations?.[selection.idx];
          if (a) localStorage.setItem('kronikarz:clip', JSON.stringify({ kind: 'annotation', data: a }));
        } else if (selection?.kind === 'decoration') {
          e.preventDefault();
          const d = page.decorations?.[selection.idx];
          if (d) localStorage.setItem('kronikarz:clip', JSON.stringify({ kind: 'decoration', data: d }));
        } else if (selection?.kind === 'gate') {
          e.preventDefault();
          const g = page.gates[selection.idx];
          if (g) localStorage.setItem('kronikarz:clip', JSON.stringify({ kind: 'gate', data: g }));
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && tool === 'edit' && page) {
        const raw = localStorage.getItem('kronikarz:clip');
        if (raw) {
          try {
            const clip = JSON.parse(raw);
            // Mouse position in scan coords for paste-at-cursor
            const stage = stageRef.current;
            const ptr = stage?.getPointerPosition();
            const mouseX = ptr ? Math.round((ptr.x - view.x) / view.scale) : null;
            const mouseY = ptr ? Math.round((ptr.y - view.y) / view.scale) : null;
            let newIdx = -1;
            let newKind: 'annotation' | 'decoration' | 'gate' | null = null;
            editPage((p) => {
              if (clip.kind === 'annotation') {
                const arr = (p.annotations ??= []);
                const a = { ...clip.data };
                if (mouseX !== null && mouseY !== null) { a.x = mouseX; a.y = mouseY; }
                arr.push(a);
                newIdx = arr.length - 1;
                newKind = 'annotation';
              } else if (clip.kind === 'decoration') {
                const arr = (p.decorations ??= []);
                const d = { ...clip.data };
                if (mouseX !== null && mouseY !== null) {
                  if (d.kind === 'line') {
                    const dx = mouseX - (d.x1 + d.x2) / 2;
                    const dy = mouseY - (d.y1 + d.y2) / 2;
                    d.x1 += dx; d.x2 += dx; d.y1 += dy; d.y2 += dy;
                  } else if (d.kind === 'rect') {
                    d.x = mouseX - d.w / 2; d.y = mouseY - d.h / 2;
                  } else if (d.kind === 'ellipse') {
                    d.x = mouseX; d.y = mouseY;
                  }
                }
                arr.push(d);
                newIdx = arr.length - 1;
                newKind = 'decoration';
              } else if (clip.kind === 'gate') {
                const src = clip.data;
                const tx = mouseX !== null ? mouseX : src.x + 60;
                const ty = mouseY !== null ? mouseY : src.y + 60;
                const dx = tx - src.x;
                const dy = ty - src.y;
                // For passives: auto-pick next free ref + clone PassiveComponent
                let newRef: string = src.ref;
                const srcComp = pkg?.components[src.ref];
                if (srcComp && srcComp.ic === null) {
                  newRef = nextFreeRef(pkg, src.ref);
                  editPackage((pp) => {
                    pp.components[newRef] = JSON.parse(JSON.stringify(srcComp));
                    const c = pp.components[newRef];
                    if (c && c.ic === null) {
                      const pid = p.page;
                      if (!c.pages.includes(pid)) c.pages.push(pid);
                    }
                  });
                }
                const copy = {
                  ...src,
                  ref: newRef,
                  x: tx,
                  y: ty,
                  pins: (src.pins ?? []).map((pn: { px: number; py: number } & object) => ({
                    ...pn,
                    px: pn.px + dx,
                    py: pn.py + dy,
                    net: '',
                  })),
                  verified: false,
                };
                p.gates.push(copy);
                newIdx = p.gates.length - 1;
                newKind = 'gate';
              }
            });
            if (newIdx >= 0 && newKind) setSelection({ kind: newKind, idx: newIdx });
          } catch { /* ignore */ }
        }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        redo();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    const onPlaceEvent = () => {
      if (tool === 'edit') setPlacingGate(true);
    };
    const onPlaceXrefEvent = () => {
      if (tool === 'edit') setPlacingXref(true);
    };
    const onPlacePortEvent = () => {
      if (tool === 'edit') setPlacingPort(true);
    };
    const onPlaceAnnEvent = () => {
      if (tool === 'edit') setPlacingAnn(true);
    };
    const onPlaceDecoEvent = (ev: Event) => {
      if (tool !== 'edit') return;
      const ce = ev as CustomEvent<{ kind: 'line' | 'rect' | 'ellipse' }>;
      setPlacingDeco(ce.detail?.kind ?? 'line');
    };
    const onPlacePowerEvent = (ev: Event) => {
      if (tool !== 'edit') return;
      const ce = ev as CustomEvent<{ type: string }>;
      setPlacingPower(ce.detail?.type ?? '+5V');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('kronikarz:place-gate', onPlaceEvent);
    window.addEventListener('kronikarz:place-cross-ref', onPlaceXrefEvent);
    window.addEventListener('kronikarz:place-port', onPlacePortEvent);
    window.addEventListener('kronikarz:place-annotation', onPlaceAnnEvent);
    window.addEventListener('kronikarz:place-decoration', onPlaceDecoEvent as EventListener);
    window.addEventListener('kronikarz:place-power', onPlacePowerEvent as EventListener);
    const onExportPng = (ev: Event) => {
      const stage = stageRef.current;
      if (!stage || !page) return;
      const ce = ev as CustomEvent<{ pixelRatio?: number; withScan?: boolean }>;
      const pixelRatio = ce.detail?.pixelRatio ?? 3;
      const withScan = ce.detail?.withScan ?? true;
      // Eksport pelnej strony skanu (nie tylko viewport)
      const [sw, sh] = page.scan_size;
      const origScale = stage.scaleX();
      const origX = stage.x();
      const origY = stage.y();
      // Tymczasowo: reset view do (0,0,1)
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
      // Hide image if not wanted
      const imageLayer = stage.findOne('Layer'); // pierwszy layer = ImageLayer
      const origVisible = imageLayer?.visible() ?? true;
      if (!withScan && imageLayer) imageLayer.visible(false);
      stage.batchDraw();
      const dataUrl = stage.toDataURL({ x: 0, y: 0, width: sw, height: sh, pixelRatio, mimeType: 'image/png' });
      // Przywroc
      if (!withScan && imageLayer) imageLayer.visible(origVisible);
      stage.scale({ x: origScale, y: origScale });
      stage.position({ x: origX, y: origY });
      stage.batchDraw();
      // Download
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `${page.package}-${page.page}${withScan ? '' : '-bare'}.png`;
      a.click();
    };
    window.addEventListener('kronikarz:export-png', onExportPng as EventListener);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('kronikarz:place-gate', onPlaceEvent);
      window.removeEventListener('kronikarz:place-cross-ref', onPlaceXrefEvent);
      window.removeEventListener('kronikarz:place-port', onPlacePortEvent);
      window.removeEventListener('kronikarz:place-annotation', onPlaceAnnEvent);
      window.removeEventListener('kronikarz:place-decoration', onPlaceDecoEvent as EventListener);
      window.removeEventListener('kronikarz:place-power', onPlacePowerEvent as EventListener);
      window.removeEventListener('kronikarz:export-png', onExportPng as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size.w, size.h, opacity, selection, tool, placingGate, zoneSelected]);

  useEffect(() => {
    if (page) fitToScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.page, size.w, size.h]);

  // Persist zones to <page>.zones.yaml — load on page change, save with debounce
  useEffect(() => {
    if (!page || !route.pkg) return;
    const key = `${route.pkg}/${page.page}`;
    if (zonesLoadedRef.current === key) return;
    zonesLoadedRef.current = key;
    setZones([]);
    setZoneSelected(-1);
    fetch(`/files/MJC-400/${route.pkg}/pages/${page.page}.zones.yaml`)
      .then((r) => r.ok ? r.text() : null)
      .then(async (txt) => {
        if (!txt) return;
        try {
          const yaml = await import('js-yaml');
          const doc = yaml.load(txt) as { zones?: VisionZone[] } | null;
          if (doc && Array.isArray(doc.zones)) setZones(doc.zones);
        } catch { /* ignore */ }
      })
      .catch(() => { /* ignore */ });
  }, [page?.page, route.pkg]);

  useEffect(() => {
    if (!page || !route.pkg) return;
    if (zonesLoadedRef.current !== `${route.pkg}/${page.page}`) return;
    if (zonesSaveTimerRef.current) clearTimeout(zonesSaveTimerRef.current);
    zonesSaveTimerRef.current = setTimeout(async () => {
      const yaml = await import('js-yaml');
      const body = zones.length === 0
        ? 'zones: []\n'
        : yaml.dump({ zones }, { flowLevel: 2, lineWidth: 120 });
      apiWrite(`/files/MJC-400/${route.pkg}/pages/${page.page}.zones.yaml`, {
        method: 'PUT',
        body,
      }).catch(() => { /* ignore */ });
    }, 500);
    return () => { if (zonesSaveTimerRef.current) clearTimeout(zonesSaveTimerRef.current); };
  }, [zones, page?.page, route.pkg]);

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    // Touchpad pinch arrives as ctrl+wheel on Chrome; both shapes → zoom.
    // Two-finger swipe (deltaX significant, no ctrl) → pan.
    const isTouchpadPan = !e.evt.ctrlKey && !e.evt.metaKey && Math.abs(e.evt.deltaX) > Math.abs(e.evt.deltaY);
    if (isTouchpadPan) {
      setView({
        x: view.x - e.evt.deltaX,
        y: view.y - e.evt.deltaY,
        scale: view.scale,
      });
      return;
    }
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const oldScale = view.scale;
    const factor = Math.exp(-e.evt.deltaY * 0.0025);
    const newScale = Math.max(0.05, Math.min(20, oldScale * factor));
    const mx = (pointer.x - view.x) / oldScale;
    const my = (pointer.y - view.y) / oldScale;
    setView({
      x: pointer.x - mx * newScale,
      y: pointer.y - my * newScale,
      scale: newScale,
    });
  };

  function ptrScan(): { x: number; y: number } | null {
    const stage = stageRef.current;
    const ptr = stage?.getPointerPosition();
    if (!ptr) return null;
    return { x: (ptr.x - view.x) / view.scale, y: (ptr.y - view.y) / view.scale };
  }

  // Snap a candidate point to horizontal/vertical from a reference. Picks the
  // axis with the larger delta and locks the other to match the reference.
  function portOpenEndScan(p: { x: number; y: number; side: string; connector: string; pin: number }): { x: number; y: number } {
    const pid = `${p.connector}${p.pin}`;
    const labelWidth = Math.max(60, pid.length * 16 + 12);
    const bw = labelWidth + 16;
    const rot = p.side === 'left' ? 0 : p.side === 'right' ? 180 : p.side === 'top' ? 90 : 270;
    const rad = (rot * Math.PI) / 180;
    return { x: Math.round(p.x + bw * Math.cos(rad)), y: Math.round(p.y + bw * Math.sin(rad)) };
  }

  function snapOrtho(ref: { x: number; y: number }, p: { x: number; y: number }, free: boolean): { x: number; y: number } {
    if (free) return p;
    if (Math.abs(p.x - ref.x) >= Math.abs(p.y - ref.y)) {
      return { x: p.x, y: ref.y };
    }
    return { x: ref.x, y: p.y };
  }

  function lastWireAnchor(): { x: number; y: number } | null {
    if (!wireDraft) return null;
    if (wireDraft.vertices.length > 0) return wireDraft.vertices[wireDraft.vertices.length - 1]!;
    return { x: wireDraft.startX, y: wireDraft.startY };
  }

  // Net "wygrywa" gdy ma port/cross_ref label — taki net dziedziczy nazwę
  // bez pytania. Jeśli oba mają label albo żaden, pytamy usera.
  function netLabel(p: typeof page, name: string): string | null {
    if (!p) return null;
    for (const port of p.ports ?? []) {
      if (port.net === name && port.label && port.label.trim()) return port.label;
    }
    for (const cr of p.cross_refs ?? []) {
      if (cr.net === name && cr.label && cr.label.trim()) return cr.label;
    }
    return null;
  }

  function pickWinner(p: typeof page, a: string, b: string): string | null {
    if (a === b) return a;
    const la = netLabel(p, a);
    const lb = netLabel(p, b);
    if (la && !lb) return a;
    if (lb && !la) return b;
    if (la && lb && la === lb) return a;
    return null;
  }

  function commitWire(end: { x: number; y: number; netName?: string }): void {
    if (!wireDraft || !page) return;

    // If ortho mode and endpoint is off-axis from last anchor:
    //   maly delta (<= PIN_NUDGE) -> snap koniec do osi (pin sie przesunie)
    //   wiekszy delta             -> wstaw L-corner
    const PIN_NUDGE = 8;
    const pts: Array<{ x: number; y: number }> = [
      { x: wireDraft.startX, y: wireDraft.startY },
      ...wireDraft.vertices,
    ];
    const last = pts[pts.length - 1]!;
    let endX = end.x;
    let endY = end.y;
    if (wireOrtho && last.x !== endX && last.y !== endY) {
      const dx = Math.abs(endX - last.x);
      const dy = Math.abs(endY - last.y);
      const minDelta = Math.min(dx, dy);
      if (minDelta <= PIN_NUDGE) {
        if (dx <= dy) endX = last.x;
        else endY = last.y;
      } else {
        // Wybierz corner, ktory NIE ladowal by na istniejacym segmencie
        // (inaczej powstaje zbedna odnoga po splicie).
        const c1 = { x: endX, y: last.y };  // pierwszy leg poziomy
        const c2 = { x: last.x, y: endY };  // pierwszy leg pionowy
        const pointOnAnySegment = (px: number, py: number): boolean => {
          for (const net of Object.values(page.nets)) {
            for (const s of net.segments ?? []) {
              if (s[1] === s[3] && py === s[1] && px > Math.min(s[0]!, s[2]!) && px < Math.max(s[0]!, s[2]!)) return true;
              if (s[0] === s[2] && px === s[0] && py > Math.min(s[1]!, s[3]!) && py < Math.max(s[1]!, s[3]!)) return true;
            }
          }
          return false;
        };
        const c1bad = pointOnAnySegment(c1.x, c1.y);
        const c2bad = pointOnAnySegment(c2.x, c2.y);
        let corner: { x: number; y: number };
        if (c1bad && !c2bad) corner = c2;
        else if (c2bad && !c1bad) corner = c1;
        else corner = dx >= dy ? c1 : c2;
        pts.push(corner);
      }
    }
    pts.push({ x: endX, y: endY });

    const netA = wireDraft.netName;
    const netB = end.netName && end.netName.trim() ? end.netName : null;

    // Decide winner name BEFORE editPage (need to maybe prompt user).
    let winner = netA;
    let loser: string | null = null;
    if (netB && netB !== netA) {
      const w = pickWinner(page, netA, netB);
      if (w !== null) {
        winner = w;
        loser = w === netA ? netB : netA;
      } else {
        const choice = window.prompt(
          `Łączysz dwie sieci o różnych nazwach. Którą zachować?\n` +
          `A: ${netA}\nB: ${netB}\n` +
          `Wpisz A, B, lub nową nazwę:`,
          netA,
        );
        if (!choice) {
          setWireDraft(null);
          setWireCursor(null);
          return;
        }
        const c = choice.trim();
        if (c === 'A' || c === 'a') { winner = netA; loser = netB; }
        else if (c === 'B' || c === 'b') { winner = netB; loser = netA; }
        else { winner = c; loser = null; }
      }
    }

    editPage((p) => {
      // Ensure winner exists
      const target = (p.nets[winner] ??= { pins: [], segments: null, junctions: null });
      const segs = target.segments ?? [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (a.x === b.x && a.y === b.y) continue;
        segs.push([Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y)]);
      }
      target.segments = segs;

      // --- Defensive cleanup helpers ---
      const MERGE_TOL = 3;
      const snapClose = (): void => {
        // Snap endpointy ktore sa w obrebie MERGE_TOL od siebie do wspolnego punktu.
        const segs = target.segments ?? [];
        if (segs.length === 0) return;
        const reps: Array<[number, number]> = [];
        const repFor = (x: number, y: number): [number, number] => {
          for (const r of reps) {
            if (Math.abs(r[0] - x) <= MERGE_TOL && Math.abs(r[1] - y) <= MERGE_TOL) return r;
          }
          const r: [number, number] = [x, y];
          reps.push(r);
          return r;
        };
        for (const s of segs) {
          const a = repFor(s[0]!, s[1]!);
          const b = repFor(s[2]!, s[3]!);
          s[0] = a[0]; s[1] = a[1]; s[2] = b[0]; s[3] = b[1];
        }
        // Drop zerowe (oba endpointy ten sam punkt)
        target.segments = segs.filter((s) => !(s[0] === s[2] && s[1] === s[3])) as Array<[number, number, number, number]>;
      };
      const collapseColinear = (): void => {
        // Polacz pary segmentow ktore lacza sie w punkcie deg=2 i sa wspolliniowe.
        let segs = target.segments ?? [];
        let changed = true;
        while (changed) {
          changed = false;
          const deg = new Map<string, number>();
          for (const s of segs) {
            const k1 = `${s[0]},${s[1]}`;
            const k2 = `${s[2]},${s[3]}`;
            deg.set(k1, (deg.get(k1) ?? 0) + 1);
            deg.set(k2, (deg.get(k2) ?? 0) + 1);
          }
          // junctions z manual list — nie zwijaj jezeli punkt jest junctionem
          const manualJ = new Set((target.junctions ?? []).map((j) => `${j[0]},${j[1]}`));
          for (let i = 0; i < segs.length && !changed; i++) {
            for (let j = i + 1; j < segs.length && !changed; j++) {
              const a = segs[i]!;
              const b = segs[j]!;
              const aH = a[1] === a[3];
              const bH = b[1] === b[3];
              if (aH !== bH) continue;
              if (aH && a[1] !== b[1]) continue;
              if (!aH && a[0] !== b[0]) continue;
              // Find shared endpoint
              const aEnds: Array<[number, number]> = [[a[0]!, a[1]!], [a[2]!, a[3]!]];
              const bEnds: Array<[number, number]> = [[b[0]!, b[1]!], [b[2]!, b[3]!]];
              let sharedKey = '';
              let ai = -1; let bi = -1;
              for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) {
                if (aEnds[p]![0] === bEnds[q]![0] && aEnds[p]![1] === bEnds[q]![1]) {
                  sharedKey = `${aEnds[p]![0]},${aEnds[p]![1]}`;
                  ai = p; bi = q;
                }
              }
              if (!sharedKey) continue;
              if ((deg.get(sharedKey) ?? 0) !== 2) continue;
              if (manualJ.has(sharedKey)) continue;
              const aOther = aEnds[1 - ai]!;
              const bOther = bEnds[1 - bi]!;
              const merged: [number, number, number, number] = [aOther[0], aOther[1], bOther[0], bOther[1]];
              segs = segs.filter((_, k) => k !== i && k !== j);
              segs.push(merged);
              changed = true;
            }
          }
        }
        target.segments = segs as Array<[number, number, number, number]>;
      };

      // Split istniejacych segmentow w punktach gdzie nowy wire ich dotyka
      // (w srodku, nie na endpoincie). To generuje T-junctions.
      const onSegmentStrict = (s: number[], px: number, py: number): boolean => {
        if (s[1] === s[3] && py === s[1]) {
          const xmin = Math.min(s[0]!, s[2]!);
          const xmax = Math.max(s[0]!, s[2]!);
          return px > xmin && px < xmax;
        }
        if (s[0] === s[2] && px === s[0]) {
          const ymin = Math.min(s[1]!, s[3]!);
          const ymax = Math.max(s[1]!, s[3]!);
          return py > ymin && py < ymax;
        }
        return false;
      };
      const touchPts = pts.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) }));
      for (const pt of touchPts) {
        const next: number[][] = [];
        for (const s of target.segments) {
          if (onSegmentStrict(s, pt.x, pt.y)) {
            next.push([s[0]!, s[1]!, pt.x, pt.y]);
            next.push([pt.x, pt.y, s[2]!, s[3]!]);
          } else {
            next.push(s);
          }
        }
        target.segments = next as Array<[number, number, number, number]>;
      }

      // Merge any net we want renamed into winner (loser explicit + netA if winner is brand-new).
      const toMerge = new Set<string>();
      if (loser) toMerge.add(loser);
      if (winner !== netA) toMerge.add(netA);
      if (winner !== (netB ?? winner) && netB) toMerge.add(netB);
      toMerge.delete(winner);

      for (const old of toMerge) {
        const oldRec = p.nets[old];
        if (oldRec) {
          if (oldRec.segments) target.segments = (target.segments ?? []).concat(oldRec.segments);
          if (oldRec.junctions) target.junctions = (target.junctions ?? []).concat(oldRec.junctions);
          delete p.nets[old];
        }
        for (const g of p.gates) for (const pin of g.pins) if (pin.net === old) pin.net = winner;
        for (const port of p.ports ?? []) if (port.net === old) port.net = winner;
        for (const cr of p.cross_refs ?? []) if (cr.net === old) cr.net = winner;
      }

      // Po wszystkich modyfikacjach (split + merge): zsnapuj bliskie endpointy,
      // dropnij zerowe, zwin wspolliniowe deg=2.
      snapClose();
      collapseColinear();

      // Force-assign net to ANY pin/port/cross_ref AT start or end coord.
      // Tolerance = PIN_NUDGE: jezeli pin jest blisko, dociagnij go na os ścieżki.
      const endsCoords = [
        { x: Math.round(pts[0]!.x), y: Math.round(pts[0]!.y) },
        { x: Math.round(pts[pts.length - 1]!.x), y: Math.round(pts[pts.length - 1]!.y) },
      ];
      const matchPt = (a: { x: number; y: number }, bx: number, by: number, tol = PIN_NUDGE): boolean =>
        Math.abs(a.x - bx) <= tol && Math.abs(a.y - by) <= tol;
      for (const pt of endsCoords) {
        for (const g of p.gates) {
          for (const pin of g.pins) {
            if (matchPt(pt, pin.px, pin.py)) {
              if (pin.px !== pt.x || pin.py !== pt.y) {
                const oldX = pin.px;
                const oldY = pin.py;
                pin.px = pt.x;
                pin.py = pt.y;
                for (const net of Object.values(p.nets)) {
                  if (net.segments) {
                    for (const s of net.segments) {
                      if (s[0] === oldX && s[1] === oldY) { s[0] = pt.x; s[1] = pt.y; }
                      if (s[2] === oldX && s[3] === oldY) { s[2] = pt.x; s[3] = pt.y; }
                    }
                  }
                  if (net.junctions) {
                    for (const j of net.junctions) {
                      if (j[0] === oldX && j[1] === oldY) { j[0] = pt.x; j[1] = pt.y; }
                    }
                  }
                }
              }
              if (pin.net !== winner) pin.net = winner;
            }
          }
        }
        for (const port of p.ports ?? []) {
          const oe = portOpenEndScan(port);
          if (matchPt(pt, oe.x, oe.y)) {
            if (oe.x !== pt.x || oe.y !== pt.y) {
              // Shift chevron tip tak zeby open-end ladowal na endpoincie.
              // Przesun tez wszystkie endpointy/junctions ktore byly przy STARYM open-end
              // (zeby mikro-segmenty nie zostawaly).
              const oldX = oe.x;
              const oldY = oe.y;
              port.x += pt.x - oe.x;
              port.y += pt.y - oe.y;
              for (const net of Object.values(p.nets)) {
                if (net.segments) {
                  for (const s of net.segments) {
                    if (s[0] === oldX && s[1] === oldY) { s[0] = pt.x; s[1] = pt.y; }
                    if (s[2] === oldX && s[3] === oldY) { s[2] = pt.x; s[3] = pt.y; }
                  }
                }
                if (net.junctions) {
                  for (const j of net.junctions) {
                    if (j[0] === oldX && j[1] === oldY) { j[0] = pt.x; j[1] = pt.y; }
                  }
                }
              }
            }
            if (port.net !== winner) port.net = winner;
          }
        }
        for (const cr of p.cross_refs ?? []) {
          if (matchPt(pt, cr.x, cr.y)) {
            if (cr.x !== pt.x || cr.y !== pt.y) {
              const oldX = cr.x;
              const oldY = cr.y;
              cr.x = pt.x;
              cr.y = pt.y;
              for (const net of Object.values(p.nets)) {
                if (net.segments) {
                  for (const s of net.segments) {
                    if (s[0] === oldX && s[1] === oldY) { s[0] = pt.x; s[1] = pt.y; }
                    if (s[2] === oldX && s[3] === oldY) { s[2] = pt.x; s[3] = pt.y; }
                  }
                }
                if (net.junctions) {
                  for (const j of net.junctions) {
                    if (j[0] === oldX && j[1] === oldY) { j[0] = pt.x; j[1] = pt.y; }
                  }
                }
              }
            }
            if (cr.net !== winner) cr.net = winner;
          }
        }
      }
    });

    setWireDraft(null);
    setWireCursor(null);
  }

  useEffect(() => {
    function onWireEndpoint(ev: Event): void {
      const ce = ev as CustomEvent<{ x: number; y: number; netName: string; autoNet?: string }>;
      if (tool !== 'wire' || !page) return;
      const { x, y, netName, autoNet } = ce.detail;
      if (!wireDraft) {
        setWireDraft({
          netName: (netName && netName.trim()) ? netName : (autoNet ?? `NET_${Date.now()}`),
          startX: x,
          startY: y,
          vertices: [],
        });
        setWireCursor({ x, y });
      } else {
        commitWire({ x, y, netName });
      }
    }
    window.addEventListener('kronikarz:wire-endpoint-click', onWireEndpoint);
    return () => window.removeEventListener('kronikarz:wire-endpoint-click', onWireEndpoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, page, wireDraft]);

  const ZONE_COLORS: Record<ZoneRole, string> = {
    gates: '#22c55e',
    ports_left: '#3b82f6',
    ports_right: '#a855f7',
    cross_refs_left: '#f59e0b',
    cross_refs_right: '#ef4444',
  };
  const ZONE_NEXT: Record<ZoneRole, ZoneRole> = {
    gates: 'ports_left',
    ports_left: 'ports_right',
    ports_right: 'cross_refs_left',
    cross_refs_left: 'cross_refs_right',
    cross_refs_right: 'gates',
  };

  async function runVisionZones() {
    if (!page || !route.pkg || zones.length === 0) return;
    if (!confirm(`Vision-digitize z ${zones.length} strefami? Plik nadpisany (auto .bak).`)) return;
    setVisionBusy(true);
    const pkgId = route.pkg;
    const pageId = page.page;
    try {
      // Rewrites the page server-side: flush, fence the page, POST, reload.
      await runRewrite(pageFilePath(pkgId, pageId), 'Vision', async () => {
        const { outcome, data: d } = await postRewrite('/vision-page-zones', { package: pkgId, page: pageId, zones });
        if (outcome !== 'ok') {
          alert('vision failed: ' + (d?.error ?? outcome) + (d?.stderr ? '\n\nstderr:\n' + String(d.stderr).slice(0, 1000) : ''));
          return outcome;
        }
        alert(
          `Wykryto:\n  ${d!.gates ?? 0} bramek\n  ${d!.ports ?? 0} portów\n  ${d!.cross_refs ?? 0} cross-refów\n\nBackup: <page>.sch.yaml.bak`
        );
        setZones([]);
        return outcome;
      });
    } finally {
      setVisionBusy(false);
    }
  }

  const onMouseDownStage = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    if (tool === 'select' && e.evt.button === 0 && !e.evt.ctrlKey && !e.evt.metaKey && !spaceDown) {
      // Rubber-band selection: tylko gdy klik na pustym tle (nie na obiekcie)
      if (e.target === e.target.getStage()) {
        const p = ptrScan();
        if (!p) return;
        e.evt.preventDefault();
        selectDragRef.current = { x0: p.x, y0: p.y };
        setSelectRect({ x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 });
        return;
      }
    }
    if (placingDeco && tool === 'edit') {
      if (e.evt.button !== 0 || e.evt.ctrlKey || e.evt.metaKey) return;
      const p = ptrScan();
      if (!p) return;
      e.evt.preventDefault();
      decoDragRef.current = { x0: p.x, y0: p.y };
      if (placingDeco === 'line') {
        setDecoDraft({ kind: 'line', x1: Math.round(p.x), y1: Math.round(p.y), x2: Math.round(p.x), y2: Math.round(p.y) });
      } else if (placingDeco === 'rect') {
        setDecoDraft({ kind: 'rect', x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 });
      } else {
        setDecoDraft({ kind: 'ellipse', x: Math.round(p.x), y: Math.round(p.y), rx: 0, ry: 0 });
      }
      return;
    }
    if (tool === 'zones') {
      if (e.evt.button !== 0 || e.evt.ctrlKey || e.evt.metaKey) return;
      const p = ptrScan();
      if (!p) return;
      e.evt.preventDefault();
      zoneDragRef.current = { x0: p.x, y0: p.y };
      setZoneDraft({ role: 'gates', x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 });
      return;
    }
    if (tool === 'wire' && wireDraft) {
      if (e.evt.button !== 0 || e.evt.ctrlKey || e.evt.metaKey) return;
      const cls = (e.target as Konva.Node).getClassName?.() ?? '';
      if (cls === 'Circle') return;
      const p = ptrScan();
      if (!p) return;
      e.evt.preventDefault();
      const anchor = lastWireAnchor() ?? p;
      const free = e.evt.shiftKey || !wireOrtho;
      const snapped = snapOrtho(anchor, p, free);
      setWireDraft({ ...wireDraft, vertices: [...wireDraft.vertices, { x: Math.round(snapped.x), y: Math.round(snapped.y) }] });
      return;
    }
    if (tool !== 'roi') return;
    if (e.evt.button !== 0 || e.evt.ctrlKey || e.evt.metaKey) return;
    if (e.target !== e.target.getStage() && e.target.getParent()?.constructor.name !== 'Layer') {
      // allow starting on image layer too
    }
    const p = ptrScan();
    if (!p) return;
    e.evt.preventDefault();
    roiDragRef.current = { x0: p.x, y0: p.y };
    setRoiRect({ x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 });
  };

  const onMouseMoveStage = (e?: Konva.KonvaEventObject<MouseEvent>): void => {
    if (selectDragRef.current) {
      const p = ptrScan();
      if (!p) return;
      const s = selectDragRef.current;
      const x = Math.round(Math.min(s.x0, p.x));
      const y = Math.round(Math.min(s.y0, p.y));
      const w = Math.round(Math.abs(p.x - s.x0));
      const h = Math.round(Math.abs(p.y - s.y0));
      setSelectRect({ x, y, w, h });
      return;
    }
    if (placingDeco && decoDragRef.current) {
      const p = ptrScan();
      if (!p) return;
      const s = decoDragRef.current;
      if (placingDeco === 'line') {
        // Domyslnie ortho (poziomo/pionowo). Shift = freeform.
        const free = !!e?.evt?.shiftKey;
        let x2 = Math.round(p.x);
        let y2 = Math.round(p.y);
        if (!free) {
          if (Math.abs(p.x - s.x0) >= Math.abs(p.y - s.y0)) y2 = Math.round(s.y0);
          else x2 = Math.round(s.x0);
        }
        setDecoDraft({ kind: 'line', x1: Math.round(s.x0), y1: Math.round(s.y0), x2, y2 });
      } else if (placingDeco === 'rect') {
        const x = Math.round(Math.min(s.x0, p.x));
        const y = Math.round(Math.min(s.y0, p.y));
        const w = Math.round(Math.abs(p.x - s.x0));
        const h = Math.round(Math.abs(p.y - s.y0));
        setDecoDraft({ kind: 'rect', x, y, w, h });
      } else {
        const cx = Math.round((s.x0 + p.x) / 2);
        const cy = Math.round((s.y0 + p.y) / 2);
        const rx = Math.round(Math.abs(p.x - s.x0) / 2);
        const ry = Math.round(Math.abs(p.y - s.y0) / 2);
        setDecoDraft({ kind: 'ellipse', x: cx, y: cy, rx, ry });
      }
      return;
    }
    if (tool === 'zones' && zoneDragRef.current) {
      const p = ptrScan();
      if (!p) return;
      const s = zoneDragRef.current;
      const x = Math.round(Math.min(s.x0, p.x));
      const y = Math.round(Math.min(s.y0, p.y));
      const w = Math.round(Math.abs(p.x - s.x0));
      const h = Math.round(Math.abs(p.y - s.y0));
      setZoneDraft({ role: 'gates', x, y, w, h });
      return;
    }
    if (tool === 'wire' && wireDraft) {
      const p = ptrScan();
      if (p) {
        const anchor = lastWireAnchor() ?? p;
        const free = !wireOrtho;
        const snapped = snapOrtho(anchor, p, free);
        setWireCursor({ x: Math.round(snapped.x), y: Math.round(snapped.y) });
      }
    }
    const s = roiDragRef.current;
    if (!s) return;
    const p = ptrScan();
    if (!p) return;
    const x = Math.round(Math.min(s.x0, p.x));
    const y = Math.round(Math.min(s.y0, p.y));
    const w = Math.round(Math.abs(p.x - s.x0));
    const h = Math.round(Math.abs(p.y - s.y0));
    setRoiRect({ x, y, w, h });
  };

  const onMouseUpStage = async (): Promise<void> => {
    if (selectDragRef.current && selectRect && page) {
      const r = selectRect;
      selectDragRef.current = null;
      setSelectRect(null);
      if (r.w < 4 || r.h < 4) return;
      const inside = (x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      // Priorytet: gates jezeli sa, inaczej ports, inaczej cross_refs
      const gateIdx: number[] = [];
      page.gates.forEach((g, i) => { if (inside(g.x, g.y)) gateIdx.push(i); });
      if (gateIdx.length > 0) {
        setMulti({ kind: 'gate', indices: gateIdx });
        return;
      }
      const portIdx: number[] = [];
      (page.ports ?? []).forEach((p, i) => { if (inside(p.x, p.y)) portIdx.push(i); });
      if (portIdx.length > 0) {
        setMulti({ kind: 'port', indices: portIdx });
        return;
      }
      const crIdx: number[] = [];
      (page.cross_refs ?? []).forEach((c, i) => { if (inside(c.x, c.y)) crIdx.push(i); });
      if (crIdx.length > 0) {
        setMulti({ kind: 'cross_ref', indices: crIdx });
        return;
      }
      setMulti(null);
      return;
    }
    if (placingDeco && decoDragRef.current && decoDraft) {
      decoDragRef.current = null;
      const d = decoDraft;
      setDecoDraft(null);
      setPlacingDeco(null);
      // Skip too-small
      if (d.kind === 'line' && Math.abs(d.x2 - d.x1) < 4 && Math.abs(d.y2 - d.y1) < 4) return;
      if (d.kind === 'rect' && (d.w < 4 || d.h < 4)) return;
      if (d.kind === 'ellipse' && (d.rx < 4 || d.ry < 4)) return;
      let newIdx = -1;
      editPage((p) => {
        const arr = (p.decorations ??= []);
        arr.push(d);
        newIdx = arr.length - 1;
      });
      if (newIdx >= 0) setSelection({ kind: 'decoration', idx: newIdx });
      return;
    }
    if (tool === 'zones' && zoneDragRef.current && zoneDraft) {
      zoneDragRef.current = null;
      const z = zoneDraft;
      setZoneDraft(null);
      if (z.w < 20 || z.h < 20) return;
      setZones((prev) => {
        const next = [...prev, z];
        setZoneSelected(next.length - 1);
        return next;
      });
      return;
    }
    const s = roiDragRef.current;
    if (!s) return;
    roiDragRef.current = null;
    const r = roiRect;
    setRoiRect(null);
    if (!r || r.w < 8 || r.h < 8 || !page || !route.pkg) return;
    setRoiBusy(true);
    try {
      const resp = await apiWrite('/ai-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: route.pkg, page: page.page, x: r.x, y: r.y, w: r.w, h: r.h }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        console.error('ai-detect:', data);
        alert('AI detect failed: ' + (data.error ?? resp.statusText));
        return;
      }
      setRoiResult({ roi: r, detections: data.detections ?? [] });
    } catch (err) {
      console.error(err);
      alert('AI detect error: ' + String(err));
    } finally {
      setRoiBusy(false);
    }
  };

  const scanUrl =
    page && route.pkg ? `/files/MJC-400/${route.pkg}/${getScanPath(page, route.pkg)}` : null;

  return (
    <div ref={containerRef} className="relative flex-1 overflow-hidden bg-bg-main">
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        x={view.x}
        y={view.y}
        scaleX={view.scale}
        scaleY={view.scale}
        draggable={spaceDown}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage()) {
            setView({ x: e.target.x(), y: e.target.y(), scale: view.scale });
          }
        }}
        onWheel={onWheel}
        onMouseDown={onMouseDownStage}
        onMouseMove={onMouseMoveStage}
        onMouseUp={onMouseUpStage}
        onClick={(e) => {
          if (e.target !== e.target.getStage()) return;
          if (placingGate && tool === 'edit' && page) {
            const stage = stageRef.current;
            const ptr = stage?.getPointerPosition();
            if (ptr) {
              const sx = Math.round((ptr.x - view.x) / view.scale);
              const sy = Math.round((ptr.y - view.y) / view.scale);
              if (sx >= 0 && sx <= page.scan_size[0] && sy >= 0 && sy <= page.scan_size[1]) {
                setAddAt({ x: sx, y: sy });
              }
            }
            setPlacingGate(false);
            return;
          }
          if (placingXref && tool === 'edit' && page) {
            const stage = stageRef.current;
            const ptr = stage?.getPointerPosition();
            if (ptr) {
              const sx = Math.round((ptr.x - view.x) / view.scale);
              const sy = Math.round((ptr.y - view.y) / view.scale);
              if (sx >= 0 && sx <= page.scan_size[0] && sy >= 0 && sy <= page.scan_size[1]) {
                setAddXrefAt({ x: sx, y: sy });
              }
            }
            setPlacingXref(false);
            return;
          }
          if (placingAnn && tool === 'edit' && page) {
            const stage = stageRef.current;
            const ptr = stage?.getPointerPosition();
            if (ptr) {
              const sx = Math.round((ptr.x - view.x) / view.scale);
              const sy = Math.round((ptr.y - view.y) / view.scale);
              if (sx >= 0 && sx <= page.scan_size[0] && sy >= 0 && sy <= page.scan_size[1]) {
                setAddAnnAt({ x: sx, y: sy });
              }
            }
            setPlacingAnn(false);
            return;
          }
          if (placingPower && tool === 'edit' && page) {
            const stage = stageRef.current;
            const ptr = stage?.getPointerPosition();
            if (ptr) {
              const sx = Math.round((ptr.x - view.x) / view.scale);
              const sy = Math.round((ptr.y - view.y) / view.scale);
              if (sx >= 0 && sx <= page.scan_size[0] && sy >= 0 && sy <= page.scan_size[1]) {
                const ptype = placingPower;
                const defaultNet = ptype === '+5V' ? '+5V' : ptype === '+0V' ? '+0V' : ptype;
                editPage((p) => {
                  p.power.push({ type: ptype, x: sx, y: sy, net: defaultNet });
                });
              }
            }
            setPlacingPower(null);
            return;
          }
          if (placingPort && tool === 'edit' && page) {
            const stage = stageRef.current;
            const ptr = stage?.getPointerPosition();
            if (ptr) {
              const sx = Math.round((ptr.x - view.x) / view.scale);
              const sy = Math.round((ptr.y - view.y) / view.scale);
              if (sx >= 0 && sx <= page.scan_size[0] && sy >= 0 && sy <= page.scan_size[1]) {
                setAddPortAt({ x: sx, y: sy });
              }
            }
            setPlacingPort(false);
            return;
          }
          setSelection(null);
        }}
        style={{
          cursor:
            middlePanning || ctrlDragging === 'pan'
              ? 'grabbing'
              : ctrlDragging === 'zoom'
                ? 'ns-resize'
                : spaceDown
                  ? 'grab'
                  : placingGate
                    ? 'copy'
                    : tool === 'roi'
                      ? 'crosshair'
                      : tool === 'edit'
                        ? 'crosshair'
                        : 'default',
        }}
      >
        {scanUrl && page && (
          <ImageLayer
            src={scanUrl}
            width={page.scan_size[0]}
            height={page.scan_size[1]}
            opacity={opacity}
          />
        )}
        {page && overlaysVisible && (
          <>
            <NetLayer page={page} zoom={view.scale} />
            <GateLayer gates={page.gates} />
            <PinLayer gates={page.gates} />
            <PowerLayer power={page.power} zoom={view.scale} />
            <PortLayer ports={page.ports ?? []} zoom={view.scale} />
            <CrossRefLayer refs={page.cross_refs ?? []} zoom={view.scale} />
            <CrossPageLayer page={page} zoom={view.scale} />
            <DecorationLayer decorations={page.decorations ?? []} zoom={view.scale} />
            <AnnotationLayer annotations={page.annotations ?? []} zoom={view.scale} />
          </>
        )}
        {page && (
          <>
            <Layer listening={false}>
              <Rect
                x={0}
                y={0}
                width={page.scan_size[0]}
                height={page.scan_size[1]}
                stroke="#1a7a0a"
                strokeWidth={1 / view.scale}
              />
              {wireDraft && page && (() => {
                const pts: number[] = [wireDraft.startX, wireDraft.startY];
                for (const v of wireDraft.vertices) pts.push(v.x, v.y);
                if (wireCursor) pts.push(wireCursor.x, wireCursor.y);
                return (
                  <Group>
                    <Line points={pts} stroke="#FF9800" strokeWidth={2 / view.scale} />
                    {wireDraft.vertices.map((v, i) => (
                      <Rect
                        key={`wv-${i}`}
                        x={v.x - 3 / view.scale}
                        y={v.y - 3 / view.scale}
                        width={6 / view.scale}
                        height={6 / view.scale}
                        fill="#FF9800"
                      />
                    ))}
                  </Group>
                );
              })()}
              {selectRect && (
                <Rect
                  x={selectRect.x}
                  y={selectRect.y}
                  width={selectRect.w}
                  height={selectRect.h}
                  stroke="#39ff14"
                  strokeWidth={1 / view.scale}
                  dash={[4 / view.scale, 4 / view.scale]}
                  fill="rgba(57,255,20,0.08)"
                />
              )}
              {decoDraft && (
                <>
                  {decoDraft.kind === 'line' && (
                    <Line points={[decoDraft.x1, decoDraft.y1, decoDraft.x2, decoDraft.y2]} stroke="#FF9800" strokeWidth={2 / view.scale} dash={[6 / view.scale, 4 / view.scale]} />
                  )}
                  {decoDraft.kind === 'rect' && (
                    <Rect x={decoDraft.x} y={decoDraft.y} width={decoDraft.w} height={decoDraft.h} stroke="#FF9800" strokeWidth={2 / view.scale} dash={[6 / view.scale, 4 / view.scale]} fill="rgba(255,152,0,0.08)" />
                  )}
                </>
              )}
              {roiRect && (
                <Group>
                  <Rect
                    x={roiRect.x}
                    y={roiRect.y}
                    width={roiRect.w}
                    height={roiRect.h}
                    stroke="#ffcc00"
                    strokeWidth={2 / view.scale}
                    dash={[6 / view.scale, 4 / view.scale]}
                    fill="rgba(255,204,0,0.08)"
                  />
                  <Text
                    x={roiRect.x}
                    y={roiRect.y - 18 / view.scale}
                    text={`${roiRect.w}×${roiRect.h}`}
                    fontSize={14 / view.scale}
                    fill="#ffcc00"
                  />
                </Group>
              )}
            </Layer>
            {/* Zones layer (clickable) - tylko w trybie zones */}
            {tool === 'zones' && <Layer>
              {zones.map((z, i) => {
                const c = ZONE_COLORS[z.role];
                const selected = zoneSelected === i;
                return (
                  <Group key={`zone-${i}`}>
                    <Rect
                      x={z.x}
                      y={z.y}
                      width={z.w}
                      height={z.h}
                      stroke={c}
                      strokeWidth={(selected ? 4 : 2) / view.scale}
                      dash={[8 / view.scale, 4 / view.scale]}
                      fill={`${c}22`}
                      onClick={(e) => {
                        e.cancelBubble = true;
                        if (e.evt.shiftKey) {
                          // cycle role
                          setZones((prev) => prev.map((zz, k) => k === i ? { ...zz, role: ZONE_NEXT[zz.role] } : zz));
                        }
                        setZoneSelected(i);
                      }}
                    />
                    <Text
                      x={z.x + 6}
                      y={z.y + 6}
                      text={z.role}
                      fontSize={16 / view.scale}
                      fill={c}
                      fontStyle="bold"
                      listening={false}
                    />
                  </Group>
                );
              })}
              {zoneDraft && (
                <Rect
                  x={zoneDraft.x}
                  y={zoneDraft.y}
                  width={zoneDraft.w}
                  height={zoneDraft.h}
                  stroke={ZONE_COLORS.gates}
                  strokeWidth={2 / view.scale}
                  dash={[6 / view.scale, 4 / view.scale]}
                  fill={`${ZONE_COLORS.gates}22`}
                  listening={false}
                />
              )}
            </Layer>}
          </>
        )}
      </Stage>
      {!page && !loading && (
        <div className="absolute inset-0 flex items-center justify-center text-text-dim">
          {route.mode === 'empty' ? (
            <span>brak trasy — sproboj #/module/MJC-400</span>
          ) : (
            <span>brak danych dla {JSON.stringify(route)}</span>
          )}
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-phosphor">
          ladowanie...
        </div>
      )}
      {placingGate && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          klik = wstaw bramkę · Esc = anuluj
        </div>
      )}
      {addAt && (
        <AddGateDialog x={addAt.x} y={addAt.y} onClose={() => setAddAt(null)} />
      )}
      {addXrefAt && (
        <AddCrossRefDialog x={addXrefAt.x} y={addXrefAt.y} onClose={() => setAddXrefAt(null)} />
      )}
      {placingXref && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          klik = wstaw cross-ref · Esc = anuluj
        </div>
      )}
      {addPortAt && (
        <AddPortDialog x={addPortAt.x} y={addPortAt.y} onClose={() => setAddPortAt(null)} />
      )}
      {addAnnAt && (
        <AddAnnotationDialog x={addAnnAt.x} y={addAnnAt.y} onClose={() => setAddAnnAt(null)} />
      )}
      {placingAnn && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          klik = wstaw tekst · Esc = anuluj
        </div>
      )}
      {placingDeco && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          {placingDeco === 'line' ? 'przeciągnij linię (ortho · Shift = freeform)' : placingDeco === 'rect' ? 'przeciągnij prostokąt' : 'przeciągnij koło'} · Esc = anuluj
        </div>
      )}
      {placingPort && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          klik = wstaw port · Esc = anuluj
        </div>
      )}
      {roiBusy && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          AI patrzy na wycinek...
        </div>
      )}
      {tool === 'roi' && !roiBusy && !roiResult && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          przeciągnij prostokąt nad bramką · Esc = wyjdź
        </div>
      )}
      {tool === 'wire' && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          {wireDraft
            ? `wire net=${wireDraft.netName} · klik=wierzchołek · klik pin=zakończ · Backspace=cofnij · Esc=anuluj`
            : 'klik na pin = zacznij ścieżkę · Esc = wyjdź'}
        </div>
      )}
      {tool === 'zones' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          <span>
            zones: {zones.length} · przeciągnij = nowa strefa · shift+klik = zmień rolę · Del = usuń
          </span>
          <button
            onClick={runVisionZones}
            disabled={visionBusy || zones.length === 0}
            className="ml-2 bg-phosphor-dim px-2 py-0.5 text-bg-main hover:bg-phosphor disabled:opacity-50"
          >
            {visionBusy ? '⏳ vision...' : '👁 vision (zones)'}
          </button>
          <button
            onClick={() => { setZones([]); setZoneSelected(-1); }}
            disabled={zones.length === 0}
            className="px-2 py-0.5 text-text-dim hover:text-phosphor disabled:opacity-50"
          >
            wyczyść
          </button>
        </div>
      )}
      {roiResult && (
        <AIDetectDialog
          roi={roiResult.roi}
          detections={roiResult.detections}
          onClose={() => setRoiResult(null)}
        />
      )}
    </div>
  );
}

function getScanPath(page: { package: string; page: string }, _pkg: string): string {
  return `scans/${page.page}.jpg`;
}

// "R7" → next free "R8", "R9", ... Skips collisions in pkg.components.
function nextFreeRef(pkg: { components: Record<string, unknown> } | null, srcRef: string): string {
  if (!pkg) return srcRef;
  const m = /^([A-Za-z]+)(\d+)$/.exec(srcRef);
  if (!m) {
    // Fallback: append numeric suffix
    let i = 2;
    while (pkg.components[`${srcRef}_${i}`]) i++;
    return `${srcRef}_${i}`;
  }
  const prefix = m[1]!;
  let n = parseInt(m[2]!, 10) + 1;
  while (pkg.components[`${prefix}${n}`]) n++;
  return `${prefix}${n}`;
}
