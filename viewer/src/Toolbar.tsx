import { useEffect, useState } from 'react';
import { useDocStore } from './store.ts';
import { navigate } from './router.ts';

export function Toolbar(): JSX.Element {
  const route = useDocStore((s) => s.route);
  const project = useDocStore((s) => s.project);
  const pkg = useDocStore((s) => s.pkg);
  const opacity = useDocStore((s) => s.scanOpacity);
  const setOpacity = useDocStore((s) => s.setScanOpacity);
  const zoom = useDocStore((s) => s.zoom);
  const tool = useDocStore((s) => s.tool);
  const setTool = useDocStore((s) => s.setTool);
  const overlaysVisible = useDocStore((s) => s.overlaysVisible);
  const setOverlaysVisible = useDocStore((s) => s.setOverlaysVisible);
  const wireOrtho = useDocStore((s) => s.wireOrtho);
  const setWireOrtho = useDocStore((s) => s.setWireOrtho);
  const multi = useDocStore((s) => s.multi);
  const setMulti = useDocStore((s) => s.setMulti);
  const editPage = useDocStore((s) => s.editPage);
  const page = useDocStore((s) => s.page);
  const [visionBusy, setVisionBusy] = useState(false);

  async function visionPage() {
    if (!page || !route.pkg) return;
    if (!confirm(
      `Vision-digitize strony ${page.page}? ` +
      `Plik zostanie nadpisany (auto .bak przed). Trwa ~30-60s.`
    )) return;
    setVisionBusy(true);
    try {
      const r = await fetch('/vision-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: route.pkg, page: page.page }),
      });
      const d = await r.json();
      if (!r.ok) {
        alert('vision failed: ' + (d.error ?? r.statusText) + (d.stderr ? '\n\nstderr:\n' + d.stderr.slice(0, 1000) : ''));
        return;
      }
      alert(
        `Wykryto:\n` +
        `  ${d.gates} bramek\n` +
        `  ${d.ports} portów\n` +
        `  ${d.cross_refs} cross-refów\n` +
        `  ${d.power} symboli zasilania\n\n` +
        `Backup: <page>.sch.yaml.bak · Restore: "↶ restore .bak"`
      );
      window.location.reload();
    } finally {
      setVisionBusy(false);
    }
  }

  async function makeBak() {
    if (!page || !route.pkg) return;
    const r = await fetch('/make-bak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: route.pkg, page: page.page }),
    });
    const d = await r.json();
    if (!r.ok) { alert('backup failed: ' + (d.error ?? r.statusText)); return; }
    alert(`Backup zapisany: ${d.bak}`);
  }

  async function restoreBak() {
    if (!page || !route.pkg) return;
    if (!confirm('Przywrócić ostatni .bak? Aktualne zmiany zostaną nadpisane.')) return;
    const r = await fetch('/restore-bak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: route.pkg, page: page.page }),
    });
    const d = await r.json();
    if (!r.ok) { alert('restore failed: ' + (d.error ?? r.statusText)); return; }
    window.location.reload();
  }
  const [yoloTotal, setYoloTotal] = useState<number | null>(null);

  type Item = { i: number; x: number; y: number };

  function getItems(): Item[] {
    if (!page || !multi) return [];
    if (multi.kind === 'port') {
      return multi.indices
        .map((i) => { const p = page.ports?.[i]; return p ? { i, x: p.x, y: p.y } : null; })
        .filter((x): x is Item => !!x);
    }
    if (multi.kind === 'cross_ref') {
      return multi.indices
        .map((i) => { const r = page.cross_refs?.[i]; return r ? { i, x: r.x, y: r.y } : null; })
        .filter((x): x is Item => !!x);
    }
    return multi.indices
      .map((i) => { const g = page.gates[i]; return g ? { i, x: g.x, y: g.y } : null; })
      .filter((x): x is Item => !!x);
  }

  function applyXY(updates: Map<number, { x?: number; y?: number }>): void {
    if (!multi) return;
    editPage((pg) => {
      for (const [i, u] of updates) {
        const obj =
          multi.kind === 'port' ? pg.ports?.[i] :
          multi.kind === 'cross_ref' ? pg.cross_refs?.[i] :
          pg.gates[i];
        if (!obj) continue;
        if (u.x !== undefined) obj.x = u.x;
        if (u.y !== undefined) obj.y = u.y;
      }
    });
  }

  function alignMulti(mode: 'left' | 'right' | 'top' | 'bottom' | 'cx' | 'cy'): void {
    const items = getItems();
    if (items.length < 2) return;
    let target: number;
    if (mode === 'left') target = Math.min(...items.map((p) => p.x));
    else if (mode === 'right') target = Math.max(...items.map((p) => p.x));
    else if (mode === 'top') target = Math.min(...items.map((p) => p.y));
    else if (mode === 'bottom') target = Math.max(...items.map((p) => p.y));
    else if (mode === 'cx') target = Math.round(items.reduce((s, p) => s + p.x, 0) / items.length);
    else target = Math.round(items.reduce((s, p) => s + p.y, 0) / items.length);
    const updates = new Map<number, { x?: number; y?: number }>();
    for (const it of items) {
      if (mode === 'left' || mode === 'right' || mode === 'cx') updates.set(it.i, { x: target });
      else updates.set(it.i, { y: target });
    }
    applyXY(updates);
  }

  function cleanupNets(): void {
    if (!page) return;
    // Count endpoints per net name across pins/ports/cross_refs.
    const usage = new Map<string, number>();
    const bump = (n: string | null | undefined) => {
      if (!n || !n.trim()) return;
      usage.set(n, (usage.get(n) ?? 0) + 1);
    };
    for (const g of page.gates) for (const pin of g.pins) bump(pin.net);
    for (const port of page.ports ?? []) bump(port.net);
    for (const cr of page.cross_refs ?? []) bump(cr.net);

    const orphans = new Set<string>();
    for (const [n, count] of usage) {
      if (count <= 1) orphans.add(n);
    }
    // Also: nets in page.nets that nobody references
    const unused = new Set<string>();
    for (const n of Object.keys(page.nets)) {
      if (!usage.has(n)) unused.add(n);
    }

    const totalAffected = orphans.size + unused.size;
    if (!totalAffected) {
      alert('Brak nets do wyczyszczenia.');
      return;
    }
    if (!confirm(
      `Wyczyścić:\n` +
      `  ${orphans.size} sieci z ≤1 endpointem (pin/port/xref dostanie net="")\n` +
      `  ${unused.size} sieci w page.nets bez referencji\n` +
      `Razem ${totalAffected}.`
    )) return;

    editPage((p) => {
      for (const g of p.gates) for (const pin of g.pins) if (orphans.has(pin.net)) pin.net = '';
      for (const port of p.ports ?? []) if (orphans.has(port.net)) port.net = '';
      for (const cr of p.cross_refs ?? []) if (orphans.has(cr.net)) cr.net = '';
      for (const n of orphans) delete p.nets[n];
      for (const n of unused) delete p.nets[n];
      // Drop orphan junctions — te ktore nie leza na zadnym segmencie netu
      for (const net of Object.values(p.nets)) {
        if (!net.junctions || net.junctions.length === 0) continue;
        const segs = net.segments ?? [];
        if (segs.length === 0) { net.junctions = null; continue; }
        const kept = net.junctions.filter(([jx, jy]) => {
          for (const s of segs) {
            if ((s[0] === jx && s[1] === jy) || (s[2] === jx && s[3] === jy)) return true;
            if (s[1] === s[3] && jy === s[1] && jx >= Math.min(s[0], s[2]) && jx <= Math.max(s[0], s[2])) return true;
            if (s[0] === s[2] && jx === s[0] && jy >= Math.min(s[1], s[3]) && jy <= Math.max(s[1], s[3])) return true;
          }
          return false;
        });
        net.junctions = kept.length > 0 ? kept : null;
      }
    });
  }

  function stackColumn(): void {
    if (!page || !multi || multi.kind !== 'gate' || multi.indices.length < 2) return;
    const gates = multi.indices
      .map((i) => ({ i, g: page.gates[i] }))
      .filter((x): x is { i: number; g: NonNullable<(typeof page)['gates'][number]> } => !!x.g);
    if (gates.length < 2) return;
    // Same width: max
    const maxW = Math.max(...gates.map(({ g }) => g.w ?? 80));
    // Same x: mean
    const meanX = Math.round(gates.reduce((s, { g }) => s + g.x, 0) / gates.length);
    // Sort by current y ascending, stack: top of next = bottom of prev
    gates.sort((a, b) => a.g.y - b.g.y);
    const firstH = gates[0]!.g.h ?? 110;
    let cursorTop = gates[0]!.g.y - firstH / 2;
    editPage((p) => {
      for (const { i, g } of gates) {
        const target = p.gates[i];
        if (!target) continue;
        const h = g.h ?? 110;
        target.w = maxW;
        target.x = meanX;
        target.y = Math.round(cursorTop + h / 2);
        cursorTop += h;
      }
    });
  }

  function distributeMulti(axis: 'x' | 'y'): void {
    const items = getItems();
    if (items.length < 3) return;
    items.sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y));
    const first = axis === 'x' ? items[0]!.x : items[0]!.y;
    const last = axis === 'x' ? items[items.length - 1]!.x : items[items.length - 1]!.y;
    const step = (last - first) / (items.length - 1);
    const updates = new Map<number, { x?: number; y?: number }>();
    items.forEach((it, k) => {
      const v = Math.round(first + step * k);
      updates.set(it.i, axis === 'x' ? { x: v } : { y: v });
    });
    applyXY(updates);
  }

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const r = await fetch('/yolo-stats');
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled) setYoloTotal(d.total ?? 0);
      } catch {
        // ignore
      }
    }
    refresh();
    const t = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <div className="flex flex-col border-b border-bg-accent bg-bg-panel text-xs">
      {/* Row 1: navigation + tools + add */}
      <header className="flex items-center gap-3 px-3 py-1.5">
        <button
          onClick={() => navigate({ mode: 'module' })}
          className="font-bold text-phosphor hover:text-phosphor-dim"
        >
          ☰ KRONIKARZ
        </button>
        {project && route.mode !== 'module' && (
          <select
            value={route.pkg ?? ''}
            onChange={(e) => navigate({ mode: 'package', pkg: e.target.value })}
            className="bg-bg-accent px-2 py-0.5 border border-bg-accent text-text-main"
          >
            <option value="">— pakiet —</option>
            {project.packages.map((p) => (
              <option key={p.id} value={p.id}>{p.id}</option>
            ))}
          </select>
        )}
        {pkg && route.mode === 'page' && (
          <select
            value={route.page ?? ''}
            onChange={(e) => navigate({ mode: 'page', pkg: route.pkg, page: e.target.value })}
            className="bg-bg-accent px-2 py-0.5 border border-bg-accent text-text-main"
          >
            {pkg.package.pages.map((p) => (
              <option key={p.id} value={p.id}>{p.id}</option>
            ))}
          </select>
        )}
        <div className="ml-2 flex items-center gap-1 border-l border-bg-accent pl-3">
          <button onClick={() => setTool('select')} className={`px-2 py-0.5 ${tool === 'select' ? 'bg-phosphor-dim text-bg-main' : 'text-text-dim'}`} title="V — zaznacz">V</button>
          <button onClick={() => setTool('edit')} className={`px-2 py-0.5 ${tool === 'edit' ? 'bg-phosphor-dim text-bg-main' : 'text-text-dim'}`} title="E — edytuj">E</button>
          <button onClick={() => setTool('roi')} className={`px-2 py-0.5 ${tool === 'roi' ? 'bg-phosphor-dim text-bg-main' : 'text-text-dim'}`} title="R — ROI: AI wykrywa">R (AI)</button>
          <button onClick={() => setTool('wire')} className={`px-2 py-0.5 ${tool === 'wire' ? 'bg-phosphor-dim text-bg-main' : 'text-text-dim'}`} title="W — rysuj ścieżkę">W (wire)</button>
          <button onClick={() => setTool('zones')} className={`px-2 py-0.5 ${tool === 'zones' ? 'bg-phosphor-dim text-bg-main' : 'text-text-dim'}`} title="Z — strefy dla vision AI">Z (zones)</button>
          {tool === 'wire' && (
            <button onClick={() => setWireOrtho(!wireOrtho)} className={`px-2 py-0.5 ${wireOrtho ? 'bg-phosphor-dim text-bg-main' : 'text-text-dim'}`} title="ortho ↔ freeform (Shift = chwilowo freeform)">
              {wireOrtho ? '⌐ ortho' : '↗ freeform'}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 border-l border-bg-accent pl-3">
          <button
            disabled={tool !== 'edit'}
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:place-gate'))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor disabled:hover:bg-transparent disabled:hover:text-text-dim"
            title="C — dodaj bramkę"
          >+ bramka (C)</button>
          <button
            disabled={tool !== 'edit'}
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:place-cross-ref'))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor disabled:hover:bg-transparent disabled:hover:text-text-dim"
            title="dodaj cross-ref"
          >+ xref</button>
          <button
            disabled={tool !== 'edit'}
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:place-port'))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor disabled:hover:bg-transparent disabled:hover:text-text-dim"
            title="dodaj port (chevron < >)"
          >+ port</button>
          <button
            disabled={tool !== 'edit'}
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:place-annotation'))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor disabled:hover:bg-transparent disabled:hover:text-text-dim"
            title="dodaj tekst/adnotację"
          >+ tekst</button>
          <button
            disabled={tool !== 'edit'}
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:place-decoration', { detail: { kind: 'line' } }))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor disabled:hover:bg-transparent disabled:hover:text-text-dim"
            title="narysuj linię (drag)"
          >+ linia</button>
          <button
            disabled={tool !== 'edit'}
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:place-decoration', { detail: { kind: 'rect' } }))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor disabled:hover:bg-transparent disabled:hover:text-text-dim"
            title="narysuj prostokąt (drag)"
          >+ rect</button>
          <button
            disabled={tool !== 'edit'}
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:place-decoration', { detail: { kind: 'ellipse' } }))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor disabled:hover:bg-transparent disabled:hover:text-text-dim"
            title="narysuj koło (drag)"
          >+ koło</button>
        </div>
        {multi && multi.indices.length >= 2 && (
          <div className="ml-auto flex items-center gap-1 border-l border-bg-accent pl-3">
            <span className="text-text-dim">align {multi.kind} ×{multi.indices.length}:</span>
            <button onClick={() => alignMulti('left')} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="align left">⇤</button>
            <button onClick={() => alignMulti('cx')} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="align center X">⇔</button>
            <button onClick={() => alignMulti('right')} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="align right">⇥</button>
            <button onClick={() => alignMulti('top')} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="align top">⤒</button>
            <button onClick={() => alignMulti('cy')} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="align center Y">⇕</button>
            <button onClick={() => alignMulti('bottom')} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="align bottom">⤓</button>
            {multi.indices.length >= 3 && (
              <>
                <button onClick={() => distributeMulti('x')} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="distribute X">≡x</button>
                <button onClick={() => distributeMulti('y')} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="distribute Y">≡y</button>
              </>
            )}
            {multi.kind === 'gate' && multi.indices.length >= 2 && (
              <button onClick={stackColumn} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="standaryzuj kolumnę: ta sama szerokość, środek X, stykające się góra-dół">
                📚 stack
              </button>
            )}
            <button onClick={() => setMulti(null)} className="px-1.5 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor" title="wyczyść">✕</button>
          </div>
        )}
      </header>

      {/* Row 2: view + dataset + utilities */}
      <header className="flex items-center gap-3 border-t border-bg-accent px-3 py-1">
        <button
          onClick={() => setOverlaysVisible(!overlaysVisible)}
          className={`px-2 py-0.5 ${overlaysVisible ? 'text-text-dim hover:bg-bg-accent hover:text-phosphor' : 'bg-phosphor-dim text-bg-main'}`}
          title="H — toggle overlays"
        >
          {overlaysVisible ? '👁 hide (H)' : '🙈 show (H)'}
        </button>
        <span className="text-text-dim">zoom: {Math.round(zoom * 100)}%</span>
        <div className="flex items-center gap-2">
          <span className="text-text-dim">opacity:</span>
          <input type="range" min={0} max={100} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} className="w-24" />
          <span className="w-8 text-text-dim">{Math.round(opacity * 100)}%</span>
        </div>
        <div className="ml-auto flex items-center gap-3 border-l border-bg-accent pl-3">
          {yoloTotal !== null && (
            <span className="text-text-dim" title="sample YOLO">📦 {yoloTotal}</span>
          )}
          <button
            onClick={async () => {
              if (!confirm('Regenerate YOLO dataset z YAMLi? Nadpisuje samples.')) return;
              const r = await fetch('/yolo-export', { method: 'POST' });
              const d = await r.json();
              if (!r.ok) { alert('export failed: ' + (d.error ?? r.statusText)); return; }
              alert(`Exported: ${d.total} bboxes (${d.gates} gates, ${d.ports} ports, ${d.cross_refs} xrefs, ${d.power} power) across ${d.pages} pages. Skipped ${d.skipped_gates}.`);
            }}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor"
            title="Eksport YOLO"
          >⤓ export</button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:export-png', { detail: { pixelRatio: 3, withScan: true } }))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor"
            title="eksport PNG (skan + overlay, pixelRatio 3)"
          >📷 png</button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('kronikarz:export-png', { detail: { pixelRatio: 3, withScan: false } }))}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor"
            title="eksport PNG (sam overlay bez skanu, przezroczyste tło)"
          >📷 png bare</button>
          <button
            onClick={cleanupNets}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor"
            title="Usuń orphan nets"
          >🧹 cleanup nets</button>
          <button
            onClick={visionPage}
            disabled={visionBusy}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor disabled:opacity-50"
            title="Vision-digitize: Claude wykrywa bramki/porty/cross-refy ze skanu"
          >{visionBusy ? '⏳ vision...' : '👁 vision'}</button>
          <button
            onClick={makeBak}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor"
            title="Zrób kopię zapasową .bak (+ timestamped)"
          >💾 make .bak</button>
          <button
            onClick={restoreBak}
            className="px-2 py-0.5 text-text-dim hover:bg-bg-accent hover:text-phosphor"
            title="Przywróć ostatni backup .bak"
          >↶ restore .bak</button>
        </div>
      </header>
    </div>
  );
}
