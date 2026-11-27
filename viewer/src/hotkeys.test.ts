// Run: npm test -w viewer (node --test --experimental-strip-types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chordAction, plainKey, toolForKey, type KeyLike } from './hotkeys.ts';

const key = (k: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const CHORDS: Array<Partial<Omit<KeyLike, 'key'>>> = [
  { ctrlKey: true },
  { metaKey: true },
  { altKey: true },
  { ctrlKey: true, shiftKey: true },
  { metaKey: true, shiftKey: true },
];

test('toolForKey: V/E/R/W/Z select tools, Shift/Caps Lock too', () => {
  assert.equal(toolForKey(key('v')), 'select');
  assert.equal(toolForKey(key('e')), 'edit');
  assert.equal(toolForKey(key('r')), 'roi');
  assert.equal(toolForKey(key('w')), 'wire');
  assert.equal(toolForKey(key('z')), 'zones');
  assert.equal(toolForKey(key('Z', { shiftKey: true })), 'zones');
  assert.equal(toolForKey(key('V')), 'select');
  assert.equal(toolForKey(key('c')), null);
  assert.equal(toolForKey(key('Escape')), null);
  assert.equal(toolForKey(key('constructor')), null);
});

test('toolForKey: never a tool with Ctrl/Cmd/Alt held (Ctrl+Z, Cmd+V, …)', () => {
  for (const mods of CHORDS) {
    for (const k of ['v', 'e', 'r', 'w', 'z', 'V', 'Z']) {
      assert.equal(toolForKey(key(k, mods)), null, `${k} ${JSON.stringify(mods)}`);
    }
  }
});

test('plainKey: letters/digits with Ctrl/Cmd/Alt are chords (null)', () => {
  assert.equal(plainKey(key('c')), 'c');
  assert.equal(plainKey(key('C', { shiftKey: true })), 'c');
  assert.equal(plainKey(key('0')), '0');
  for (const mods of CHORDS) {
    for (const k of ['c', 'C', 'h', 'k', '0', '1', '2']) {
      assert.equal(plainKey(key(k, mods)), null, `${k} ${JSON.stringify(mods)}`);
    }
  }
});

test('plainKey: punctuation passes with AltGr/Option (layout-dependent)', () => {
  assert.equal(plainKey(key('[')), '[');
  assert.equal(plainKey(key('[', { ctrlKey: true, altKey: true })), '['); // AltGr on Windows
  assert.equal(plainKey(key(']', { altKey: true })), ']'); // Option on macOS
  assert.equal(plainKey(key('\\', { altKey: true, shiftKey: true })), '\\');
  assert.equal(plainKey(key('Escape', { ctrlKey: true })), 'Escape');
});

test('chordAction: undo/redo/copy/paste only with Ctrl or Cmd', () => {
  assert.equal(chordAction(key('z', { ctrlKey: true })), 'undo');
  assert.equal(chordAction(key('z', { metaKey: true })), 'undo');
  assert.equal(chordAction(key('Z', { ctrlKey: true, shiftKey: true })), 'redo');
  assert.equal(chordAction(key('z', { metaKey: true, shiftKey: true })), 'redo'); // macOS reports "z"
  assert.equal(chordAction(key('y', { ctrlKey: true })), 'redo');
  assert.equal(chordAction(key('c', { ctrlKey: true })), 'copy');
  assert.equal(chordAction(key('v', { metaKey: true })), 'paste');
  assert.equal(chordAction(key('C', { ctrlKey: true, shiftKey: true })), null); // DevTools inspect
  assert.equal(chordAction(key('c', { metaKey: true, shiftKey: true })), null);
  assert.equal(chordAction(key('V', { ctrlKey: true, shiftKey: true })), null);
  assert.equal(chordAction(key('z')), null);
  assert.equal(chordAction(key('v', { altKey: true })), null);
  assert.equal(chordAction(key('x', { ctrlKey: true })), null);
});
