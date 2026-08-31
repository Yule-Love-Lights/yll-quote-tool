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
    expect(msg).toContain('2026-08-29');
    expect(msg).toContain('Field Crew One');
    expect(msg).toContain('#1046');
    expect(msg).toContain('123 Birch Hill Rd, Locust Valley, NY');
  });

  it('sends an all-clear rather than nothing on an empty day', () => {
    const msg = crewDayDigestMessage('2026-08-29', [], []);
    expect(msg).toContain('Nothing on the schedule');
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
