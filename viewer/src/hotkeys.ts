// Keyboard shortcut resolution for the page canvas (Canvas.tsx). Pure — no
// DOM, no store — so it is unit-tested (hotkeys.test.ts).
//
// Two kinds of shortcuts share the same letters: single-key hotkeys (V/E/R/W/Z
// tools, C place gate, H, K, 0/1/2) and Ctrl/Cmd chords (Ctrl+Z undo, Ctrl+C
// copy, Ctrl+V paste). A letter/digit hotkey must never fire while Ctrl, Cmd
// or Alt is held, otherwise Ctrl+Z both undoes and switches to the zones tool.
// Punctuation hotkeys ([ ] \ ?) are not blocked: on many layouts they are
// typed with AltGr (= Ctrl+Alt on Windows) or Option (Alt on macOS).
import type { Tool } from './store.ts';

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Ctrl, Cmd or Alt held — the key press is a chord, not a single-key hotkey. */
export function hasChordModifier(e: KeyLike): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}

/**
 * The key of a single-key hotkey press, letters lower-cased (Shift / Caps Lock
 * give the same hotkey). Null for a letter or digit typed with Ctrl/Cmd/Alt
 * (a chord, not a hotkey); other keys are returned as they are.
 */
export function plainKey(e: KeyLike): string | null {
  if (e.key.length !== 1) return e.key;
  if (/^[a-z0-9]$/i.test(e.key) && hasChordModifier(e)) return null;
  return e.key.toLowerCase();
}

const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  v: 'select',
  e: 'edit',
  r: 'roi',
  w: 'wire',
  z: 'zones',
};

/** Tool selected by a single-key hotkey (V/E/R/W/Z), or null (also for any chord). */
export function toolForKey(e: KeyLike): Tool | null {
  const k = plainKey(e);
  return k !== null && Object.hasOwn(TOOL_KEYS, k) ? TOOL_KEYS[k]! : null;
}

export type ChordAction = 'undo' | 'redo' | 'copy' | 'paste';

/**
 * Ctrl/Cmd chord: Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo, Ctrl+C copy,
 * Ctrl+V paste (copy/paste without Shift). Letters compared case-insensitively (macOS reports
 * Cmd+Shift+Z as key "z"). Null without Ctrl/Cmd.
 */
export function chordAction(e: KeyLike): ChordAction | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y') return 'redo';
  // Ctrl/Cmd+Shift+C / +V stay with the browser (DevTools inspect, paste plain).
  if (k === 'c' && !e.shiftKey) return 'copy';
  if (k === 'v' && !e.shiftKey) return 'paste';
  return null;
}
