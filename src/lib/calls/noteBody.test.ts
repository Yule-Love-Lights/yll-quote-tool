// The note body is what a staff member reads in HighLevel, so its shape is
// pinned here rather than left to whatever the composer happens to emit.

import { describe, it, expect } from 'vitest';
import { composeCallNote, formatPromisedAt } from './noteBody';

const SUMMARY = 'Customer asked about permanent lighting for a Cape Cod house and wants a price before the season starts.';

describe('composeCallNote', () => {
  it('puts the summary first and the tasks under a heading', () => {
    const body = composeCallNote({
      summary: SUMMARY,
      commitments: [
        { kind: 'send_quote', detail: 'Send a proposal by email', promised_at: null },
        { kind: 'callback', detail: 'Call back to schedule an appointment', promised_at: null },
      ],
    });

    expect(body).toContain(SUMMARY);
    expect(body).toContain('Tasks from this call:');
    expect(body).toContain('- Send a proposal by email');
    expect(body).toContain('- Call back to schedule an appointment');
    expect(body.indexOf(SUMMARY)).toBeLessThan(body.indexOf('Tasks from this call:'));
  });

  it('says so plainly when the call produced no tasks', () => {
    const body = composeCallNote({ summary: SUMMARY, commitments: [] });
    expect(body).toContain('No follow-up tasks came out of this call.');
    expect(body).not.toContain('Tasks from this call:');
  });

  it('marks the note as automatic so staff know nobody typed it', () => {
    const body = composeCallNote({ summary: SUMMARY, commitments: [] });
    expect(body.split('\n')[0]).toContain('automatically');
  });

  it('shows a promised time in plain Eastern wall clock', () => {
    const body = composeCallNote({
      summary: SUMMARY,
      commitments: [
        // 2026-08-26T23:00:00Z is 7:00 PM Eastern (EDT) on Aug 26.
        { kind: 'callback', detail: 'Call back this evening', promised_at: '2026-08-26T23:00:00.000Z' },
      ],
    });
    expect(body).toContain('Call back this evening (by Wed Aug 26 at 7:00 PM)');
  });

  it('never carries an em dash, whatever the model wrote', () => {
    const body = composeCallNote({
      summary: 'Customer wants lights up early \u2014 before Thanksgiving.',
      commitments: [{ kind: 'other', detail: 'Confirm the date \u2014 then book it', promised_at: null }],
    });
    expect(body).not.toContain('\u2014');
    expect(body).toContain('Customer wants lights up early, before Thanksgiving.');
  });

  it('keeps one task on one line even when the detail contains newlines', () => {
    const body = composeCallNote({
      summary: SUMMARY,
      commitments: [{ kind: 'other', detail: 'Call the venue\nthen call the customer back', promised_at: null }],
    });
    const bullets = body.split('\n').filter(line => line.startsWith('- '));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toBe('- Call the venue then call the customer back');
  });

  it('refuses to compose a note with no summary', () => {
    expect(() => composeCallNote({ summary: '   ', commitments: [] })).toThrow();
  });

  it('orders timed tasks first, in time order, then untimed ones', () => {
    const body = composeCallNote({
      summary: SUMMARY,
      commitments: [
        { kind: 'other', detail: 'no time', promised_at: null },
        { kind: 'callback', detail: 'later', promised_at: '2026-08-26T23:00:00.000Z' },
        { kind: 'callback', detail: 'earlier', promised_at: '2026-08-26T18:00:00.000Z' },
      ],
    });
    const lines = body.split('\n').filter(line => line.startsWith('- '));
    expect(lines[0]).toContain('earlier');
    expect(lines[1]).toContain('later');
    expect(lines[2]).toContain('no time');
  });
});

describe('formatPromisedAt', () => {
  it('renders an Eastern wall clock, not UTC', () => {
    expect(formatPromisedAt('2026-08-26T23:00:00.000Z')).toBe('Wed Aug 26 at 7:00 PM');
  });

  it('returns null for a value it cannot read', () => {
    expect(formatPromisedAt(null)).toBeNull();
    expect(formatPromisedAt('not a date')).toBeNull();
  });
});
