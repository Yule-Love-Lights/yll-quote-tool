import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { QuoteBuildTiming } from './QuoteBuildTiming';

describe('QuoteBuildTiming', () => {
  it('shows the agreed metric boundary and per-staff count, average, median, and p90', () => {
    const html = renderToStaticMarkup(
      <QuoteBuildTiming
        stats={[
          {
            operatorId: 'op-1',
            operatorLabel: 'Alex',
            count: 12,
            averageSeconds: 754,
            medianSeconds: 600,
            p90Seconds: 1500,
            excludedCount: 0,
          },
        ]}
      />,
    );

    expect(html).toContain('Quote build time');
    expect(html).toContain('first contact selection');
    expect(html).toContain('first recorded');
    expect(html).toContain('Manual Mark as sent counts');
    expect(html).toContain('staff member who started');
    expect(html).toContain('Alex');
    expect(html).toContain('12');
    expect(html).toContain('12m 34s');
    expect(html).toContain('10m');
    expect(html).toContain('25m');
    expect(html).toContain('P90');
  });

  it('is honest before any completed session exists', () => {
    const html = renderToStaticMarkup(<QuoteBuildTiming stats={[]} />);
    expect(html).toContain('No completed quote sessions yet');
    expect(html).not.toContain('<table');
  });

  it('surfaces a read failure instead of presenting an empty dataset', () => {
    const html = renderToStaticMarkup(<QuoteBuildTiming stats={[]} error="database unavailable" />);
    expect(html).toContain('Quote timing could not be loaded');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('No completed quote sessions yet');
  });
});
