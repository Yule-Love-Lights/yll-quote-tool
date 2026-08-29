'use client';

import { useState } from 'react';

/**
 * Mint one crew member's My Day link and put it where a staffer can send it.
 *
 * Deliberately shows the URL as selectable text as well as offering the copy
 * button: the clipboard API needs a secure context and a permission a locked-
 * down browser can refuse, and a staffer who cannot copy still needs the link.
 */
export function CrewLinkButton({ crewMemberId, displayName }: { crewMemberId: string; displayName: string }) {
  const [state, setState] = useState<'idle' | 'working'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setState('working');
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/admin/crew/${crewMemberId}/link`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not make a link.');
        setUrl(null);
      } else {
        setUrl(body.url as string);
      }
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setState('idle');
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('Copying is blocked in this browser. Select the link above and copy it by hand.');
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={mint}
        disabled={state === 'working'}
        className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
      >
        {state === 'working' ? 'Making a link…' : url ? `New link for ${displayName}` : `Make a link for ${displayName}`}
      </button>

      {url && (
        <div className="mt-2 rounded-md bg-gray-50 p-2">
          <p className="break-all text-xs text-gray-800">{url}</p>
          <div className="mt-1 flex items-center gap-2">
            <button type="button" onClick={copy} className="text-xs font-medium text-blue-700 underline">
              Copy
            </button>
            {copied && <span className="text-xs text-green-700">Copied</span>}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Good for 15 minutes and one use. Making another link cancels this one.
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
