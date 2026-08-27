'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DesignPortalVisibility } from '@/lib/designs';

type VisibilityKind = 'street' | 'satellite';
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function portalVisibilityPatch(
  kind: VisibilityKind,
  visible: boolean,
): Partial<DesignPortalVisibility> {
  return kind === 'street'
    ? { portalShowStreetView: visible }
    : { portalShowSatelliteView: visible };
}

/**
 * Row 429 — the confirm shown before a visibility change on a quote the
 * customer has already APPROVED.
 *
 * The predicate is deliberately WIDER than the design freeze's, not the same:
 * `isSceneFrozen` exempts a BOOKED order (that is the amend path), while this
 * confirms on one. That is the right asymmetry — a booked customer has approved
 * AND paid, so a change to what their portal shows deserves a beat of thought
 * more than an unbooked one, not less. An earlier version of this comment
 * claimed parity with the freeze; an admin lens measured the difference at 22 of
 * 24 approved non-test quotes, which is most of them.
 *
 * Deliberately a confirm and NOT a freeze. Everything the customer actually
 * agreed to — the design geometry, the photo, the satellite trace, the price —
 * is frozen by rows 367/427. These two switches only decide which IMAGES their
 * portal displays: they can show less, or restore what was there, but they
 * cannot show a different job. Freezing them would leave a booked customer's
 * portal stuck with a confusing or wrong-house image whose only remedy is
 * decline → revive → edit → re-send, i.e. destroying a real approval to fix a
 * picture, which nobody would do. Row 370 already made the same call: it built
 * an AUDIT TRAIL for these toggles rather than a gate, and a trail is something
 * you build for an action you intend to keep allowing.
 *
 * What was missing was deliberateness. The confirm supplies it, the row-370
 * trail records who answered yes, and the capability survives.
 *
 * Exported so the wording is testable without a DOM (this repo has no React
 * component test harness — ledger row 259).
 */
export function portalVisibilityConfirmMessage(kind: VisibilityKind, visible: boolean): string {
  const what = kind === 'street' ? 'house design' : 'satellite plan';
  return visible
    ? `This customer has already approved this quote. Showing the ${what} again will change what they see on their portal. Continue?`
    : `This customer has already approved this quote. Hiding the ${what} will change what they see on their portal. Continue?`;
}

export async function persistPortalImageVisibility(
  designId: string,
  patch: Partial<DesignPortalVisibility>,
  request: FetchLike = fetch,
): Promise<DesignPortalVisibility> {
  const response = await request(`/api/designs/${designId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error === 'string' ? body.error : 'Could not update customer portal images',
    );
  }
  if (
    typeof body?.portalShowStreetView !== 'boolean' ||
    typeof body.portalShowSatelliteView !== 'boolean'
  ) {
    throw new Error('Could not confirm customer portal image settings');
  }
  return {
    portalShowStreetView: body.portalShowStreetView,
    portalShowSatelliteView: body.portalShowSatelliteView,
  };
}

export function PortalImageVisibilityControls({
  designId,
  portalShowStreetView,
  portalShowSatelliteView,
  hasStreetImage,
  hasSatelliteImage,
  customerApproved = false,
}: DesignPortalVisibility & {
  designId: string;
  hasStreetImage: boolean;
  hasSatelliteImage: boolean;
  /**
   * Row 429: the customer has approved this quote, so a visibility change moves
   * something they have already seen. Same predicate as the design freeze
   * (`customer_approved_at` set, is_test exempt) — see the caller.
   */
  customerApproved?: boolean;
}) {
  const router = useRouter();
  const [visibility, setVisibility] = useState({
    street: portalShowStreetView,
    satellite: portalShowSatelliteView,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (inFlightRef.current) return;
    setVisibility({
      street: portalShowStreetView,
      satellite: portalShowSatelliteView,
    });
  }, [portalShowStreetView, portalShowSatelliteView]);

  async function setPortalVisibility(kind: VisibilityKind, visible: boolean) {
    if (inFlightRef.current) return;
    // Row 429: PRE-FLIGHT, before the optimistic state update and before any
    // request — so a decline changes absolutely nothing, not even the checkbox.
    // (Row 405's lesson: a confirm placed after the first mutation leaves the
    // caller unpicking consequences one by one.)
    if (customerApproved && !window.confirm(portalVisibilityConfirmMessage(kind, visible))) return;
    inFlightRef.current = true;
    const previous = visibility;
    setVisibility({ ...previous, [kind]: visible });
    setBusy(true);
    setError(null);
    try {
      const saved = await persistPortalImageVisibility(
        designId,
        portalVisibilityPatch(kind, visible),
      );
      setVisibility({
        street: saved.portalShowStreetView,
        satellite: saved.portalShowSatelliteView,
      });
      router.refresh();
    } catch (err) {
      setVisibility(previous);
      setError(err instanceof Error ? err.message : 'Could not update customer portal images');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <fieldset
      aria-busy={busy}
      className="bg-white border border-gray-200 rounded-lg p-4 mb-4"
    >
      <legend className="text-xs font-semibold uppercase tracking-wide text-gray-500 px-1">
        Customer portal images
      </legend>
      <p className="text-sm text-gray-500 mb-3">
        Hide either view from the customer without deleting staff photos or measurements.
      </p>
      {/* Three review lenses flagged the same gap: these switches govern the
          QUOTE PORTAL only. The public referral hero (/refer/[code]) and the
          marketing sample-homes gallery read the design photo directly and do
          not check these flags, so "hidden" here is not "hidden everywhere".
          Saying so on the control is what stops a staffer believing a photo is
          private when it is still publicly reachable. */}
      <p className="text-xs text-gray-500 mb-3">
        This controls the quote portal only. It does not hide the photo from the
        public referral page or the sample-homes gallery, which are governed
        separately.
      </p>
      {customerApproved && (
        <p className="text-xs text-amber-700 mb-3">
          This customer has <strong>already approved</strong> this quote, so these switches change
          what they see on their portal. They only decide which images are shown — they do not
          change the design, the measurements or the price. You will be asked to confirm.
        </p>
      )}
      <div className="space-y-3">
        <label className={`flex items-start gap-3 ${hasStreetImage ? 'cursor-pointer' : 'text-gray-400'}`}>
          <input
            type="checkbox"
            checked={visibility.street}
            disabled={busy || !hasStreetImage}
            onChange={(event) => void setPortalVisibility('street', event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600"
          />
          <span>
            <span className="block text-sm font-medium text-gray-800">
              Show house design on customer portal
            </span>
            {!hasStreetImage && <span className="block text-xs">No house design image is stored.</span>}
          </span>
        </label>
        <label className={`flex items-start gap-3 ${hasSatelliteImage ? 'cursor-pointer' : 'text-gray-400'}`}>
          <input
            type="checkbox"
            checked={visibility.satellite}
            disabled={busy || !hasSatelliteImage}
            onChange={(event) => void setPortalVisibility('satellite', event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600"
          />
          <span>
            <span className="block text-sm font-medium text-gray-800">
              Show satellite plan on customer portal
            </span>
            {!hasSatelliteImage && <span className="block text-xs">No satellite image is stored.</span>}
          </span>
        </label>
      </div>
      {busy && (
        <p role="status" aria-live="polite" className="text-xs text-gray-500 mt-3">
          Saving…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700 mt-3">
          {error}
        </p>
      )}
    </fieldset>
  );
}
