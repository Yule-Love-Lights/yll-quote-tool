import { describe, it, expect } from 'vitest';
import { nyDateString, filterCompletingToday, completingTodayMessage } from './completingToday';

describe('nyDateString', () => {
  it('formats an injected clock as YYYY-MM-DD in America/New_York', () => {
    // 2026-01-15T04:30:00Z is still 2026-01-14 evening in New York (UTC-5, winter).
    expect(nyDateString(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14');
    // Noon UTC is unambiguously the same NY calendar day.
    expect(nyDateString(new Date('2026-07-04T12:00:00Z'))).toBe('2026-07-04');
  });
});

describe('filterCompletingToday', () => {
  const today = '2026-08-03';
  it('keeps jobs matching install_date, excludes done/cancelled', () => {
    const jobs = [
      { installDate: today, status: 'to_schedule' },
      { installDate: today, status: 'scheduled' },
      { installDate: today, status: 'done' },
      { installDate: today, status: 'cancelled' },
      { installDate: '2026-08-04', status: 'to_schedule' }, // wrong day
      { installDate: null, status: 'to_schedule' }, // not scheduled yet
    ];
    const result = filterCompletingToday(jobs, today);
    expect(result).toEqual([
      { installDate: today, status: 'to_schedule' },
      { installDate: today, status: 'scheduled' },
    ]);
  });

  it('preserves extra fields on the input objects (generic passthrough)', () => {
    const jobs = [{ id: 'job-1', jobNumber: 7, installDate: today, status: 'installed' }];
    const result = filterCompletingToday(jobs, today);
    expect(result).toEqual([{ id: 'job-1', jobNumber: 7, installDate: today, status: 'installed' }]);
  });
});

describe('completingTodayMessage', () => {
  it('returns null when there are no jobs — the route must send nothing', () => {
    expect(completingTodayMessage([], 'https://app.example.com')).toBeNull();
  });

  it('builds a header, "#<job_number> <customer> — <address>" lines, and a jobs-page link', () => {
    const msg = completingTodayMessage(
      [
        { id: '1', jobNumber: 12, customerName: 'Alice Smith', customerAddress: '123 Main St' },
        { id: '2', jobNumber: null, customerName: null, customerAddress: null },
      ],
      'https://app.example.com',
    );
    expect(msg).toContain('🔨 Jobs completing today');
    expect(msg).toContain('#12 Alice Smith — 123 Main St');
    expect(msg).toContain('#— Customer');
    expect(msg).not.toContain('Customer — '); // no dangling dash when address is missing
    expect(msg).toContain('Jobs → https://app.example.com/admin/jobs');
  });

  it('omits the address suffix when the address is blank', () => {
    const msg = completingTodayMessage(
      [{ id: '1', jobNumber: 3, customerName: 'Bob', customerAddress: '   ' }],
      'https://app.example.com',
    );
    expect(msg).toContain('#3 Bob');
    expect(msg).not.toContain('#3 Bob —');
  });
});
