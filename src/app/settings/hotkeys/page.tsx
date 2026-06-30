'use client';

// Design-editor hotkeys (Settings → Hotkeys, #98). Per-account: stored on the
// operator's Supabase user (user_metadata) via /api/account/hotkeys, so the
// bindings follow them on any device. Click "Change", press a key combo; the
// editor reads these on its next mount. Ctrl and ⌘ Cmd are treated the same.

import { useCallback, useEffect, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import {
  KEY_ACTIONS,
  KEY_ACTION_BY_ID,
  DEFAULT_KEYMAP,
  comboToString,
  eventToCombo,
  findConflicts,
  normalizeKeymap,
  type KeyMap,
  type KeyActionId,
} from '@/components/design/editor-core/keymap';

type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

// Lone modifier presses aren't a binding on their own — wait for a real key.
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock']);

const sameCombos = (id: KeyActionId, km: KeyMap) =>
  JSON.stringify(km[id]) === JSON.stringify(DEFAULT_KEYMAP[id]);

export default function HotkeysSettingsPage() {
  const [keymap, setKeymap] = useState<KeyMap>(DEFAULT_KEYMAP);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [capturing, setCapturing] = useState<KeyActionId | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/account/hotkeys');
        if (!res.ok) throw new Error('load failed');
        const data = await res.json();
        if (alive) {
          setKeymap(normalizeKeymap(data.hotkeys));
          setStatus('idle');
        }
      } catch {
        // Not signed in (e.g. local dev with the gate dormant) or a transient
        // error — show the defaults; saving will surface the real error if any.
        if (alive) setStatus('idle');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // While a row is "capturing", the next real keypress becomes its binding.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIER_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = capturing;
      if (!id) return;
      if (e.key === 'Escape') {
        setCapturing(null); // Esc cancels the capture rather than binding itself
        return;
      }
      const combo = eventToCombo(e);
      setKeymap((km) => ({ ...km, [id]: [combo] }));
      setDirty(true);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true); // capture phase: beat other handlers
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  const save = useCallback(async () => {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch('/api/account/hotkeys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotkeys: keymap }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setKeymap(normalizeKeymap(data.hotkeys));
      setDirty(false);
      setStatus('saved');
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  }, [keymap]);

  const resetAll = () => {
    setKeymap(DEFAULT_KEYMAP);
    setDirty(true);
    setCapturing(null);
  };
  const resetOne = (id: KeyActionId) => {
    setKeymap((km) => ({ ...km, [id]: DEFAULT_KEYMAP[id] }));
    setDirty(true);
  };

  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="hotkeys" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Design editor hotkeys</h1>
          <p className="text-sm text-gray-500 mt-1">
            Your personal keyboard shortcuts for the design editor — they follow your login on any
            device. Click <span className="font-medium">Change</span> and press the key(s) you want.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white divide-y divide-gray-100">
          {KEY_ACTIONS.map((a) => {
            const combos = keymap[a.id] ?? DEFAULT_KEYMAP[a.id];
            const isCapturing = capturing === a.id;
            const conflicts = Array.from(
              new Set(combos.flatMap((c) => findConflicts(keymap, c, a.id))),
            );
            return (
              <div key={a.id} className="flex items-center gap-4 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <span className="block text-[15px] font-medium text-gray-900">{a.label}</span>
                  {conflicts.length > 0 && (
                    <span className="block text-xs text-amber-600 mt-0.5">
                      Also bound to {conflicts.map((id) => KEY_ACTION_BY_ID[id].label).join(', ')} — check this is intentional.
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isCapturing ? (
                    <span className="text-sm font-medium text-emerald-700">Press a key… (Esc cancels)</span>
                  ) : (
                    combos.map((c, i) => (
                      <kbd
                        key={i}
                        className="px-2 py-1 rounded border border-gray-300 bg-gray-50 text-xs font-mono text-gray-700"
                      >
                        {comboToString(c)}
                      </kbd>
                    ))
                  )}
                  {isCapturing ? (
                    <button
                      onClick={() => setCapturing(null)}
                      className="text-sm text-gray-500 hover:text-gray-700 px-2 py-1"
                    >
                      Cancel
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => setCapturing(a.id)}
                        className="text-sm font-medium text-emerald-700 hover:text-emerald-800 px-2 py-1"
                      >
                        Change
                      </button>
                      {!sameCombos(a.id, keymap) && (
                        <button
                          onClick={() => resetOne(a.id)}
                          className="text-xs text-gray-400 hover:text-gray-600 px-1"
                          title="Reset to default"
                        >
                          Reset
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            onClick={save}
            disabled={!dirty || status === 'saving' || status === 'loading'}
            className="bg-emerald-700 hover:bg-emerald-800 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2 rounded-md"
          >
            {status === 'saving' ? 'Saving…' : 'Save changes'}
          </button>
          <button onClick={resetAll} className="text-sm text-gray-600 hover:text-gray-800 px-3 py-2">
            Reset all to defaults
          </button>
          <span className="text-sm" aria-live="polite">
            {status === 'saved' && <span className="text-emerald-600">Saved</span>}
            {status === 'error' && <span className="text-red-600">{error ?? 'Something went wrong'}</span>}
            {dirty && status !== 'saving' && status !== 'error' && (
              <span className="text-gray-400">Unsaved changes</span>
            )}
          </span>
        </div>
        <p className="mt-3 text-xs text-gray-400">
          Changes apply the next time you open the design editor. Ctrl is treated the same as ⌘ Cmd.
        </p>
      </main>
    </OperatorShell>
  );
}
