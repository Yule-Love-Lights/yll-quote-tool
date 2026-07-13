'use client';

// Portal e-signature capture (#83 Phase 1, Slice B). The customer types their
// full name to sign; the typed name is POSTed in the approve body and frozen
// into approval_snapshot.signature server-side.
//
// The draw-on-canvas option was REMOVED (S22, per Jason) — signing is type-only.
// The `kind` field stays a 'typed' | 'drawn' union so approvals frozen with a
// drawn signature before this change still type-check when read back; the pad
// itself only ever emits 'typed'.
//
// Shape returned via onChange:
//   { name, kind: 'typed', value: name }   — value is the typed name
// null when there isn't yet a usable signature (empty name) so the caller keeps
// Approve disabled until it's signed.

import { useEffect, useState } from 'react';

export type CapturedSignature = {
  name: string;
  kind: 'typed' | 'drawn';
  value: string;
};

type Props = {
  /** Fires whenever the signature becomes valid/invalid. null ⇒ not yet signed. */
  onChange: (sig: CapturedSignature | null) => void;
};

// Bug fix (PS-D6): a single character was accepted as a legal e-signature.
// Mirrors the server-side minimum in approve/route.ts's parseSignature.
const SIGNATURE_NAME_MIN = 2;

export function SignaturePad({ onChange }: Props) {
  const [name, setName] = useState('');

  // Emit the typed signature (or null while the name is too short) on every change.
  useEffect(() => {
    const trimmed = name.trim();
    onChange(trimmed.length >= SIGNATURE_NAME_MIN ? { name: trimmed, kind: 'typed', value: trimmed } : null);
  }, [name, onChange]);

  return (
    <div className="mt-4">
      <label htmlFor="sig-name" className="block text-[13px] text-[#A89F87] mb-1.5">
        Type your full name to sign
      </label>
      <input
        id="sig-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoComplete="name"
        placeholder="Your full name"
        className="w-full min-h-[44px] rounded-lg bg-[#060B0F] border border-[#FFB744]/30 px-3 py-2.5 text-[16px] text-[#F4ECD8] placeholder-[#6E6553] focus:outline-none focus:ring-2 focus:ring-[#FFB744]"
      />
      {name.trim() && (
        <p className="mt-2 font-display text-[22px] text-[#FFD07A] italic" aria-hidden>
          {name.trim()}
        </p>
      )}
    </div>
  );
}
