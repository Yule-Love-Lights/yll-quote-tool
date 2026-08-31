import { describe, it, expect } from 'vitest';
import { crewDayDigestMessage, type CrewDayGroup, type CrewDayJob } from './dayDigest';

const job = (over: Partial<CrewDayJob> = {}): CrewDayJob => ({
  jobNumber: 1046,
  address: '123 Birch Hill Rd, Locust Valley, NY',
  status: 'to_schedule',
  ...over,
});
const group = (over: Partial<CrewDayGroup> = {}): CrewDayGroup => ({
  crewName: 'Field Crew One',
  jobs: [job()],
  ...over,
});

describe('crewDayDigestMessage', () => {
  it('names the day and lists each crew member with their jobs', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group()], []);
    // Read on a phone: the weekday and date, not an ISO string.
    expect(msg).toContain('Saturday, Aug 29');
    expect(msg).toContain('Field Crew One');
    expect(msg).toContain('#1046');
    expect(msg).toContain('123 Birch Hill Rd, Locust Valley, NY');
  });

  it('sends an all-clear rather than nothing on an empty day', () => {
    const msg = crewDayDigestMessage('2026-08-29', [], []);
    expect(msg).toContain('Nothing on the schedule');
  });

  // The worst failure this message can have is looking CONFIDENT and being
  // wrong: a failed read collapses the day to empty, and an all-clear on a busy
  // morning is worse than no message at all.
  it('never says all-clear when the read failed: it says the read failed', () => {
    const msg = crewDayDigestMessage('2026-08-29', [], [], ['assignment scan: connection reset']);
    expect(msg).not.toContain('Nothing on the schedule');
    expect(msg).toMatch(/could not|failed/i);
    expect(msg).toMatch(/check the schedule/i);
  });

  it('warns on the message itself when a partial read still produced jobs', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group()], [], ['property lookup: boom']);
    expect(msg).toContain('#1046');
    expect(msg).toMatch(/some details|incomplete|could not/i);
  });

  // A job with nobody on it is the thing the office most needs to see, so it
  // gets its own section instead of being dropped.
  it('calls out jobs with nobody assigned', () => {
    const msg = crewDayDigestMessage('2026-08-29', [], [job({ jobNumber: 1051, address: '12 Oak Rd' })]);
    expect(msg).toMatch(/[Nn]obody assigned/);
    expect(msg).toContain('#1051');
  });

  it('says the address is missing rather than printing an empty line', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group({ jobs: [job({ address: null })] })], []);
    expect(msg).toContain('address not on file');
  });

  it('handles a job with no number without printing undefined', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group({ jobs: [job({ jobNumber: null })] })], []);
    expect(msg).not.toMatch(/undefined|null/);
  });

  // Telegram rejects a message over ~4096 characters, so a big day must still
  // send. Same cap idea as the inventory prep digest.
  it('caps a very long day and says how many were left off', () => {
    const many = Array.from({ length: 60 }, (_, i) => job({ jobNumber: 1000 + i }));
    const msg = crewDayDigestMessage('2026-08-29', [group({ jobs: many })], []);
    expect(msg.length).toBeLessThan(4000);
    expect(msg).toMatch(/more/i);
  });

  it('never carries a rate, an hour count, or any money', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group()], [job({ jobNumber: 1051 })]);
    expect(msg).not.toMatch(/\$|cents|rate|hours|pay/i);
  });
});

// Cancelling a job does not remove its assignment row, so without a flag a
// cancelled job reaches the crew looking like any other stop (staff lens).
describe('jobs nobody should drive to', () => {
  it('flags a cancelled job in the line itself', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group({ jobs: [job({ status: 'cancelled' })] })], []);
    expect(msg).toMatch(/CANCELLED, do not go/);
  });

  it('flags a finished job', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group({ jobs: [job({ status: 'done' })] })], []);
    expect(msg).toMatch(/already finished, do not go/);
  });

  it('shows the job rather than hiding it, so nobody is left wondering', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group({ jobs: [job({ status: 'cancelled' })] })], []);
    expect(msg).toContain('#1046');
    expect(msg).toContain('123 Birch Hill Rd, Locust Valley, NY');
  });

  it('leaves an ordinary job unflagged', () => {
    const msg = crewDayDigestMessage('2026-08-29', [group({ jobs: [job({ status: 'to_schedule' })] })], []);
    expect(msg).not.toMatch(/do not go/i);
  });
});
