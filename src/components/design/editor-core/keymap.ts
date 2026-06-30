// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
//
// Canonical editor keyboard actions + their default bindings, a key-combo
// matcher, and combo<->string helpers. The keymap is DATA-DRIVEN so the action
// keys can be remapped (quote tool: Settings → Hotkeys, stored per-account).
// editor.ts + DesignEditor read these; pass no override and you get DEFAULT_KEYMAP
// (so the standalone design tool behaves exactly as before).

export type KeyActionId =
  | 'undo'
  | 'redo'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'cancel'
  | 'toggleDrawSelect'
  | 'fullscreen';

// 'core' actions are handled inside editor.ts's key handler; 'shell' actions
// (full screen) are handled by the React host (DesignEditor.tsx) — but both read
// the SAME keymap so a single Settings page configures everything.
export type KeyActionScope = 'core' | 'shell';

export type KeyCombo = {
  /** Single letters are lowercased ('z'); named keys keep their event value ('Delete', 'Backspace', 'Escape', 'Enter'). */
  key: string;
  /** Ctrl OR Cmd(meta) — treated together for cross-platform. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type KeyActionMeta = {
  id: KeyActionId;
  label: string;
  scope: KeyActionScope;
  /** One action may have several default combos (e.g. redo = Ctrl+Shift+Z AND Ctrl+Y). */
  defaults: KeyCombo[];
};

export const KEY_ACTIONS: KeyActionMeta[] = [
  { id: 'undo', label: 'Undo', scope: 'core', defaults: [{ key: 'z', ctrl: true }] },
  { id: 'redo', label: 'Redo', scope: 'core', defaults: [{ key: 'z', ctrl: true, shift: true }, { key: 'y', ctrl: true }] },
  { id: 'copy', label: 'Copy', scope: 'core', defaults: [{ key: 'c', ctrl: true }] },
  { id: 'paste', label: 'Paste', scope: 'core', defaults: [{ key: 'v', ctrl: true }] },
  { id: 'duplicate', label: 'Duplicate selection', scope: 'core', defaults: [{ key: 'd', ctrl: true }] },
  { id: 'delete', label: 'Delete selection', scope: 'core', defaults: [{ key: 'Delete' }, { key: 'Backspace' }] },
  { id: 'cancel', label: 'Cancel / clear selection', scope: 'core', defaults: [{ key: 'Escape' }] },
  { id: 'toggleDrawSelect', label: 'Toggle Draw / Select mode', scope: 'core', defaults: [{ key: 'q' }] },
  { id: 'fullscreen', label: 'Toggle full screen', scope: 'shell', defaults: [{ key: 'f' }] },
];

export const KEY_ACTION_BY_ID: Record<KeyActionId, KeyActionMeta> = Object.fromEntries(
  KEY_ACTIONS.map((a) => [a.id, a]),
) as Record<KeyActionId, KeyActionMeta>;

/** A full keymap: every action → its bound combos. */
export type KeyMap = Record<KeyActionId, KeyCombo[]>;

export const DEFAULT_KEYMAP: KeyMap = Object.fromEntries(
  KEY_ACTIONS.map((a) => [a.id, a.defaults]),
) as KeyMap;

/** A KeyboardEvent shape (kept structural so it's testable without a DOM). */
export type KeyEventLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/** Normalize an event/combo key to the canonical form (single letters lowercased). */
export function normalizeKey(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

export function eventToCombo(e: KeyEventLike): KeyCombo {
  return {
    key: normalizeKey(e.key),
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

export function comboMatches(e: KeyEventLike, combo: KeyCombo): boolean {
  return (
    normalizeKey(e.key) === normalizeKey(combo.key) &&
    (e.ctrlKey || e.metaKey) === !!combo.ctrl &&
    e.shiftKey === !!combo.shift &&
    e.altKey === !!combo.alt
  );
}

/**
 * Which action (if any) this event triggers under `keymap`. Pass `scope` to only
 * consider actions handled by that layer (editor.ts → 'core', shell → 'shell').
 * Falls back to a default action's combos if the keymap omits that action id.
 */
export function resolveAction(
  e: KeyEventLike,
  keymap: KeyMap = DEFAULT_KEYMAP,
  scope?: KeyActionScope,
): KeyActionId | null {
  for (const a of KEY_ACTIONS) {
    if (scope && a.scope !== scope) continue;
    const combos = keymap[a.id] ?? DEFAULT_KEYMAP[a.id];
    if (combos.some((c) => comboMatches(e, c))) return a.id;
  }
  return null;
}

/** Human-readable combo: "Ctrl+Shift+Z", "Q", "Delete". */
export function comboToString(c: KeyCombo): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.shift) parts.push('Shift');
  if (c.alt) parts.push('Alt');
  parts.push(c.key.length === 1 ? c.key.toUpperCase() : c.key);
  return parts.join('+');
}

function isValidCombo(c: unknown): c is KeyCombo {
  return !!c && typeof c === 'object' && typeof (c as { key?: unknown }).key === 'string' && (c as KeyCombo).key.length > 0;
}

/**
 * Validate + normalize a stored keymap into a full KeyMap: drops unknown action
 * ids and malformed combos, coerces modifier flags to booleans, lowercases
 * letter keys, and fills any missing/empty action with its defaults. This is the
 * trust boundary for stored (user-supplied) hotkeys — never assume the input is
 * well-formed.
 */
export function normalizeKeymap(partial: unknown): KeyMap {
  const src = (partial && typeof partial === 'object' ? partial : {}) as Record<string, unknown>;
  const out = {} as KeyMap;
  for (const a of KEY_ACTIONS) {
    const raw = src[a.id];
    const combos = Array.isArray(raw)
      ? raw.filter(isValidCombo).map((c) => ({
          key: normalizeKey(c.key),
          ...(c.ctrl ? { ctrl: true as const } : {}),
          ...(c.shift ? { shift: true as const } : {}),
          ...(c.alt ? { alt: true as const } : {}),
        }))
      : [];
    out[a.id] = combos.length > 0 ? combos : a.defaults;
  }
  return out;
}

/** Action ids that resolve to the same combo as `combo` (for conflict warnings). */
export function findConflicts(keymap: KeyMap, combo: KeyCombo, exceptId: KeyActionId): KeyActionId[] {
  const probe: KeyEventLike = {
    key: combo.key,
    ctrlKey: !!combo.ctrl,
    metaKey: false,
    shiftKey: !!combo.shift,
    altKey: !!combo.alt,
  };
  return KEY_ACTIONS.filter((a) => a.id !== exceptId)
    .filter((a) => (keymap[a.id] ?? DEFAULT_KEYMAP[a.id]).some((c) => comboMatches(probe, c)))
    .map((a) => a.id);
}
