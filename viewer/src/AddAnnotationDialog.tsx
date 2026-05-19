import { useState } from 'react';
import type { Annotation } from '@kronikarz/shared';
import { useDocStore } from './store.ts';

interface Props {
  x: number;
  y: number;
  onClose: () => void;
}

export function AddAnnotationDialog({ x, y, onClose }: Props): JSX.Element {
  const editPage = useDocStore((s) => s.editPage);
  const setSelection = useDocStore((s) => s.setSelection);
  const [text, setText] = useState('');
  const [fontSize, setFontSize] = useState('20');
  const [rotation, setRotation] = useState('0');

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!text.trim()) return;
    const fs = parseInt(fontSize, 10);
    const rot = parseInt(rotation, 10);
    const ann: Annotation = {
      text: text.trim(),
      x,
      y,
      fontSize: Number.isFinite(fs) ? fs : 20,
      rotation: Number.isFinite(rot) ? rot : 0,
    };
    let newIdx = -1;
    editPage((p) => {
      const arr = (p.annotations ??= []);
      arr.push(ann);
      newIdx = arr.length - 1;
    });
    if (newIdx >= 0) setSelection({ kind: 'annotation', idx: newIdx });
    onClose();
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-96 space-y-2 border border-phosphor bg-bg-panel p-3 text-xs"
      >
        <h2 className="font-bold text-phosphor">Nowy tekst @ {x},{y}</h2>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Schemat ideowy..."
          rows={3}
          className="w-full bg-bg-accent px-1 py-0.5 font-mono"
        />
        <div className="flex items-center gap-2">
          <label className="w-20 text-text-dim">fontSize</label>
          <input value={fontSize} onChange={(e) => setFontSize(e.target.value)} className="flex-1 bg-bg-accent px-1 py-0.5" />
        </div>
        <div className="flex items-center gap-2">
          <label className="w-20 text-text-dim">rotation</label>
          <select value={rotation} onChange={(e) => setRotation(e.target.value)} className="flex-1 bg-bg-accent px-1 py-0.5">
            <option value="0">0° (poziomo)</option>
            <option value="90">90° (pionowo, w dół)</option>
            <option value="180">180°</option>
            <option value="270">270° (pionowo, w górę)</option>
          </select>
        </div>
        <div className="flex gap-2 pt-1">
          <button type="submit" className="flex-1 bg-phosphor-dim px-2 py-1 text-bg-main hover:bg-phosphor">Dodaj</button>
          <button type="button" className="px-2 py-1 text-text-dim" onClick={onClose}>Anuluj</button>
        </div>
      </form>
    </div>
  );
}
