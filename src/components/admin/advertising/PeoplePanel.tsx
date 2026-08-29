'use client';

// Workers + campaigns management island. Rate edits are money config: the
// server logs who changed what from what, and refuses an edit that raced
// another admin's (the audit trail must never lie about the prior rate).

import { useCallback, useEffect, useState } from 'react';

import { dollarsToCents } from '@/lib/hourlyRate';

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

type SignStock = {
  onHandQty: number;
  reorderPoint: number;
  acceptedAllTime: number;
  pendingReview: number;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function PeoplePanel() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [signStock, setSignStock] = useState<SignStock | null>(null);
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
        const [wRes, cRes, sRes] = await Promise.all([
          fetch('/api/admin/advertising/workers'),
          fetch('/api/admin/advertising/campaigns'),
          fetch('/api/admin/advertising/sign-stock'),
        ]);
        if (cancelled) return;
        if (!wRes.ok || !cRes.ok) {
          setError('Could not load.');
          return;
        }
        const w = ((await wRes.json()) as { workers: Worker[] }).workers;
        const c = ((await cRes.json()) as { campaigns: Campaign[] }).campaigns;
        const s = sRes.ok ? ((await sRes.json()) as { stock: SignStock }).stock : null;
        if (cancelled) return;
        setWorkers(w);
        setCampaigns(c);
        setSignStock(s);
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

  // THE RATE IS MONEY, and it stamps permanently onto every acceptance after
  // it. Two guards (staff lens HIGH on this PR): dollarsToCents does exact
  // string parsing ("$2.50", "2.5", "2" all fine; "abc", "2.505" refused —
  // never a float multiply, never a silent drop), and a confirm dialog echoes
  // the parsed amount in dollars, so "250" meaning $2.50 dies at "pay $250.00
  // per sign?" instead of in a worker's pay.
  const parseRate = (raw: string): number | null => {
    const cents = dollarsToCents(raw);
    if (cents === null) {
      setError('Enter the rate in dollars, like 2.50.');
      return null;
    }
    return cents;
  };

  const addCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    const rateCents = parseRate(newCampaignRate);
    if (rateCents === null) return;
    if (!window.confirm(`Create "${newCampaignName.trim()}" paying ${dollars(rateCents)} per accepted yard sign?`)) {
      return;
    }
    const ok = await call('/api/admin/advertising/campaigns', 'POST', {
      name: newCampaignName,
      rateCents,
    });
    if (ok) {
      setNotice(`${newCampaignName.trim()} created at ${dollars(rateCents)} per accepted yard sign.`);
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
    const rateCents = parseRate(raw);
    if (rateCents === null) return;
    if (!window.confirm(`Change "${campaign.name}" from ${dollars(campaign.rateCents)} to ${dollars(rateCents)} per accepted yard sign?`)) {
      return;
    }
    const ok = await call('/api/admin/advertising/campaigns', 'PATCH', {
      campaignId: campaign.id,
      rateCents,
    });
    if (ok) setNotice(`${campaign.name} now pays ${dollars(rateCents)} per accepted yard sign.`);
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

  const setStockCount = async () => {
    const raw = window.prompt(
      `How many yard signs are actually in stock right now? (was ${signStock?.onHandQty ?? 0})\nCount the pile and type the number. Accepting a placement never changes this; you reconcile it by hand.`,
      String(signStock?.onHandQty ?? 0),
    );
    if (raw === null) return;
    const qty = Number(raw.trim());
    if (!Number.isInteger(qty) || qty < 0) {
      setError('Enter a whole number, 0 or more.');
      return;
    }
    const ok = await call('/api/admin/advertising/sign-stock', 'PATCH', { onHandQty: qty });
    if (ok) setNotice(`Sign stock set to ${qty}.`);
  };

  return (
    <div className="flex flex-col gap-8">
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</p>}

      {signStock && (
        <section>
          <h2 className="mb-2 font-semibold text-gray-900">Sign stock</h2>
          <div className="flex flex-wrap items-center gap-6 rounded-xl border border-gray-200 bg-white p-4 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">In stock (hand-counted)</p>
              <p className="text-2xl font-semibold text-gray-900">{signStock.onHandQty}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">Signs accepted all time</p>
              <p className="text-2xl font-semibold text-gray-900">{signStock.acceptedAllTime}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">Awaiting review</p>
              <p className="text-2xl font-semibold text-gray-900">{signStock.pendingReview}</p>
            </div>
            <button
              type="button"
              onClick={() => void setStockCount()}
              className="ml-auto rounded-full border border-gray-300 px-4 py-1.5 text-gray-700"
            >
              Set counted stock…
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Reconciliation is manual on purpose: accepting a sign never moves this number. The SKU
            (YLL-YARD-SIGN) also appears on the Inventory stock page.
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-semibold text-gray-900">Workers</h2>
        <div className="rounded-xl border border-gray-200 bg-white">
          {workers.length === 0 && <p className="p-4 text-sm text-gray-500">No workers yet.</p>}
          {workers.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-2 border-b border-gray-100 p-3 last:border-b-0">
              <span className={`font-medium ${w.active ? 'text-gray-900' : 'text-gray-400 line-through'}`}>
                {w.displayName}
              </span>
              {w.isTest && (
                <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">test</span>
              )}
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
              {c.isTest && (
                <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700">test</span>
              )}
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
