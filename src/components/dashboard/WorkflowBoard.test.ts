// Row 396 (MED): the dashboard board's ⚠ badge (staleCount > 0) used to link
// to an unfiltered /admin/invoices — a bucket reading "3 unreconciled" gave
// the owner no way to find WHICH three. invoicesRowHref routes a stale
// bucket's link to /admin/invoices?stale=1 instead, which page.tsx now reads
// to filter the list. This repo has no jsdom/testing-library setup, so this
// covers the extracted pure href builder directly (same pattern as
// admin/jobs/[id]/page.test.tsx's cancelActionMessage).

import { describe, expect, it } from 'vitest';
import { invoicesRowHref } from './WorkflowBoard';

describe('invoicesRowHref', () => {
  it('links to the plain unfiltered list when nothing in the bucket is stale', () => {
    expect(invoicesRowHref({ count: 4, totalUsd: 4000, staleCount: 0 })).toBe('/admin/invoices');
  });

  it('appends ?stale=1 when the bucket has any unreconciled invoice', () => {
    expect(invoicesRowHref({ count: 4, totalUsd: 4000, staleCount: 1 })).toBe('/admin/invoices?stale=1');
    expect(invoicesRowHref({ count: 4, totalUsd: 4000, staleCount: 3 })).toBe('/admin/invoices?stale=1');
  });
});
