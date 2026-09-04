import { describe, it, expect } from 'vitest';
import { crewDayDigestMessage, type CrewDayJob } from './dayDigest';

const job = (over: Partial<CrewDayJob> = {}): CrewDayJob => ({
  jobNumber: 1069,
  customerName: 'naldoventest',
  address: '6 Birch Road, Amityville, NY',
  status: 'to_schedule',
  crew: ['Naldo'],
  ...over,
});

describe('crewDayDigestMessage', () => {
  it('names the day in words, not an ISO string', () => {
    expect(crewDayDigestMessage('2026-09-04', [])).toContain('Friday, Sep 4');
  });

  // Naldo, 2026-09-04: one block per JOB with everyone under it, rather than
  // the same job repeated once per crew member.
  it('lists a job once, with every crew member under it', () => {
    const msg = crewDayDigestMessage('2026-09-04', [
      job({ crew: ['Naldo', 'SonSon', 'Little James'] }),
    ]);
    expect(msg).toContain('#1069 naldoventest, 6 Birch Road, Amityville, NY');
    expect(msg).toMatch(/Naldo\nSonSon\nLittle James/);
    // the job appears exactly once
    expect(msg.match(/#1069/g)).toHaveLength(1);
  });

  it('says so when nobody is assigned, rather than showing a bare job', () => {
    const msg = crewDayDigestMessage('2026-09-04', [job({ crew: [] })]);
    expect(msg).toMatch(/[Nn]obody assigned/);
    expect(msg).toContain('#1069');
  });

  it('sends an all-clear on an empty day', () => {
    expect(crewDayDigestMessage('2026-09-04', [])).toContain('Nothing on the schedule');
  });

  it('never says all-clear when the read failed', () => {
    const msg = crewDayDigestMessage('2026-09-04', [], ['assignment scan: connection reset']);
    expect(msg).not.toContain('Nothing on the schedule');
    expect(msg).toMatch(/could not read the schedule/i);
  });

  it('warns on the message itself when a partial read still produced jobs', () => {
    const msg = crewDayDigestMessage('2026-09-04', [job()], ['property lookup: boom']);
    expect(msg).toContain('#1069');
    expect(msg).toMatch(/may be incomplete/i);
  });

  it('flags a cancelled job and still shows it', () => {
    const msg = crewDayDigestMessage('2026-09-04', [job({ status: 'cancelled' })]);
    expect(msg).toMatch(/CANCELLED, do not go/);
    expect(msg).toContain('#1069');
  });

  it('flags a finished job', () => {
    expect(crewDayDigestMessage('2026-09-04', [job({ status: 'done' })])).toMatch(/already finished/);
  });

  it('leaves an ordinary job unflagged', () => {
    expect(crewDayDigestMessage('2026-09-04', [job()])).not.toMatch(/do not go/i);
  });

  it('says the address is missing rather than printing a blank', () => {
    expect(crewDayDigestMessage('2026-09-04', [job({ address: null })])).toContain('address not on file');
  });

  it('drops the customer name cleanly when there is none', () => {
    const msg = crewDayDigestMessage('2026-09-04', [job({ customerName: null })]);
    expect(msg).toContain('#1069 6 Birch Road, Amityville, NY');
    expect(msg).not.toMatch(/undefined|null/);
  });

  it('handles a job with no number without printing undefined', () => {
    expect(crewDayDigestMessage('2026-09-04', [job({ jobNumber: null })])).not.toMatch(/undefined|null/);
  });

  it('carries no money of any kind', () => {
    const msg = crewDayDigestMessage('2026-09-04', [job({ crew: ['Naldo', 'SonSon'] })]);
    expect(msg).not.toMatch(/\$|cents|rate|pay|hours/i);
  });

  it('stays inside the Telegram limit on a huge day, and says what it left off', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      job({ jobNumber: 1000 + i, address: `${'A'.repeat(200)} Road`, crew: ['Naldo', 'SonSon'] }),
    );
    const msg = crewDayDigestMessage('2026-09-04', many, ['property lookup: boom']);
    expect(msg.length).toBeLessThanOrEqual(3500);
    expect(msg).toMatch(/more not shown/i);
    expect(msg).toMatch(/may be incomplete/i);
  });
});

// Staff lens, PR #1212: grouping by job costs a crew member the ability to find
// their own name fast, and with crew logins retired this message is how they
// check their day. The index answers "which are mine" without undoing the
// per-job blocks Naldo asked for.
describe('the who-has-what index', () => {
  const j = (n: number, crew: string[]): CrewDayJob => ({
    jobNumber: n,
    customerName: null,
    address: 'somewhere',
    status: null,
    crew,
  });

  it('stays out of the way on a single-job day', () => {
    const msg = crewDayDigestMessage('2026-09-04', [j(1069, ['Naldo', 'SonSon'])]);
    expect(msg).not.toMatch(/Naldo: #/);
  });

  it('lists each person and their jobs once there is more than one', () => {
    const msg = crewDayDigestMessage('2026-09-04', [
      j(1069, ['Naldo', 'SonSon']),
      j(1082, ['Naldo']),
    ]);
    expect(msg).toContain('Naldo: #1069, #1082');
    expect(msg).toContain('SonSon: #1069');
  });

  it('puts the index above the job blocks, where it is read first', () => {
    const msg = crewDayDigestMessage('2026-09-04', [j(1069, ['Naldo']), j(1082, ['Naldo'])]);
    expect(msg.indexOf('Naldo: #1069')).toBeLessThan(msg.indexOf('#1069 somewhere'));
  });

  it('names people in the same order every morning', () => {
    const msg = crewDayDigestMessage('2026-09-04', [j(1069, ['SonSon', 'Little James']), j(1082, ['Naldo'])]);
    const order = ['Little James:', 'Naldo:', 'SonSon:'].map((n) => msg.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('leaves an unassigned job out of the index rather than inventing a person', () => {
    const msg = crewDayDigestMessage('2026-09-04', [j(1069, []), j(1082, ['Naldo'])]);
    expect(msg).toContain('Naldo: #1082');
    expect(msg).toMatch(/[Nn]obody assigned/);
  });
});
