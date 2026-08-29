// Ops hub workstream A: the time-exceptions queue's first UI (the API and
// classifier shipped in row 278 with no surface). Pure presentational
// component, tested with the repo's node-env renderToStaticMarkup idiom.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { TimeExceptionsSection, timeExceptionLabel } from './TimeExceptionsSection';
import type { TimeException } from '@/lib/opsTimeExceptions';

const ex = (over: Partial<TimeException>): TimeException => ({
  type: 'forgotten_clock_out',
  shiftId: 'shift-1',
  crewMemberId: 'crew-1',
  rowId: null,
  openedAt: '2026-08-28T12:30:00.000Z',
  detail: 'Shift open past midnight close.',
  ...over,
});

describe('timeExceptionLabel', () => {
  it('has a plain-English label for every exception type', () => {
    expect(timeExceptionLabel('forgotten_clock_out')).toBe('Forgotten clock-out');
    expect(timeExceptionLabel('open_break_on_closed_shift')).toBe('Break left open');
    expect(timeExceptionLabel('open_segment_on_closed_shift')).toBe('Job segment left open');
    expect(timeExceptionLabel('stale_open_segment')).toBe('Possible missed tap');
  });
});

describe('TimeExceptionsSection', () => {
  it('renders the empty state when there are no exceptions', () => {
    const html = renderToStaticMarkup(
      <TimeExceptionsSection exceptions={[]} crewNames={new Map()} errors={[]} />
    );
    expect(html).toContain('No open time exceptions');
  });

  it('renders a row with the crew name, label, detail, and an ET timestamp', () => {
    const html = renderToStaticMarkup(
      <TimeExceptionsSection
        exceptions={[ex({ crewMemberId: 'crew-1', detail: 'Shift open past midnight close.' })]}
        crewNames={new Map([['crew-1', 'Marco']])}
        errors={[]}
      />
    );
    expect(html).toContain('Marco');
    expect(html).toContain('Forgotten clock-out');
    expect(html).toContain('Shift open past midnight close.');
    // openedAt rendered in ET regardless of server timezone: 12:30Z = 8:30 AM ET.
    expect(html).toContain('8:30');
  });

  it('falls back to a short id when the crew member is not in the active list', () => {
    const html = renderToStaticMarkup(
      <TimeExceptionsSection
        exceptions={[ex({ crewMemberId: 'a1b2c3d4-9999' })]}
        crewNames={new Map()}
        errors={[]}
      />
    );
    expect(html).toContain('a1b2c3d4');
  });

  it('surfaces loader errors instead of silently rendering an empty queue', () => {
    const html = renderToStaticMarkup(
      <TimeExceptionsSection exceptions={[]} crewNames={new Map()} errors={['shifts query failed']} />
    );
    expect(html).toContain('shifts query failed');
    expect(html).not.toContain('No open time exceptions');
  });
});
