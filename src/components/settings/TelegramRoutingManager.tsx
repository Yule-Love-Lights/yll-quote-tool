'use client';

// Client form for Settings → Telegram (audience-routing seam). Fetches the
// env-allowlisted chats + stored routing from /api/settings/telegram-routing,
// lets staff check off which chats get which notification audience, and saves
// back. `audiences`/`labels` come in as props from the server page component —
// this file must NOT import telegramRouting.ts at runtime (it pulls in the
// service-role Supabase client, which has no business in a client bundle; type
// imports are erased at compile time and stay safe).

import { useCallback, useEffect, useState } from 'react';
import type { TelegramAudience, TelegramRouting } from '@/lib/integrations/telegramRouting';

type ChatRow = { id: string; title: string | null };
type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

// First-run draft: every chat checked for every audience — the exact behavior
// the legacy broadcast has TODAY, so a curious owner who opens this page and
// hits Save without touching a checkbox changes nothing (an all-empty first
// draft made one accidental Save a total notification blackout — S49 admin-lens
// HIGH). Staff then UNCHECK what a chat shouldn't get, which is the actual task.
function broadcastRouting(
  audiences: readonly TelegramAudience[],
  chats: ChatRow[],
): TelegramRouting {
  const all = chats.map((c) => c.id);
  return Object.fromEntries(audiences.map((a) => [a, [...all]])) as TelegramRouting;
}

export function TelegramRoutingManager({
  audiences,
  labels,
}: {
  audiences: readonly TelegramAudience[];
  labels: Record<TelegramAudience, string>;
}) {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState<TelegramRouting | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch('/api/settings/telegram-routing');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const loadedChats: ChatRow[] = data.chats ?? [];
      setChats(loadedChats);
      setDraft(data.routing ?? broadcastRouting(audiences, loadedChats));
      setStatus('idle');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Telegram chats');
      setStatus('error');
    }
  }, [audiences]);

  useEffect(() => {
    // Defer so load()'s synchronous loading-state update isn't dispatched
    // within the effect body (mirrors BotTeamManager / AccountsManager).
    queueMicrotask(load);
  }, [load]);

  const toggle = (audience: TelegramAudience, chatId: string) => {
    setDraft((d) => {
      if (!d) return d;
      const on = d[audience].includes(chatId);
      return { ...d, [audience]: on ? d[audience].filter((id) => id !== chatId) : [...d[audience], chatId] };
    });
  };

  const save = async () => {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch('/api/settings/telegram-routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      setDraft(data as TelegramRouting);
      setStatus('saved');
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  };

  // Chats actually assigned that are still in the live allowlist — mirrors
  // chatsForAudience()'s intersection, so the warning reflects reality even if
  // the env allowlist shrank since the routing was last saved.
  const liveAssignedCount = (audience: TelegramAudience) =>
    (draft?.[audience] ?? []).filter((id) => chats.some((c) => c.id === id)).length;

  if (status === 'loading' || !draft) {
    return <p className="text-sm text-gray-500 py-10 text-center">Loading Telegram chats…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-gray-500 leading-relaxed rounded-md border border-gray-200 bg-gray-50 p-3">
        Until a routing is saved, every chat receives every notification — and the boxes below start
        fully checked to match that, so saving without changes changes nothing. Once saved, each
        notification type goes only to its checked chats — a type with no chats checked sends nothing.
        Uncheck what a chat shouldn&apos;t get, then save.
      </p>

      <div aria-live="polite" className="min-h-[1.25rem] text-sm">
        {error && <span className="text-red-600">{error}</span>}
        {!error && status === 'saved' && <span className="text-emerald-600">Saved.</span>}
      </div>

      {chats.length === 0 ? (
        <p className="text-sm text-gray-500">No chats in TELEGRAM_ALLOWED_CHATS yet.</p>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="px-4 py-2.5 font-medium">Chat</th>
                {audiences.map((a) => (
                  <th key={a} className="px-4 py-2.5 font-medium text-center whitespace-nowrap">
                    {labels[a]}
                    {liveAssignedCount(a) === 0 && (
                      <span
                        className="ml-1 text-amber-600"
                        title={`No chats assigned to ${labels[a]} — once saved, this notification type sends nothing`}
                      >
                        ⚠
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chats.map((c) => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-4 py-2.5 text-gray-900">
                    {c.title ?? <span className="text-gray-400">Unnamed chat</span>}
                    <span className="block text-gray-400 font-mono text-[11px]">{c.id}</span>
                  </td>
                  {audiences.map((a) => (
                    <td key={a} className="px-4 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={draft[a].includes(c.id)}
                        onChange={() => toggle(a, c.id)}
                        disabled={status === 'saving'}
                        aria-label={`${labels[a]} — ${c.title ?? c.id}`}
                        className="h-4 w-4 accent-emerald-700 disabled:cursor-not-allowed"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={save}
          disabled={status === 'saving' || chats.length === 0}
          className="inline-flex items-center rounded-full bg-emerald-700 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {status === 'saving' ? 'Saving…' : 'Save routing'}
        </button>
      </div>
    </div>
  );
}
