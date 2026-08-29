'use client';

// Workers + campaigns management island. Rate edits are money config: the
// server logs who changed what from what, and refuses an edit that raced
// another admin's (the audit trail must never lie about the prior rate).

import { useCallback, useEffect, useState } from 'react';

type Worker = {
  id: string;
  displayName: string;
  active: boolean;
  isTest: boolean;
  hasLogin: boolean;
  email: string | null;
};

type Campaign = {
  id: string;
  name: string;
  notes: string | null;
  rateCents: number;
  active: boolean;
  isTest: boolean;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function PeoplePanel() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [newCampaignName, setNewCampaignName] = useState('');
  const [newCampaignRate, setNewCampaignRate] = useState('2.50');

  // Reload by bumping the tick — the effect owns every setState (the
  // ClockCard load-on-mount idiom, which the react lint rule accepts).
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [wRes, cRes] = await Promise.all([
          fetch('/api/admin/advertising/workers'),
          fetch('/api/admin/advertising/campaigns'),
        ]);
        if (cancelled) return;
        if (!wRes.ok || !cRes.ok) {
          setError('Could not load.');
          return;
        }
        const w = ((await wRes.json()) as { workers: Worker[] }).workers;
        const c = ((await cRes.json()) as { campaigns: Campaign[] }).campaigns;
        if (cancelled) return;
        setWorkers(w);
        setCampaigns(c);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const call = async (url: string, method: string, body: Record<string, unknown>) => {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(payload.error ?? 'Action failed.');
        return false;
      }
      await reload();
      return true;
    } catch {
      setError('Action failed. Try again.');
      return false;
    }
  };

  const addWorker = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await call('/api/admin/advertising/workers', 'POST', {
      displayName: newName,
      email: newEmail || undefined,
      password: newPassword || undefined,
    });
    if (ok) {
      setNotice(`${newName.trim()} added.`);
      setNewName('');
      setNewEmail('');
      setNewPassword('');
    }
  };

  const addCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    const rate = Math.round(Number(newCampaignRate) * 100);
    const ok = await call('/api/admin/advertising/campaigns', 'POST', {
      name: newCampaignName,
      rateCents: Number.isFinite(rate) ? rate : undefined,
    });
    if (ok) {
      setNotice(`${newCampaignName.trim()} created.`);
      setNewCampaignName('');
      setNewCampaignRate('2.50');
    }
  };

  const editRate = async (campaign: Campaign) => {
    const raw = window.prompt(
      `New per-sign rate for "${campaign.name}" in dollars (now ${dollars(campaign.rateCents)}).\nOnly FUTURE acceptances pay the new rate; history never moves.`,
      (campaign.rateCents / 100).toFixed(2),
    );
    if (raw === null) return;
    const rate = Math.round(Number(raw) * 100);
    if (!Number.isFinite(rate) || rate < 0) {
      setError('Enter a dollar amount like 2.50.');
      return;
    }
    await call('/api/admin/advertising/campaigns', 'PATCH', {
      campaignId: campaign.id,
      rateCents: rate,
    });
  };

  const mintLogin = async (worker: Worker) => {
    const email = window.prompt(`Email for ${worker.displayName}'s login:`);
    if (!email) return;
    const password = window.prompt('Temporary password (8+ characters):');
    if (!password) return;
    const ok = await call('/api/admin/advertising/workers', 'PATCH', {
      workerId: worker.id,
      email,
      password,
    });
    if (ok) setNotice(`${worker.displayName} can now sign in with ${email.trim()}.`);
  };

  const resetPassword = async (worker: Worker) => {
    const password = window.prompt(`New password for ${worker.displayName} (8+ characters):`);
    if (!password) return;
    const ok = await call('/api/admin/advertising/workers', 'PATCH', {
      workerId: worker.id,
      password,
    });
    if (ok) setNotice(`${worker.displayName}'s password was reset.`);
  };

  return (
    <div className="flex flex-col gap-8">
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</p>}

      <section>
        <h2 className="mb-2 font-semibold text-gray-900">Workers</h2>
        <div className="rounded-xl border border-gray-200 bg-white">
          {workers.length === 0 && <p className="p-4 text-sm text-gray-500">No workers yet.</p>}
          {workers.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-2 border-b border-gray-100 p-3 last:border-b-0">
              <span className={`font-medium ${w.active ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                {w.displayName}
              </span>
              <span className="text-sm text-gray-500">
                {w.hasLogin ? (w.email ?? 'has a login') : 'No login yet'}
              </span>
              <span className="ml-auto flex gap-2 text-sm">
                {w.hasLogin ? (
                  <button type="button" onClick={() => void resetPassword(w)} className="underline text-gray-600">
                    Reset password
                  </button>
                ) : (
                  <button type="button" onClick={() => void mintLogin(w)} className="underline text-gray-600">
                    Create login
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void call('/api/admin/advertising/workers', 'PATCH', { workerId: w.id, active: !w.active })
                  }
                  className="underline text-gray-600"
                >
                  {w.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </span>
            </div>
          ))}
        </div>
        <form onSubmit={addWorker} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-sm text-gray-600">
            Name
            <input value={newName} onChange={(e) => setNewName(e.target.value)} required className="rounded-lg border border-gray-300 px-2 py-1.5" />
          </label>
          <label className="flex flex-col text-sm text-gray-600">
            Email (optional, for their login)
            <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} type="email" className="rounded-lg border border-gray-300 px-2 py-1.5" />
          </label>
          <label className="flex flex-col text-sm text-gray-600">
            Password (8+)
            <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} type="text" className="rounded-lg border border-gray-300 px-2 py-1.5" />
          </label>
          <button type="submit" className="rounded-full bg-gray-900 px-4 py-2 text-sm font-semibold text-white">
            Add worker
          </button>
        </form>
      </section>

      <section>
        <h2 className="mb-2 font-semibold text-gray-900">Campaigns</h2>
        <div className="rounded-xl border border-gray-200 bg-white">
          {campaigns.length === 0 && <p className="p-4 text-sm text-gray-500">No campaigns yet.</p>}
          {campaigns.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 border-b border-gray-100 p-3 last:border-b-0">
              <span className={`font-medium ${c.active ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                {c.name}
              </span>
              <span className="text-sm text-gray-500">{dollars(c.rateCents)} per accepted yard sign</span>
              <span className="ml-auto flex gap-2 text-sm">
                <button type="button" onClick={() => void editRate(c)} className="underline text-gray-600">
                  Change rate
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void call('/api/admin/advertising/campaigns', 'PATCH', { campaignId: c.id, active: !c.active })
                  }
                  className="underline text-gray-600"
                >
                  {c.active ? 'Close' : 'Reopen'}
                </button>
              </span>
            </div>
          ))}
        </div>
        <form onSubmit={addCampaign} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-sm text-gray-600">
            Campaign name
            <input value={newCampaignName} onChange={(e) => setNewCampaignName(e.target.value)} required className="rounded-lg border border-gray-300 px-2 py-1.5" />
          </label>
          <label className="flex flex-col text-sm text-gray-600">
            Rate per sign ($)
            <input value={newCampaignRate} onChange={(e) => setNewCampaignRate(e.target.value)} className="w-24 rounded-lg border border-gray-300 px-2 py-1.5" />
          </label>
          <button type="submit" className="rounded-full bg-gray-900 px-4 py-2 text-sm font-semibold text-white">
            Create campaign
          </button>
        </form>
      </section>
    </div>
  );
}
