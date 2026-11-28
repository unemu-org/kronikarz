import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Rect, Group, Text, Line } from 'react-konva';
import type Konva from 'konva';
import {
  useDocStore,
  lockReason,
  runRewrite,
  postRewrite,
  fetchDataFile,
  scheduleSave,
  parsePageFilePath,
  scanFilePath,
  zonesFilePath,
  type VisionZone,
  type ZoneRole,
} from './store.ts';
import { useEvent } from './useEvent.ts';
import { chordAction, plainKey, toolForKey } from './hotkeys.ts';
import { createZonesSync, type ZonesLoadState, type ZonesSync } from './zonesSync.ts';
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
import { bandSelection, canEditElement, placeAllowed, type Box } from './stepView.ts';
import { useWireEditing, WireOverlay, WireToast } from './useWireEditing.tsx';
import { LOCK_RUNNING } from './autoRun.ts';

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
  const [zonesLoad, setZonesLoad] = useState<{ state: ZonesLoadState; error: string | null }>({
    state: 'loaded',
    error: null,
  });
  // Zones file load/save (zonesSync.ts): saves only user changes, only after
  // the GET of that page's zones resolved, through the store's save queue.
  // Zones cannot be edited until then (an edit would be replaced by the load).
  const zonesEditable = zonesLoad.state === 'loaded';
  const zonesSyncRef = useRef<ZonesSync | null>(null);
  zonesSyncRef.current ??= createZonesSync({
    fetch: fetchDataFile,
    schedule: scheduleSave,
    apply: (z) => {
      setZones(z);
      setZoneSelected(-1);
    },
    onState: (state, error) => setZonesLoad({ state, error }),
    onLoadError: (path, error) => {
      console.warn(`zones: ${path}: ${error} — strefy tej strony nie będą zapisywane`);
    },
  });
  const page = useDocStore((s) => s.page);
  const pagePath = useDocStore((s) => s.pagePath);
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
  // W tool + hover keys x / j / t + wire selection delete (useWireEditing.tsx, wireEdit.ts).
  const wire = useWireEditing({ ptrScan, zoom: view.scale, panning: spaceDown || middlePanning || !!ctrlDragging });

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

  const fitToScreen = useEvent(() => {
    if (!page) return;
    const [sw, sh] = page.scan_size;
    const scale = Math.min(size.w / sw, size.h / sh) * 0.95;
    setView({
      x: (size.w - sw * scale) / 2,
      y: (size.h - sh * scale) / 2,
      scale,
    });
  });

  // Window-level handlers below are useEvent callbacks: registered once, and
  // every call sees the current render's state (view, placing*,
  // page, pkg, selection, tool…) — no dependency list to keep in sync.
  const onKeyDown = useEvent((e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') {
      setSpaceDown(true);
      e.preventDefault();
    }
    if (wire.onKeyDown(e)) return;
    // Single-key hotkeys: null while Ctrl/Cmd/Alt is held (chords below).
    const key = plainKey(e);
    const chord = chordAction(e);
    if (key === '0') fitToScreen();
    if (key === '1') setView({ x: 0, y: 0, scale: 1 });
    if (key === '2') setView({ x: 0, y: 0, scale: 2 });
    if (key === '[') setOpacity(Math.max(0, opacity - 0.1));
    if (key === ']') setOpacity(Math.min(1, opacity + 0.1));
    if (key === '\\') setOpacity(opacity > 0 ? 0 : 0.7);
    if (e.key === 'Escape') {
      if (placingGate) setPlacingGate(false);
      else if (placingXref) setPlacingXref(false);
      else if (placingPort) setPlacingPort(false);
      else if (placingAnn) setPlacingAnn(false);
      else if (placingDeco) { setPlacingDeco(null); setDecoDraft(null); decoDragRef.current = null; }
      else if (placingPower) setPlacingPower(null);
      else setSelection(null);
    }
    if (key === 'c') {
      if (tool === 'edit' && placeAllowed(useDocStore.getState().currentStep, 'gate')) setPlacingGate(true);
    }
    const nextTool = toolForKey(e);
    if (nextTool) setTool(nextTool);
    if (tool === 'zones' && zonesEditable && zoneSelected >= 0 && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      setZones((prev) => prev.filter((_, i) => i !== zoneSelected));
      setZoneSelected(-1);
    }
    if (key === 'h') setOverlaysVisible(!useDocStore.getState().overlaysVisible);
    if (key === 'k') {
      if (selection?.kind === 'gate' && canEditElement(useDocStore.getState().currentStep, 'gate', 'box')) {
        const idx = selection.idx;
        editPage((p) => {
          const g = p.gates[idx];
          if (g) g.verified = !g.verified;
        });
      }
    }
    // Usuwanie tylko elementów edytowalnych w bieżącym kroku (stepView.canEditElement).
    // Zaznaczenie drutów / odcinek / bez zaznaczenia → druty (zaznaczone, inaczej pod kursorem).
    const del = e.key === 'Delete' || e.key === 'Backspace';
    if (del && (!selection || selection.kind === 'segment' || selection.kind === 'net')) {
      if (wire.deleteFallback()) e.preventDefault();
    } else if (del && selection && canEditElement(useDocStore.getState().currentStep, selection.kind)) {
      if (tool === 'edit' && selection?.kind === 'gate') {
        const idx = selection.idx;
        editPage((p) => { p.gates.splice(idx, 1); });
        setSelection(null);
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
    if (chord === 'undo') {
      e.preventDefault();
      undo();
    }
    // Copy/paste annotation lub decoration (Ctrl+C / Ctrl+V)
    if (chord === 'copy' && page) {
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
    if (chord === 'paste' && tool === 'edit' && page) {
      const raw = localStorage.getItem('kronikarz:clip');
      if (raw) {
        try {
          const clip = JSON.parse(raw);
          // Wklejanie jak przyciski „+ …”: tylko rodzaje dozwolone w bieżącym kroku.
          if (!['annotation', 'decoration', 'gate'].includes(clip?.kind) || !placeAllowed(useDocStore.getState().currentStep, clip.kind)) return;
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
    if (chord === 'redo') {
      e.preventDefault();
      redo();
    }
  });

  // Keyboard + toolbar events. Registered once: onKeyDown is a useEvent
  // callback, the rest read live state (store getState, refs, setters).
  useEffect(() => {
    const editing = () => useDocStore.getState().tool === 'edit';
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    const onPlaceEvent = () => {
      if (editing()) setPlacingGate(true);
    };
    const onPlaceXrefEvent = () => {
      if (editing()) setPlacingXref(true);
    };
    const onPlacePortEvent = () => {
      if (editing()) setPlacingPort(true);
    };
    const onPlaceAnnEvent = () => {
      if (editing()) setPlacingAnn(true);
    };
    const onPlaceDecoEvent = (ev: Event) => {
      if (!editing()) return;
      const ce = ev as CustomEvent<{ kind: 'line' | 'rect' | 'ellipse' }>;
      setPlacingDeco(ce.detail?.kind ?? 'line');
    };
    const onPlacePowerEvent = (ev: Event) => {
      if (!editing()) return;
      const ce = ev as CustomEvent<{ type: string }>;
      setPlacingPower(ce.detail?.type ?? '+5V');
    };
    const onExportPng = (ev: Event) => {
      const stage = stageRef.current;
      const page = useDocStore.getState().page;
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', up);
    window.addEventListener('kronikarz:place-gate', onPlaceEvent);
    window.addEventListener('kronikarz:place-cross-ref', onPlaceXrefEvent);
    window.addEventListener('kronikarz:place-port', onPlacePortEvent);
    window.addEventListener('kronikarz:place-annotation', onPlaceAnnEvent);
    window.addEventListener('kronikarz:place-decoration', onPlaceDecoEvent as EventListener);
    window.addEventListener('kronikarz:place-power', onPlacePowerEvent as EventListener);
    window.addEventListener('kronikarz:export-png', onExportPng as EventListener);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', up);
      window.removeEventListener('kronikarz:place-gate', onPlaceEvent);
      window.removeEventListener('kronikarz:place-cross-ref', onPlaceXrefEvent);
      window.removeEventListener('kronikarz:place-port', onPlacePortEvent);
      window.removeEventListener('kronikarz:place-annotation', onPlaceAnnEvent);
      window.removeEventListener('kronikarz:place-decoration', onPlaceDecoEvent as EventListener);
      window.removeEventListener('kronikarz:place-power', onPlacePowerEvent as EventListener);
      window.removeEventListener('kronikarz:export-png', onExportPng as EventListener);
    };
  }, [onKeyDown]);

  // Zmiana kroku przerywa rozpoczęte wstawianie / rysowanie.
  const currentStep = useDocStore((s) => s.currentStep);
  useEffect(() => {
    setPlacingGate(false);
    setPlacingXref(false);
    setPlacingPort(false);
    setPlacingAnn(false);
    setPlacingDeco(null);
    setDecoDraft(null);
    setPlacingPower(null);
  }, [currentStep]);
  const lockMsg = useDocStore(lockReason);
  const lock = lockMsg !== null ? { reason: lockMsg } : null;

  // Kolejka przeglądu (ReviewPanel) przybliża element: 'kronikarz:zoom-to' {x,y,w,h}.
  const zoomToBox = useEvent((b: Box) => {
    const scale = Math.max(0.3, Math.min(2, Math.min(size.w / b.w, size.h / b.h) * 0.6));
    setView({ x: size.w / 2 - (b.x + b.w / 2) * scale, y: size.h / 2 - (b.y + b.h / 2) * scale, scale });
  });
  useEffect(() => {
    const on = (ev: Event) => zoomToBox((ev as CustomEvent<Box>).detail);
    window.addEventListener('kronikarz:zoom-to', on);
    return () => window.removeEventListener('kronikarz:zoom-to', on);
  }, [zoomToBox]);

  // Fit when another page is opened or the canvas is resized (not on edits).
  const pageId = page?.page;
  useEffect(() => {
    if (pageId !== undefined) fitToScreen();
  }, [pageId, size.w, size.h, fitToScreen]);

  // <page>.zones.yaml next to the file the page was loaded from: load on page
  // change; every zones change is reported, zonesSync decides what is saved.
  const zonesPath = pagePath ? zonesFilePath(pagePath) : null;
  useEffect(() => {
    zonesSyncRef.current!.open(zonesPath);
  }, [zonesPath]);

  useEffect(() => {
    zonesSyncRef.current!.changed(zonesPath, zones);
  }, [zones, zonesPath]);

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
    // The file the page was loaded from: fenced path and server page id must
    // be the same file the auto-save writes (not the YAML `page:` field).
    const target = pagePath ? parsePageFilePath(pagePath) : null;
    if (!page || !pagePath || !target || !zonesEditable || zones.length === 0) return;
    if (!confirm(`Vision-digitize z ${zones.length} strefami? Plik nadpisany (auto .bak).`)) return;
    setVisionBusy(true);
    const { pkg: pkgId, pageId } = target;
    try {
      // Rewrites the page server-side: flush (also lands pending zones saves),
      // fence the page, POST, reload. The server only rewrites the page yaml;
      // zones come from the POST body and <page>.zones.yaml is left as is, so
      // the zones stay saved and shown after the reload (no setZones([])).
      await runRewrite(pagePath, 'Vision', async () => {
        const { outcome, data: d } = await postRewrite('/vision-page-zones', { package: pkgId, page: pageId, zones });
        if (outcome !== 'ok') {
          alert('vision failed: ' + (d?.error ?? outcome) + (d?.stderr ? '\n\nstderr:\n' + String(d.stderr).slice(0, 1000) : ''));
          return outcome;
        }
        alert(
          `Wykryto:\n  ${d!.gates ?? 0} bramek\n  ${d!.ports ?? 0} portów\n  ${d!.cross_refs ?? 0} cross-refów\n\nBackup: <page>.sch.yaml.bak`
        );
        return outcome;
      });
    } finally {
      setVisionBusy(false);
    }
  }

  const placingAny = placingGate || placingXref || placingPort || placingAnn || !!placingDeco || !!placingPower;
  const onMouseDownStage = (e: Konva.KonvaEventObject<MouseEvent>): void => {
    wire.onMouseDown(e.evt);
    const bandTool = tool === 'select' || (tool === 'edit' && !placingAny);
    if (bandTool && e.evt.button === 0 && !e.evt.ctrlKey && !e.evt.metaKey && !spaceDown) {
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
      if (!zonesEditable) return; // zones of this page not loaded yet / load failed
      if (e.evt.button !== 0 || e.evt.ctrlKey || e.evt.metaKey) return;
      const p = ptrScan();
      if (!p) return;
      e.evt.preventDefault();
      zoneDragRef.current = { x0: p.x, y0: p.y };
      setZoneDraft({ role: 'gates', x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 });
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
    wire.onMouseMove(!!e?.evt?.shiftKey);
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

  const onMouseUpStage = async (e: Konva.KonvaEventObject<MouseEvent>): Promise<void> => {
    wire.onMouseUp(e.evt);
    if (selectDragRef.current && selectRect && page) {
      const r = selectRect;
      selectDragRef.current = null;
      setSelectRect(null);
      if (r.w < 4 || r.h < 4) return;
      // Priorytet: bramki, porty, odsyłacze — tylko edytowalne w bieżącym kroku; potem
      // druty (③ / bez kroku; Alt = dotknięte, Shift = przełącz) — stepView.bandSelection.
      const st = useDocStore.getState();
      const res = bandSelection(page, r, st.currentStep, { shift: e.evt.shiftKey, alt: e.evt.altKey }, st.wireSel);
      if ('wire' in res) st.setWireSel(res.wire);
      else setMulti(res.multi);
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
    // Server addresses the scan by the page file (pkg dir + stem), not `page:`.
    const target = pagePath ? parsePageFilePath(pagePath) : null;
    if (!r || r.w < 8 || r.h < 8 || !page || !target) return;
    setRoiBusy(true);
    try {
      const resp = await apiWrite('/ai-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: target.pkg, page: target.pageId, x: r.x, y: r.y, w: r.w, h: r.h }),
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

  // Scan of the file the page was loaded from (scans/<file stem>.jpg).
  const scanPath = page && pagePath ? scanFilePath(pagePath) : null;
  const scanUrl = scanPath ? `/files/${scanPath}` : null;

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
              <WireOverlay zoom={view.scale} />
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
                        if (e.evt.shiftKey && zonesEditable) {
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
      {lock && (
        <div className="absolute inset-0 z-10 flex items-start justify-center bg-bg-main/40 pt-16" data-testid="page-lock">
          <div className="flex items-center gap-2 border border-warning bg-bg-panel px-3 py-1 text-xs text-warning">
            ⏳ {lock.reason}
            {lock.reason !== LOCK_RUNNING && (
              <button onClick={() => window.location.reload()} className="border border-warning/60 px-1.5 text-text-main hover:bg-warning/20">
                przeładuj
              </button>
            )}
          </div>
        </div>
      )}
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
      <WireToast />
      {wire.hint && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          {wire.hint}
        </div>
      )}
      {tool === 'zones' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 border border-phosphor bg-bg-panel px-2 py-1 text-xs text-phosphor">
          <span>
            zones: {zones.length} · przeciągnij = nowa strefa · shift+klik = zmień rolę · Del = usuń
          </span>
          <button
            onClick={runVisionZones}
            disabled={visionBusy || !zonesEditable || zones.length === 0}
            className="ml-2 bg-phosphor-dim px-2 py-0.5 text-bg-main hover:bg-phosphor disabled:opacity-50"
          >
            {visionBusy ? '⏳ vision...' : '👁 vision (zones)'}
          </button>
          <button
            onClick={() => { setZones([]); setZoneSelected(-1); }}
            disabled={!zonesEditable || zones.length === 0}
            className="px-2 py-0.5 text-text-dim hover:text-phosphor disabled:opacity-50"
          >
            wyczyść
          </button>
          {zonesLoad.state === 'loading' && <span className="ml-2 text-text-dim">wczytywanie stref…</span>}
          {zonesLoad.state === 'error' && (
            <>
              <span className="ml-2 text-warning" title={zonesLoad.error ?? ''}>
                ⚠ nie wczytano stref ({zonesLoad.error}) — edycja stref zablokowana; ponów albo przeładuj stronę, by spróbować ponownie
              </span>
              <button
                onClick={() => zonesSyncRef.current!.open(zonesPath)}
                className="px-2 py-0.5 text-text-dim hover:text-phosphor"
              >
                ponów
              </button>
            </>
          )}
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
