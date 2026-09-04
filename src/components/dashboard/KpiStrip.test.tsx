// The KPI strip's two 2026-09-03 claims: the turnaround average names what it
// left out, and conversion is shown split by neighbour with denominators.
// Pure/presentational, rendered with react-dom/server (same style as the other
// dashboard component tests in this repo).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KpiStrip } from './KpiStrip';
import type { Kpis } from '@/lib/dashboard/types';

function makeKpis(over: Partial<Kpis> = {}): Kpis {
  return {
    bookedRevenue: 100000,
    bookedRevenueRecent: 20000,
    activeQuotes: 12,
    activeCustomers: 10,
    avgTurnaroundDays: 3.11,
    conversionRate: 49 / 150,
    turnaroundExcluded: 0,
    conversionNeighbor: { reached: 79, approved: 21, rate: 21 / 79 },
    conversionRegular: { reached: 71, approved: 28, rate: 28 / 71 },
    conversionPendingRecent: 0,
    ...over,
  };
}

describe('KpiStrip — turnaround exclusions are named, never silent', () => {
  it('says how many backlog sends the average left out', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={makeKpis({ turnaroundExcluded: 53 })} />);
    expect(html).toContain('53 backlog sends excluded');
  });

  it('says nothing about exclusions when there are none', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={makeKpis({ turnaroundExcluded: 0 })} />);
    expect(html).not.toContain('excluded');
  });

  it('uses the singular for one excluded send', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={makeKpis({ turnaroundExcluded: 1 })} />);
    expect(html).toContain('1 backlog send excluded');
    expect(html).not.toContain('backlog sends');
  });
});

describe('KpiStrip — conversion split', () => {
  it('shows both rates, each with its own counts', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={makeKpis()} />);
    expect(html).toContain('Neighbors');
    expect(html).toContain('27%');
    expect(html).toContain('21/79');
    expect(html).toContain('Regular');
    expect(html).toContain('39%');
    expect(html).toContain('28/71');
  });

  it('still shows the overall rate and its denominator', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={makeKpis()} />);
    expect(html).toContain('33% overall');
    expect(html).toContain('49/150 reached');
  });

  // A group nobody has reached is unknown, not a total failure. Rendering 0%
  // there would tell Naldo a funnel collapsed when it simply has no data.
  it('renders a dash, not 0%, for a group with nobody reached', () => {
    const html = renderToStaticMarkup(
      <KpiStrip
        kpis={makeKpis({
          conversionNeighbor: { reached: 0, approved: 0, rate: null },
          conversionRegular: { reached: 4, approved: 1, rate: 0.25 },
        })}
      />,
    );
    expect(html).toContain('—');
    expect(html).toContain('0/0');
  });
});

describe('KpiStrip — quotes too recent to count are named, not hidden', () => {
  it('says how many were sent too recently to count', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={makeKpis({ conversionPendingRecent: 51 })} />);
    expect(html).toContain('51 sent too recently to count yet');
  });

  it('says nothing when none are pending', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={makeKpis({ conversionPendingRecent: 0 })} />);
    expect(html).not.toContain('too recently');
  });

  // This bucket also holds quotes already won or cancelled inside the window,
  // so the wording must not claim they are awaiting a reply.
  it('does not claim the pending quotes are still awaiting an answer', () => {
    const html = renderToStaticMarkup(<KpiStrip kpis={makeKpis({ conversionPendingRecent: 51 })} />);
    expect(html).not.toContain('still out');
  });
});
