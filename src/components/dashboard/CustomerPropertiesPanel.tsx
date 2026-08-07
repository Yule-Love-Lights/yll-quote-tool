'use client';

// Customer profile "Properties" panel — full manage (#205). Staff can label
// a property (nickname, click-to-edit), open it in Google Maps, add a
// never-quoted property by hand, and archive/unarchive one — never a hard
// delete (quotes/jobs/invoices reference properties by id; a hard delete
// would orphan those money records).
//
// Mirrors CustomerTagsEditor/CustomerTenureEditor's optimistic-with-revert +
// router.refresh() pattern: local state drives the visible list immediately
// (so add/edit/archive feel instant), and router.refresh() re-renders the
// server component afterward so OTHER consumers of this customer's
// properties on the same page (RebookButton, fed by the same
// getPropertiesForCustomer call) pick up the change too.
//
// initialProperties is the FULL set (including archived) — the server
// component fetches once with includeArchived:true (see the customer
// profile page) and this component filters "Show archived" client-side,
// rather than a second round trip on toggle.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin } from 'lucide-react';

export type CustomerProperty = {
  id: string;
  address: string | null;
  nickname: string | null;
  archivedAt: string | null;
};

const MAX_NICKNAME_LEN = 80;

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// Insert-or-replace by id — a fresh add appends; an add that RESOLVED to an
// already-shown row (a collision, possibly just un-archived + relabeled by
// createPropertyForCustomer) updates that row in place instead of creating
// a visible duplicate.
function upsertById(list: CustomerProperty[], next: CustomerProperty): CustomerProperty[] {
  const idx = list.findIndex((p) => p.id === next.id);
  if (idx === -1) return [...list, next];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export function CustomerPropertiesPanel({
  customerId,
  initialProperties,
}: {
  customerId: string;
  initialProperties: CustomerProperty[];
}) {
  const router = useRouter();
  const [properties, setProperties] = useState(initialProperties);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // #205 review fix (staff/customer MED, F2): distinct from `error` — an
  // add that resolved to an EXISTING row (rather than creating a new one)
  // isn't a failure, but staff must be told the truth about what happened
  // instead of the panel silently closing as if it "just added" one.
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [addAddress, setAddAddress] = useState('');
  const [addNickname, setAddNickname] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const archivedCount = properties.filter((p) => p.archivedAt).length;
  const visible = properties.filter((p) => showArchived || !p.archivedAt);

  async function patchProperty(
    propertyId: string,
    body: Record<string, unknown>,
  ): Promise<CustomerProperty | null> {
    try {
      const res = await fetch(`/api/customers/${customerId}/properties/${propertyId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError((errBody as { error?: string }).error ?? 'Could not save that change.');
        return null;
      }
      const json = (await res.json()) as { property: CustomerProperty };
      return json.property;
    } catch {
      setError('Could not save that change.');
      return null;
    }
  }

  function startEdit(p: CustomerProperty) {
    setEditingId(p.id);
    setEditValue(p.nickname ?? '');
    setError(null);
    setNotice(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue('');
  }

  // #205 review fix (staff/customer MED, F3): the edit box (and the typed
  // value) now stays open through the whole save — it only closes on
  // CONFIRMED success. Previously editingId cleared synchronously with the
  // optimistic update, before the network call even started; a failure
  // reverted `properties` but the input was already gone, and re-clicking
  // to edit again just re-seeded from the reverted (stale) value — the
  // staff member's typed text was unrecoverable. No optimistic update is
  // needed here at all: the open edit box already shows the in-progress
  // value, so there's nothing else on screen that needs a "preview" of the
  // unsaved change.
  async function saveEdit(propertyId: string) {
    const nextNickname = editValue.trim() || null;
    setBusyId(propertyId);
    setError(null);
    setNotice(null);
    const saved = await patchProperty(propertyId, { nickname: nextNickname });
    setBusyId(null);
    if (!saved) {
      return; // edit box stays open, typed value intact — nothing lost
    }
    setProperties((ps) => ps.map((p) => (p.id === propertyId ? { ...p, nickname: nextNickname } : p)));
    setEditingId(null);
    setEditValue('');
    router.refresh();
  }

  async function toggleArchive(p: CustomerProperty) {
    const archiving = !p.archivedAt;
    if (archiving) {
      const label = p.nickname || p.address || 'this property';
      // #205 review fix (admin MED, F5 + LOW): accurate without being a
      // paragraph. The old copy said it "re-appears automatically the next
      // time a quote is created for it" — that undersold the real trigger
      // surface (a resend, a re-attach, a rebook ALL count too, not just a
      // brand-new quote) while also overstating it FOR rebook specifically
      // (which used to bypass the resurrection rule entirely — now fixed,
      // see rebook.ts's resurrectPropertyForRebook, #205 F1).
      const ok = window.confirm(
        `Archive ${label}?\n\nHidden from this list by default. Quote/job/invoice history is unaffected — it un-archives automatically the moment there's new quote activity for this address (a new quote, a resend, a rebook). Reveal it any time via "Show archived," or Unarchive here.`,
      );
      if (!ok) return;
    }
    const prev = properties;
    const nextArchivedAt = archiving ? new Date().toISOString() : null;
    setProperties((ps) => ps.map((x) => (x.id === p.id ? { ...x, archivedAt: nextArchivedAt } : x))); // optimistic
    setBusyId(p.id);
    setError(null);
    setNotice(null);
    const saved = await patchProperty(p.id, { archived: archiving });
    setBusyId(null);
    if (!saved) {
      setProperties(prev); // revert
      return;
    }
    router.refresh();
  }

  async function submitAdd() {
    const address = addAddress.trim();
    if (!address) {
      setError('Enter an address.');
      return;
    }
    const typedNickname = addNickname.trim();
    setAddBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/customers/${customerId}/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, nickname: typedNickname || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? 'Could not add that property.');
        return;
      }
      const json = (await res.json()) as { property: CustomerProperty; created: boolean };
      setProperties((ps) => upsertById(ps, json.property));
      setAddAddress('');
      setAddNickname('');
      setAdding(false);
      // #205 review fix (staff/customer MED, F2): tell the truth about what
      // actually happened. createPropertyForCustomer resolves an address
      // collision to the EXISTING row instead of creating a duplicate —
      // without this, the form just closes and looks identical to a real
      // add, even though nothing new was created.
      if (!json.created) {
        setNotice(
          typedNickname
            ? 'That address already existed — updated its label.'
            : 'That address already existed — opened it.',
        );
      }
      router.refresh();
    } catch {
      setError('Could not add that property.');
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setError(null);
              setNotice(null);
            }}
            className="px-3 py-1 rounded-md font-medium text-xs"
            style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
          >
            + Add property
          </button>
        ) : (
          <span />
        )}
        {archivedCount > 0 && (
          <label className="flex items-center gap-1.5 text-xs shrink-0" style={{ color: 'var(--op-text-dim)' }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="w-3.5 h-3.5"
            />
            Show archived ({archivedCount})
          </label>
        )}
      </div>

      {adding && (
        <div
          className="rounded-md border p-3 mb-3 flex flex-col gap-2"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)' }}
        >
          <input
            type="text"
            value={addAddress}
            onChange={(e) => setAddAddress(e.target.value)}
            placeholder="Address"
            disabled={addBusy}
            autoFocus
            className="rounded-md border px-2 py-1 text-sm"
            style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)', color: 'var(--op-text)' }}
          />
          <input
            type="text"
            value={addNickname}
            onChange={(e) => setAddNickname(e.target.value)}
            placeholder="Nickname (optional)"
            maxLength={MAX_NICKNAME_LEN}
            disabled={addBusy}
            className="rounded-md border px-2 py-1 text-sm"
            style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)', color: 'var(--op-text)' }}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={submitAdd}
              disabled={addBusy || !addAddress.trim()}
              className="px-3 py-1 rounded-md font-medium text-xs disabled:opacity-50"
              style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
            >
              {addBusy ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setAddAddress('');
                setAddNickname('');
                setError(null);
                setNotice(null);
              }}
              disabled={addBusy}
              className="text-xs hover:underline"
              style={{ color: 'var(--op-text-dim)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>No properties yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-2 text-sm rounded-md px-2.5 py-2"
              style={{ background: 'var(--op-bg)', opacity: p.archivedAt ? 0.6 : 1 }}
            >
              <div className="flex-1 min-w-0">
                {editingId === p.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveEdit(p.id);
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      maxLength={MAX_NICKNAME_LEN}
                      autoFocus
                      disabled={busyId === p.id}
                      className="rounded border px-1.5 py-0.5 text-sm"
                      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)', color: 'var(--op-text)' }}
                    />
                    <button
                      type="button"
                      onClick={() => void saveEdit(p.id)}
                      disabled={busyId === p.id}
                      className="text-xs hover:underline"
                      style={{ color: 'var(--op-primary)' }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={busyId === p.id}
                      className="text-xs hover:underline"
                      style={{ color: 'var(--op-text-dim)' }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => startEdit(p)}
                    // #205 review fix (LOW): matches its Archive sibling —
                    // without this the label was clickable mid-save,
                    // letting a second edit start (and last-write-win) on
                    // top of one already in flight.
                    disabled={busyId === p.id}
                    title="Click to edit label"
                    className="text-left hover:underline truncate block max-w-full disabled:opacity-50"
                    style={{
                      color: p.nickname ? 'var(--op-text)' : 'var(--op-text-dim)',
                      fontStyle: p.nickname ? 'normal' : 'italic',
                    }}
                  >
                    {p.nickname || 'Add a label'}
                  </button>
                )}
                <div className="text-xs truncate" style={{ color: 'var(--op-text-dim)' }}>
                  {p.address ?? '(no address)'}
                  {p.archivedAt ? ' · archived' : ''}
                </div>
              </div>
              {p.address && (
                <a
                  href={mapsUrl(p.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in Google Maps"
                  aria-label="Open in Google Maps"
                  className="shrink-0 hover:opacity-70"
                  style={{ color: 'var(--op-text-dim)' }}
                >
                  <MapPin className="w-4 h-4" aria-hidden />
                </a>
              )}
              <button
                type="button"
                onClick={() => void toggleArchive(p)}
                disabled={busyId === p.id}
                className="shrink-0 text-xs hover:underline disabled:opacity-50"
                style={{ color: 'var(--op-text-dim)' }}
              >
                {p.archivedAt ? 'Unarchive' : 'Archive'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-xs mt-2" style={{ color: '#b91c1c' }}>{error}</p>
      )}
      {notice && (
        <p className="text-xs mt-2" style={{ color: 'var(--op-text-dim)' }}>{notice}</p>
      )}
    </div>
  );
}
