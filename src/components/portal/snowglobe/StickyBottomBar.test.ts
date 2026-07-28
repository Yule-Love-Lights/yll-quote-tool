// Tests for the pure seams extracted out of StickyBottomBar's onApprove (audit
// W4-031 — no test infra exists for full component rendering; @testing-library/
// jsdom isn't installed, so this covers the payload-assembly + gate logic the
// same way the SelectionContext reducers are covered: as plain functions,
// mock-free. The `meetsMinimum` GATE MATH itself is already covered in
// SelectionContext.test.ts / derivePackages.test.ts (orderMinimumStatus); this
// file covers the two things that were untested: (a) the field-mapping from
// live selection state into the /approve POST body, and (b) canSubmitApproval
// (submitting-in-flight / below-minimum) blocking the fetch from firing.

import { describe, it, expect } from 'vitest';
import {
  canSubmitApproval,
  buildApprovePayload,
  openAbandonGuard,
  resolveAbandonGuard,
  consumeAbandonOnClose,
  isAlreadyApprovedCode,
  viewOnlyBrowsingCopy,
} from './StickyBottomBar';
import type { CapturedSignature } from './SignaturePad';

const SIG: CapturedSignature = { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith' };

const SELECTION = {
  packageId: 'A' as const,
  selectedItemIds: new Set(['roofline-santas', 'spritzer-1']),
  activeName: 'Classic Glow',
  currentTotal: 1631.25,
  currentDeposit: 815.63,
  rushSelected: false,
  takedownSelected: true,
  colorSchemeId: 'warm-white',
  customPattern: [] as string[],
  installTiming: 'october' as const,
  breakdown: { discount: 150 },
};

describe('isAlreadyApprovedCode (PS-D1)', () => {
  it('is true only for the already-approved 409 code', () => {
    expect(isAlreadyApprovedCode('already-approved')).toBe(true);
  });

  it('is false for illegal-transition (a declined/changes-requested quote) — must not navigate forward', () => {
    expect(isAlreadyApprovedCode('illegal-transition')).toBe(false);
  });

  it('is false for an unknown/missing code (defensive default)', () => {
    expect(isAlreadyApprovedCode(undefined)).toBe(false);
    expect(isAlreadyApprovedCode('some-other-code')).toBe(false);
  });
});

// #176 — the viewOnly branch renders a neutral "just browsing" strip instead
// of the approve/pay/decline CTA and never mounts DepositCheckout/SignModal/
// QuoteResponseModal. No component-render infra exists (see the file header
// above), so this proves the pure copy builder the viewOnly render path uses:
// the exact label + a correctly tel:-normalized href, never the Approve CTA
// copy ("Approve", "Complete deposit", etc.).
describe('viewOnlyBrowsingCopy (#176)', () => {
  it('builds the browsing-strip label + a tel: href stripped of formatting', () => {
    expect(viewOnlyBrowsingCopy('(631) 517-0186')).toEqual({
      label: 'Just browsing — text us your favourite look:',
      phone: '(631) 517-0186',
      telHref: 'tel:6315170186',
    });
  });

  it('never returns any approve/pay/decline CTA copy', () => {
    const { label } = viewOnlyBrowsingCopy('(631) 517-0186');
    expect(label).not.toMatch(/approve|deposit|decline/i);
  });

  it('preserves a leading +country code in the tel href', () => {
    expect(viewOnlyBrowsingCopy('+1 631-517-0186').telHref).toBe('tel:+16315170186');
  });
});

describe('canSubmitApproval (W4-031)', () => {
  it('blocks when a submit is already in flight', () => {
    expect(canSubmitApproval(true, true)).toBe(false);
  });

  it('blocks when the selection is below the order minimum', () => {
    expect(canSubmitApproval(false, false)).toBe(false);
  });

  it('blocks when both submitting and below minimum', () => {
    expect(canSubmitApproval(true, false)).toBe(false);
  });

  it('allows when idle and the minimum is met', () => {
    expect(canSubmitApproval(false, true)).toBe(true);
  });
});

describe('buildApprovePayload (W4-031)', () => {
  it('maps every live selection field + the signature into the POST body', () => {
    const payload = buildApprovePayload(SELECTION, SIG);
    expect(payload).toEqual({
      packageId: 'A',
      selectedItemIds: ['roofline-santas', 'spritzer-1'],
      activeName: 'Classic Glow',
      currentTotal: 1631.25,
      currentDeposit: 815.63,
      rushSelected: false,
      takedownSelected: true,
      colorSchemeId: 'warm-white',
      customPattern: [],
      permanentEffect: 'chase', // #88 P6b-4 — defaulted when the selection omits it
      installTiming: 'october',
      installDiscountUsd: 150,
      signature: { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith' },
    });
  });

  it('flattens the selectedItemIds Set into an array (order of insertion)', () => {
    const selection = { ...SELECTION, selectedItemIds: new Set(['b', 'a', 'c']) };
    const payload = buildApprovePayload(selection, SIG);
    expect(payload.selectedItemIds).toEqual(['b', 'a', 'c']);
  });

  it('reads installDiscountUsd from breakdown.discount, not a stale client figure', () => {
    const selection = { ...SELECTION, breakdown: { discount: 0 } };
    const payload = buildApprovePayload(selection, SIG);
    expect(payload.installDiscountUsd).toBe(0);
  });

  it('drops the drawn-signature stroke metadata — only name/kind/value ship', () => {
    const drawn: CapturedSignature = { name: 'Jordan Smith', kind: 'drawn', value: 'data:image/png;base64,xyz' };
    const payload = buildApprovePayload(SELECTION, drawn);
    expect(payload.signature).toEqual({ name: 'Jordan Smith', kind: 'drawn', value: 'data:image/png;base64,xyz' });
  });
});

// approve_abandoned once-per-open semantics (PostHog Wave 1). These three
// guard functions are exactly what the sign modal's onCancel and both
// DepositCheckout onClose sites call — tested here as the pure seam, mirroring
// buildApprovePayload's extraction, since no component-render test infra exists.
describe('AbandonGuard (approve_abandoned once-per-open, PostHog Wave 1)', () => {
  it('open -> close fires once', () => {
    const guard = openAbandonGuard();
    expect(consumeAbandonOnClose(guard)).toBe(true);
  });

  it('a second close in the same open does not fire again', () => {
    const guard = openAbandonGuard();
    expect(consumeAbandonOnClose(guard)).toBe(true);
    expect(consumeAbandonOnClose(guard)).toBe(false);
  });

  it('open -> approve success (resolve) -> close fires nothing', () => {
    const guard = openAbandonGuard();
    resolveAbandonGuard(guard);
    expect(consumeAbandonOnClose(guard)).toBe(false);
  });

  it('reopen -> close fires again', () => {
    let guard = openAbandonGuard();
    expect(consumeAbandonOnClose(guard)).toBe(true); // first open, closed
    guard = openAbandonGuard(); // reopened — a fresh guard, as the component does
    expect(consumeAbandonOnClose(guard)).toBe(true); // fires again
  });

  it('reopen after a resolved (successful) open also fires again', () => {
    let guard = openAbandonGuard();
    resolveAbandonGuard(guard); // e.g. quote_approved / the 409 branch
    expect(consumeAbandonOnClose(guard)).toBe(false);
    guard = openAbandonGuard(); // e.g. the "Complete deposit" button reopens it
    expect(consumeAbandonOnClose(guard)).toBe(true);
  });
});
