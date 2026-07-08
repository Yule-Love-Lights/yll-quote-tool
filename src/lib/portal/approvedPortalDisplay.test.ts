// Audit fix (approved-portal-snapshot): an approved (locked) portal must render
// the FROZEN selection the customer signed — not the recommendation/staff
// defaults — and must only read as "booked" when the quote is genuinely booked
// (still actionable, or actually paid). These pure helpers back that fix so the
// selection-seeding + isBooked branches are unit-testable (the page component
// itself pulls in `server-only` deps and can't be imported here).

import { describe, it, expect } from 'vitest';
import {
  quoteRowToPortalQuote,
  deriveIsBooked,
  resolveApprovalSelectionSeed,
  type QuoteRowForPortal,
} from './adapter';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import type { PortalPhotos } from './photos';

const PHOTOS: PortalPhotos = { beforeUrl: null, afterUrl: null, alt: null };

function inputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    santasFootage: 100,
    santasDifficulty: 'medium',
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'medium',
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'medium',
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'medium',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
    ...overrides,
  };
}

function approvedRow(customerSelection: unknown): QuoteRowForPortal {
  const result = calculateQuote(inputs());
  return {
    id: '00000000-0000-0000-0000-000000000000',
    customer_name: 'Test Customer',
    customer_address: '1 Test St, Huntington, NY 11743',
    customer_phone: null,
    customer_email: null,
    result,
    inputs: null,
    total: result.total,
    video_kind: null,
    video_src: null,
    video_poster: null,
    video_title: null,
    video_duration_sec: null,
    customer_approved_at: '2026-07-04T00:00:00Z',
    approval_snapshot: { customerSelection } as QuoteRowForPortal['approval_snapshot'],
  };
}

// ── buildApproval now exposes the frozen selection (part a) ─────────────────
describe('quoteRowToPortalQuote — frozen selection on PortalApproval', () => {
  it('exposes the approved selectedItemIds + rushSelected from the snapshot', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow({
        packageId: 'D',
        selectedItemIds: ['roofline-santas', 'spritzer-2'],
        rushSelected: true,
        takedownSelected: true,
      }),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.selectedItemIds).toEqual(['roofline-santas', 'spritzer-2']);
    expect(portal.approval?.rushSelected).toBe(true);
    expect(portal.approval?.takedownSelected).toBe(true);
    expect(portal.approval?.packageId).toBe('D');
  });

  it('defaults selectedItemIds to [] and rushSelected to false on an OLD snapshot', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow({ packageId: 'C' }),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.selectedItemIds).toEqual([]);
    expect(portal.approval?.rushSelected).toBe(false);
  });

  it('drops non-string ids from the frozen selectedItemIds', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow({ packageId: 'D', selectedItemIds: ['a', 5, null, 'b'] }),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.selectedItemIds).toEqual(['a', 'b']);
  });
});

// ── resolveApprovalSelectionSeed (part a seeding) ───────────────────────────
describe('resolveApprovalSelectionSeed', () => {
  const fallback = { initialPackageId: 'A' as const, initialSelectedItemIds: ['rec-1'] };

  it('returns the fallback (recommendation/default seed) when NOT approved', () => {
    expect(resolveApprovalSelectionSeed(undefined, fallback)).toEqual(fallback);
  });

  it('restores the exact custom item set for a divergent (D) approval, highlighting D', () => {
    const seed = resolveApprovalSelectionSeed(
      { packageId: 'D', selectedItemIds: ['x', 'y'] },
      fallback,
    );
    expect(seed).toEqual({ initialPackageId: 'D', initialSelectedItemIds: ['x', 'y'] });
  });

  it('restores a named tier (C) by packageId, letting the package seed its items (no id list, so the highlight stays on C)', () => {
    const seed = resolveApprovalSelectionSeed(
      { packageId: 'C', selectedItemIds: ['whatever'] },
      fallback,
    );
    expect(seed).toEqual({ initialPackageId: 'C', initialSelectedItemIds: undefined });
  });
});

// ── deriveIsBooked (part b) ─────────────────────────────────────────────────
describe('deriveIsBooked', () => {
  it('checkout ON: booked iff paid, regardless of approval/status', () => {
    expect(deriveIsBooked({ checkoutEnabled: true, isTest: false, isPaid: false, isApproved: true, quoteStatus: 'approved' })).toBe(false);
    expect(deriveIsBooked({ checkoutEnabled: true, isTest: false, isPaid: true, isApproved: true, quoteStatus: 'approved' })).toBe(true);
  });

  it('test quote: booked iff paid (simulated deposit)', () => {
    expect(deriveIsBooked({ checkoutEnabled: false, isTest: true, isPaid: false, isApproved: true, quoteStatus: 'approved' })).toBe(false);
    expect(deriveIsBooked({ checkoutEnabled: false, isTest: true, isPaid: true, isApproved: true, quoteStatus: 'approved' })).toBe(true);
  });

  it('checkout OFF: a normally-approved (still actionable) quote reads booked', () => {
    expect(deriveIsBooked({ checkoutEnabled: false, isTest: false, isPaid: false, isApproved: true, quoteStatus: 'approved' })).toBe(true);
  });

  it('checkout OFF: an approved-then-CANCELLED, unpaid quote is NOT booked (the bug)', () => {
    expect(deriveIsBooked({ checkoutEnabled: false, isTest: false, isPaid: false, isApproved: true, quoteStatus: 'cancelled' })).toBe(false);
    expect(deriveIsBooked({ checkoutEnabled: false, isTest: false, isPaid: false, isApproved: true, quoteStatus: 'declined' })).toBe(false);
  });

  it('checkout OFF: a genuinely PAID quote that was later cancelled stays booked', () => {
    expect(deriveIsBooked({ checkoutEnabled: false, isTest: false, isPaid: true, isApproved: true, quoteStatus: 'cancelled' })).toBe(true);
  });

  it('checkout OFF: an unapproved quote is never booked', () => {
    expect(deriveIsBooked({ checkoutEnabled: false, isTest: false, isPaid: false, isApproved: false, quoteStatus: 'sent' })).toBe(false);
  });
});
