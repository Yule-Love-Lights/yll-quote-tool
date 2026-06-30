import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEYMAP,
  KEY_ACTIONS,
  resolveAction,
  comboMatches,
  comboToString,
  normalizeKeymap,
  findConflicts,
  eventToCombo,
  type KeyEventLike,
  type KeyMap,
} from './keymap';

const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({
  key: 'a',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe('resolveAction (defaults)', () => {
  it('maps the core editing shortcuts', () => {
    expect(resolveAction(ev({ key: 'z', ctrlKey: true }))).toBe('undo');
    expect(resolveAction(ev({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(resolveAction(ev({ key: 'y', ctrlKey: true }))).toBe('redo');
    expect(resolveAction(ev({ key: 'c', ctrlKey: true }))).toBe('copy');
    expect(resolveAction(ev({ key: 'v', ctrlKey: true }))).toBe('paste');
    expect(resolveAction(ev({ key: 'd', ctrlKey: true }))).toBe('duplicate');
    expect(resolveAction(ev({ key: 'Delete' }))).toBe('delete');
    expect(resolveAction(ev({ key: 'Backspace' }))).toBe('delete');
    expect(resolveAction(ev({ key: 'Escape' }))).toBe('cancel');
    expect(resolveAction(ev({ key: 'q' }))).toBe('toggleDrawSelect');
    expect(resolveAction(ev({ key: 'f' }))).toBe('fullscreen');
  });

  it('treats Cmd (meta) the same as Ctrl (cross-platform)', () => {
    expect(resolveAction(ev({ key: 'z', metaKey: true }))).toBe('undo');
    expect(resolveAction(ev({ key: 'c', metaKey: true }))).toBe('copy');
  });

  it('is case-insensitive on letters (capitalized via Shift still resolves)', () => {
    expect(resolveAction(ev({ key: 'Z', ctrlKey: true }))).toBe('undo');
    expect(resolveAction(ev({ key: 'Q' }))).toBe('toggleDrawSelect');
  });

  it('does NOT fire a plain letter when a modifier is required, and vice-versa', () => {
    expect(resolveAction(ev({ key: 'z' }))).toBeNull(); // undo needs ctrl
    expect(resolveAction(ev({ key: 'q', ctrlKey: true }))).toBeNull(); // toggle is plain q
  });

  it('filters by scope', () => {
    expect(resolveAction(ev({ key: 'f' }), DEFAULT_KEYMAP, 'core')).toBeNull(); // fullscreen is shell
    expect(resolveAction(ev({ key: 'f' }), DEFAULT_KEYMAP, 'shell')).toBe('fullscreen');
    expect(resolveAction(ev({ key: 'z', ctrlKey: true }), DEFAULT_KEYMAP, 'shell')).toBeNull(); // undo is core
    expect(resolveAction(ev({ key: 'z', ctrlKey: true }), DEFAULT_KEYMAP, 'core')).toBe('undo');
  });
});

describe('resolveAction (remapped)', () => {
  it('honors an override keymap', () => {
    const km: KeyMap = { ...DEFAULT_KEYMAP, toggleDrawSelect: [{ key: 'w' }] };
    expect(resolveAction(ev({ key: 'w' }), km)).toBe('toggleDrawSelect');
    expect(resolveAction(ev({ key: 'q' }), km)).toBeNull(); // q no longer bound
  });
});

describe('comboMatches', () => {
  it('is strict about every modifier', () => {
    expect(comboMatches(ev({ key: 'z', ctrlKey: true }), { key: 'z', ctrl: true })).toBe(true);
    expect(comboMatches(ev({ key: 'z', ctrlKey: true, shiftKey: true }), { key: 'z', ctrl: true })).toBe(false);
    expect(comboMatches(ev({ key: 'z', ctrlKey: true, altKey: true }), { key: 'z', ctrl: true })).toBe(false);
  });
});

describe('comboToString', () => {
  it('formats combos for display', () => {
    expect(comboToString({ key: 'z', ctrl: true })).toBe('Ctrl+Z');
    expect(comboToString({ key: 'z', ctrl: true, shift: true })).toBe('Ctrl+Shift+Z');
    expect(comboToString({ key: 'q' })).toBe('Q');
    expect(comboToString({ key: 'Delete' })).toBe('Delete');
  });
});

describe('eventToCombo', () => {
  it('collapses meta into ctrl and lowercases letters', () => {
    expect(eventToCombo(ev({ key: 'C', metaKey: true }))).toEqual({ key: 'c', ctrl: true, shift: false, alt: false });
  });
});

describe('normalizeKeymap', () => {
  it('fills missing actions with defaults and keeps overrides', () => {
    const km = normalizeKeymap({ toggleDrawSelect: [{ key: 'W' }] });
    expect(km.toggleDrawSelect).toEqual([{ key: 'w' }]); // normalized lowercase
    expect(km.undo).toEqual(DEFAULT_KEYMAP.undo); // filled
    // every action present
    for (const a of KEY_ACTIONS) expect(km[a.id]).toBeTruthy();
  });

  it('falls back to defaults on null/empty', () => {
    expect(normalizeKeymap(null)).toEqual(DEFAULT_KEYMAP);
    expect(normalizeKeymap({ undo: [] }).undo).toEqual(DEFAULT_KEYMAP.undo);
  });
});

describe('findConflicts', () => {
  it('detects another action already bound to the same combo', () => {
    // bind paste's Ctrl+V onto a keymap, then ask if undo->Ctrl+V conflicts
    expect(findConflicts(DEFAULT_KEYMAP, { key: 'v', ctrl: true }, 'undo')).toContain('paste');
  });
  it('returns empty for a free combo', () => {
    expect(findConflicts(DEFAULT_KEYMAP, { key: 'k' }, 'undo')).toEqual([]);
  });
});
