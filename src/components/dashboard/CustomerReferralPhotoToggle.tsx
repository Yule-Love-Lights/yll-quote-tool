'use client';

// Customer profile referral panel (#41 PR 2) — the staff-facing photo
// opt-out switch PR 1 promised (customers.referral_photo_optout), first UI.
//
// Labeled the POSITIVE way ("Use their house photo…"): checked means the
// photo shows on the customer's own /refer/<code> page, i.e. optout FALSE.
// Unchecking sets optout TRUE. Optimistic with revert on error, mirroring
// src/components/dashboard/inbox/DuplicatesList.tsx's merge-button pattern.

import { useState } from 'react';

export function CustomerReferralPhotoToggle({
  customerId,
  initialOptout,
}: {
  customerId: string;
  initialOptout: boolean;
}) {
  const [optout, setOptout] = useState(initialOptout);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleChange(usePhoto: boolean) {
    const nextOptout = !usePhoto;
    const prevOptout = optout;
    setOptout(nextOptout); // optimistic
    setFailed(false);
    setSaving(true);
    try {
      const res = await fetch('/api/referrals/photo-optout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerId, optout: nextOptout }),
      });
      if (!res.ok) {
        setOptout(prevOptout); // revert
        setFailed(true);
      }
    } catch {
      setOptout(prevOptout); // revert
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--op-text)' }}>
        <input
          type="checkbox"
          checked={!optout}
          disabled={saving}
          onChange={(e) => handleChange(e.target.checked)}
          className="w-4 h-4"
        />
        Use their house photo on their referral page
      </label>
      {failed && (
        <p className="text-xs mt-1" style={{ color: '#b91c1c' }}>
          Could not save that change. Try again.
        </p>
      )}
    </div>
  );
}
