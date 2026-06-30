'use client';

// Client component: configurable follow-up-reminder days (#58 v3).
// Loads current value from GET /api/dashboard/settings on mount,
// saves via POST on change/blur.

import { useEffect, useState } from 'react';

type SaveState = 'idle' | 'saving' | 'saved';

export function FollowUpDaysSetting() {
  const [days, setDays] = useState<number>(3);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    fetch('/api/dashboard/settings')
      .then((r) => r.json())
      .then((data: { followUpDays?: number }) => {
        if (typeof data.followUpDays === 'number') setDays(data.followUpDays);
      })
      .catch(() => {
        // fail-safe: keep default 3
      });
  }, []);

  async function save(value: number) {
    setSaveState('saving');
    try {
      await fetch('/api/dashboard/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followUpDays: value }),
      });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('idle');
    }
  }

  return (
    <div>
      <label className="block text-sm font-medium mb-1" style={{ color: 'var(--op-text)' }}>
        Follow-up reminder
      </label>
      <p className="text-xs mb-3" style={{ color: 'var(--op-text-2)' }}>
        Remind me to follow up after (days)
      </p>
      <div className="flex items-center gap-3">
        <input
          type="number"
          min={1}
          max={60}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          onBlur={(e) => {
            const v = Math.min(60, Math.max(1, Number(e.target.value) || 3));
            setDays(v);
            void save(v);
          }}
          className="w-20 border rounded px-2 py-1 text-sm"
          style={{
            borderColor: 'var(--op-border)',
            background: 'var(--op-bg)',
            color: 'var(--op-text)',
          }}
        />
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'saved' && 'Saved'}
        </span>
      </div>
    </div>
  );
}
