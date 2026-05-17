interface Props {
  onClose: () => void;
}

const KEYS: Array<[string, string]> = [
  ['V', 'tryb zaznacz'],
  ['E', 'tryb edycji'],
  ['K', 'toggle verified (zaznaczona bramka)'],
  ['Del / Backspace', 'usuń zaznaczoną bramkę (edit)'],
  ['Esc', 'odznacz'],
  ['Ctrl+Z / Ctrl+Y', 'undo / redo'],
  ['0 / 1 / 2', 'fit / 100% / 200% zoom'],
  ['[ / ] / \\', 'opacity skanu -/+ / toggle'],
  ['Space + drag', 'pan'],
  ['Two-finger swipe', 'pan (touchpad)'],
  ['Ctrl/⌘ + wheel / pinch', 'zoom'],
  ['Klik pusty obszar (edit)', 'dodaj bramkę'],
  ['Klik pin (edit) → klik pin', 'utwórz segment'],
  ['Klik segment', 'zaznacz segment (edit: drag końcówek)'],
  ['?', 'pokaż / ukryj tę pomoc'],
];

export function HelpOverlay({ onClose }: Props): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[36rem] max-w-[90vw] border border-phosphor bg-bg-panel p-4 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 font-bold text-phosphor">SKRÓTY</h2>
        <table className="w-full">
          <tbody>
            {KEYS.map(([k, v]) => (
              <tr key={k}>
                <td className="w-48 py-0.5 pr-3 text-phosphor">{k}</td>
                <td className="text-text-main">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="mt-3 text-text-dim hover:text-phosphor" onClick={onClose}>
          [zamknij]
        </button>
      </div>
    </div>
  );
}
