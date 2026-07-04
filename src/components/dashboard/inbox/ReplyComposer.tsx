'use client';

import { useState } from 'react';

// Inline reply composer shared by the open-inbox list (InboxList) and the
// In-the-works rows (InWorksSection). Each mount is its own instance, so its
// draft/channel/busy state is per-row and resets when the composer is collapsed
// and re-opened. Both call sites resolve everything server-side from `itemId`;
// the only thing the UI needs is `source` (to gate the quotetool channel toggle
// and to keep gmail out — gmail inline-send is unsupported, so callers render a
// "Reply in Gmail" hint instead of mounting this).
export function ReplyComposer({
  itemId,
  source,
  channel,
  onSent,
}: {
  itemId: string;
  source: string;
  /** The item's last-known channel (e.g. 'sms' | 'email' | 'app'), when the
   *  caller has it — seeds the toggle's initial choice. Optional so callers
   *  that don't track it (InboxList) keep working unchanged. */
  channel?: string | null;
  onSent: () => void;
}) {
  const [draftText, setDraftText] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  // Seed from the item's known channel; anything other than an explicit 'sms'
  // (unknown, 'app', 'email', etc.) defaults to email, same as the server's
  // own default for a quote lead with no chosen channel (see reply.ts).
  const [replyChannel, setReplyChannel] = useState<'sms' | 'email'>(channel === 'sms' ? 'sms' : 'email');
  const [error, setError] = useState<string | null>(null);

  async function generateDraft() {
    setDraftBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId }),
      });
      const data = (await res.json()) as { ok?: boolean; draft?: string; error?: string };
      if (data.ok && data.draft) {
        setDraftText(data.draft);
      } else {
        setError(data.error ?? 'Failed to generate draft.');
      }
    } catch {
      setError('Network error generating draft.');
    } finally {
      setDraftBusy(false);
    }
  }

  async function send() {
    setSendBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId,
          text: draftText,
          channel: source === 'quotetool' ? replyChannel : undefined,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        onSent();
      } else {
        setError(data.error ?? 'Failed to send reply.');
      }
    } catch {
      setError('Network error sending reply.');
    } finally {
      setSendBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      {source === 'quotetool' && (
        <div className="flex gap-2">
          {(['email', 'sms'] as const).map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => setReplyChannel(ch)}
              className="px-3 py-1 rounded-md text-xs"
              style={{
                border: ch === replyChannel ? '2px solid var(--brand-evergreen)' : '1px solid var(--op-border)',
                color: 'var(--op-text)',
              }}
            >
              {ch === 'email' ? 'Email' : 'SMS'}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={draftBusy}
        onClick={generateDraft}
        className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
        style={{ border: '1px solid var(--op-border)', color: 'var(--op-text)' }}
      >
        {draftBusy ? 'Drafting…' : 'AI draft'}
      </button>
      <textarea
        value={draftText}
        onChange={(e) => setDraftText(e.target.value)}
        rows={4}
        placeholder="Type your reply…"
        className="w-full rounded-md p-2 text-sm resize-y"
        style={{ border: '1px solid var(--op-border)', color: 'var(--op-text)', background: 'var(--op-bg-raised)' }}
      />
      {error && <p className="text-xs" style={{ color: '#dc2626' }}>{error}</p>}
      <button
        type="button"
        disabled={!draftText.trim() || sendBusy}
        onClick={send}
        className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
      >
        {sendBusy ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}
