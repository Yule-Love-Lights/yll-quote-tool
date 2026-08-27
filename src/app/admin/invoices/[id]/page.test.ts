import { describe, it, expect } from 'vitest';

import { resyncActionMessage } from './page';

// Row 388 fix-round delta-verify (MED): the resync route computes and unit
// tests `audited: false` on three failure paths, but nothing rendered it — a
// staffer saw the identical "Resynced" whether the audit entry landed or
// silently failed, which defeats the owner-visible trail the admin HIGH asked
// for. These pin the wording, so the honesty claim is tested rather than
// hoped (same technique as cancelActionMessage on the job detail page — this
// repo has no jsdom, so the response-driven string is a pure export).
const usd = (n: number) => `$${n.toFixed(2)}`;

describe('resyncActionMessage (row 388)', () => {
  it('reports the new total on a real resync', () => {
    expect(resyncActionMessage({ changed: true, invoicedTotal: 2000, audited: true }, usd)).toBe(
      'Resynced — invoice now totals $2000.00.',
    );
  });

  it('says nothing changed on a no-op, never claiming a resync that did not happen', () => {
    const msg = resyncActionMessage({ changed: false, audited: true }, usd);
    expect(msg).toBe('Already in sync — nothing changed.');
    expect(msg).not.toMatch(/Resynced/);
  });

  it('THE FIX: a failed audit stamp is SAID, not swallowed — the money moved but the trail did not', () => {
    const msg = resyncActionMessage({ changed: true, invoicedTotal: 2000, audited: false }, usd);
    expect(msg).toContain('$2000.00');
    expect(msg).toMatch(/recording who did it FAILED/);
  });

  it('a no-op never warns about a missing audit trail — nothing was written to audit', () => {
    // changed:false writes nothing, so there is no money change to attribute.
    // Warning here would send staff hunting for a trail that should not exist.
    const msg = resyncActionMessage({ changed: false, audited: false }, usd);
    expect(msg).toBe('Already in sync — nothing changed.');
    expect(msg).not.toMatch(/FAILED/);
  });

  it('a successful audit adds no noise', () => {
    expect(resyncActionMessage({ changed: true, invoicedTotal: 10, audited: true }, usd)).not.toMatch(/FAILED/);
  });

  it('degrades to a bare confirmation when the route returned no total', () => {
    expect(resyncActionMessage({ changed: true, audited: true }, usd)).toBe('Resynced.');
  });
});
