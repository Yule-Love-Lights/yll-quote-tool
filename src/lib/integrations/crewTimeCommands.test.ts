import { describe, expect, it } from 'vitest';

import { isDepartMissingReason, parseCrewTimeCommand } from './crewTimeCommands';
import { WHATSAPP_HELP } from './whatsappCommands';

describe('parseCrewTimeCommand — the simple punches', () => {
  it('recognises clock in across the words crew actually type', () => {
    for (const t of ['in', '/in', 'IN', '  in  ', 'clock in', 'clockin', 'start', 'here', 'on']) {
      expect(parseCrewTimeCommand(t)).toEqual({ kind: 'clock_in' });
    }
  });

  it('recognises clock out', () => {
    for (const t of ['out', '/out', 'Clock Out', 'clockout', 'end', 'off', 'home']) {
      expect(parseCrewTimeCommand(t)).toEqual({ kind: 'clock_out' });
    }
  });

  it('recognises break start and break end as different things', () => {
    for (const t of ['break', 'lunch', '/break']) {
      expect(parseCrewTimeCommand(t)).toEqual({ kind: 'break_start' });
    }
    for (const t of ['back', 'resume', '/back']) {
      expect(parseCrewTimeCommand(t)).toEqual({ kind: 'break_end' });
    }
  });

  // Row 336: the old name claimed `help` coverage that never existed, and
  // PR #818 removed the help kind entirely — a test name ships as
  // documentation, so it names exactly what it asserts.
  it('recognises status, and done/finished as complete', () => {
    expect(parseCrewTimeCommand('status')).toEqual({ kind: 'status' });
    expect(parseCrewTimeCommand('done')).toEqual({ kind: 'complete' });
    expect(parseCrewTimeCommand('finished')).toEqual({ kind: 'complete' });
  });
});

describe('arrive', () => {
  it('parses a job number in the shapes crew type it', () => {
    for (const t of ['arrive 1042', '/arrive 1042', 'at 1042', 'job 1042', 'arrive #1042']) {
      expect(parseCrewTimeCommand(t)).toEqual({ kind: 'arrive', jobNumber: 1042 });
    }
  });

  it('refuses a non-numeric or absent job', () => {
    expect(parseCrewTimeCommand('arrive')).toBeNull();
    expect(parseCrewTimeCommand('arrive soon')).toBeNull();
    expect(parseCrewTimeCommand('arrive 12abc')).toBeNull();
  });

  it('refuses job zero', () => {
    expect(parseCrewTimeCommand('arrive 0')).toBeNull();
  });
});

describe('depart — the reason is required, never defaulted', () => {
  it('maps crew words to the contract reasons', () => {
    expect(parseCrewTimeCommand('depart rain')).toEqual({ kind: 'depart', reason: 'weather' });
    expect(parseCrewTimeCommand('depart weather')).toEqual({ kind: 'depart', reason: 'weather' });
    expect(parseCrewTimeCommand('depart snow')).toEqual({ kind: 'depart', reason: 'weather' });
    expect(parseCrewTimeCommand('depart locked')).toEqual({ kind: 'depart', reason: 'no_access' });
    expect(parseCrewTimeCommand('depart dog')).toEqual({ kind: 'depart', reason: 'no_access' });
    expect(parseCrewTimeCommand('depart materials')).toEqual({
      kind: 'depart',
      reason: 'materials',
    });
    expect(parseCrewTimeCommand('leave other')).toEqual({ kind: 'depart', reason: 'other' });
  });

  it('REFUSES a bare depart rather than defaulting a reason', () => {
    // A defaulted `completed` would mark a rained-out job finished and poison
    // the budgeted-hours learning signal, which cannot be backfilled.
    expect(parseCrewTimeCommand('depart')).toBeNull();
    expect(parseCrewTimeCommand('/depart')).toBeNull();
    expect(parseCrewTimeCommand('leaving')).toBeNull();
  });

  it('refuses an unrecognised reason rather than guessing', () => {
    expect(parseCrewTimeCommand('depart because reasons')).toBeNull();
    expect(parseCrewTimeCommand('depart lunch')).toBeNull();
  });

  it('never accepts `completed` as a depart reason — that path is `done`', () => {
    // Two routes to the same claim would drift, and only `done` moves the job
    // status to installed.
    expect(parseCrewTimeCommand('depart completed')).toBeNull();
    expect(parseCrewTimeCommand('depart done')).toBeNull();
  });

  it('isDepartMissingReason spots the case worth coaching', () => {
    expect(isDepartMissingReason('depart')).toBe(true);
    expect(isDepartMissingReason('depart because reasons')).toBe(true);
    expect(isDepartMissingReason('depart rain')).toBe(false);
    expect(isDepartMissingReason('in')).toBe(false);
    expect(isDepartMissingReason('hello everyone')).toBe(false);
  });
});

describe('it stays silent on ordinary chatter — the safe default', () => {
  it('returns null for normal group conversation', () => {
    for (const t of [
      'on my way',
      'anyone got a spare ladder',
      'the customer wants blue lights',
      'ok',
      'yes',
      'running late',
      '',
      '   ',
      'break the ladder down first',
      'we are done with the north side',
    ]) {
      expect(parseCrewTimeCommand(t)).toBeNull();
    }
  });

  it('does not fire on a sentence that merely contains a keyword', () => {
    // "start" alone is a clock-in; "start the generator" must not be.
    expect(parseCrewTimeCommand('start')).toEqual({ kind: 'clock_in' });
    expect(parseCrewTimeCommand('start the generator')).toBeNull();
    expect(parseCrewTimeCommand('I am done with lunch')).toBeNull();
  });
});

describe('help belongs to the EXISTING bot, not to us', () => {
  it('does NOT claim help / commands / ?', () => {
    // Claiming these served crew time-clock help to every user in every chat in
    // place of the real bot help. The crew commands live in WHATSAPP_HELP now.
    for (const t of ['help', 'commands', '?', '/help']) {
      expect(parseCrewTimeCommand(t)).toBeNull();
    }
  });

  it('still lists the commands and reason words somewhere a crew member sees', () => {
    for (const needle of ['in', 'out', 'break', 'back', 'arrive', 'done', 'depart', 'status']) {
      expect(WHATSAPP_HELP).toContain(needle);
    }
    expect(WHATSAPP_HELP).toContain('weather');
    expect(WHATSAPP_HELP).toContain('unpaid');
  });
});
