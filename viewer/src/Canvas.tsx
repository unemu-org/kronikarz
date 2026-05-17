import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Rect } from 'react-konva';
import type Konva from 'konva';
import { useDocStore } from './store.ts';
import { ImageLayer } from './layers/ImageLayer.tsx';
import { GateLayer } from './layers/GateLayer.tsx';
import { PinLayer } from './layers/PinLayer.tsx';
import { NetLayer } from './layers/NetLayer.tsx';
import { PowerLayer } from './layers/PowerLayer.tsx';
import { CrossPageLayer } from './layers/CrossPageLayer.tsx';
import { AddGateDialog } from './AddGateDialog.tsx';

export function Canvas(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [addAt, setAddAt] = useState<{ x: number; y: number } | null>(null);
  const page = useDocStore((s) => s.page);
  const route = useDocStore((s) => s.route);
  const loading = useDocStore((s) => s.loading);
  const opacity = useDocStore((s) => s.scanOpacity);
  const setSelection = useDocStore((s) => s.setSelection);
  const setZoom = useDocStore((s) => s.setZoom);
  const setOpacity = useDocStore((s) => s.setScanOpacity);
  const setTool = useDocStore((s) => s.setTool);
  const editPage = useDocStore((s) => s.editPage);
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
      if (e.key === 'Escape') setSelection(null);
      if (e.key === 'v' || e.key === 'V') setTool('select');
      if (e.key === 'e' || e.key === 'E') setTool('edit');
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
          editPage((p) => {
            p.gates.splice(idx, 1);
          });
          setSelection(null);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        redo();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size.w, size.h, opacity, selection, tool]);

  useEffect(() => {
    if (page) fitToScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.page, size.w, size.h]);

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    // Ctrl/meta+wheel OR Chrome pinch-zoom on touchpad → zoom toward pointer.
    // Plain wheel / two-finger swipe → pan by delta.
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const stage = stageRef.current;
      if (!stage) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const oldScale = view.scale;
      // deltaY magnitudes vary across browsers/devices; scale factor exp-like
      const factor = Math.exp(-e.evt.deltaY * 0.01);
      const newScale = Math.max(0.05, Math.min(20, oldScale * factor));
      const mx = (pointer.x - view.x) / oldScale;
      const my = (pointer.y - view.y) / oldScale;
      setView({
        x: pointer.x - mx * newScale,
        y: pointer.y - my * newScale,
        scale: newScale,
      });
    } else {
      setView({
        x: view.x - e.evt.deltaX,
        y: view.y - e.evt.deltaY,
        scale: view.scale,
      });
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
        onClick={(e) => {
          if (e.target === e.target.getStage()) {
            setSelection(null);
            if (tool === 'edit' && page) {
              const stage = stageRef.current;
              const ptr = stage?.getPointerPosition();
              if (ptr) {
                const sx = Math.round((ptr.x - view.x) / view.scale);
                const sy = Math.round((ptr.y - view.y) / view.scale);
                if (sx >= 0 && sx <= page.scan_size[0] && sy >= 0 && sy <= page.scan_size[1]) {
                  setAddAt({ x: sx, y: sy });
                }
              }
            }
          }
        }}
        style={{ cursor: spaceDown ? 'grab' : 'default' }}
      >
        {scanUrl && page && (
          <ImageLayer
            src={scanUrl}
            width={page.scan_size[0]}
            height={page.scan_size[1]}
            opacity={opacity}
          />
        )}
        {page && (
          <>
            <NetLayer page={page} zoom={view.scale} />
            <GateLayer gates={page.gates} />
            <PinLayer gates={page.gates} />
            <PowerLayer power={page.power} zoom={view.scale} />
            <CrossPageLayer page={page} zoom={view.scale} />
            <Layer listening={false}>
              <Rect
                x={0}
                y={0}
                width={page.scan_size[0]}
                height={page.scan_size[1]}
                stroke="#1a7a0a"
                strokeWidth={1 / view.scale}
              />
            </Layer>
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
      {addAt && (
        <AddGateDialog x={addAt.x} y={addAt.y} onClose={() => setAddAt(null)} />
      )}
    </div>
  );
}

function getScanPath(page: { package: string; page: string }, pkg: string): string {
  // Page.scan path stored relative to package dir; reconstruct
  return `scans/${page.page}.jpg`;
}
