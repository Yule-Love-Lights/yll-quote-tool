// The shared shift-row renderer, where the admin record and the staff
// self-view meet. Everything pinned here is a difference between those two
// readers, or a thing the pre-merge round found wrong.
//
// `actorLabel` is tested as a pure function AND through the rendered row: the
// function being right buys nothing if the row stops calling it.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { HoursDayList, actorLabel, hasPlaceholderTimes } from './HoursDayList';
import type { PersonDay, PersonShift } from '@/lib/personHours';

function shift(over: Partial<PersonShift> = {}): PersonShift {
  return {
    id: 'shift-1',
    clockInAt: '2026-09-01T13:00:00.000Z',
    clockOutAt: '2026-09-01T21:00:00.000Z',
    paidSeconds: 8 * 3600,
    breakSeconds: 0,
    source: 'office',
    closeSource: 'office',
    manualBy: null,
    removable: false,
    settlementId: null,
    settledSeconds: 0,
    ...over,
  };
}

function day(over: Partial<PersonShift> = {}): PersonDay[] {
  return [{ day: '2026-09-01', paidSeconds: 8 * 3600, shifts: [shift(over)] }];
}

function render(
  controls: 'admin' | 'none',
  over: Partial<PersonShift> = {},
  showPaidMarks = false,
) {
  return renderToStaticMarkup(
    <HoursDayList
      days={day(over)}
      crewName="Khaye"
      controls={controls}
      evidenceFor={() => null}
      showPaidMarks={showPaidMarks}
    />,
  );
}

describe('actorLabel', () => {
  it('keeps the whole stamp for an admin, who may need the email to tell two people apart', () => {
    expect(actorLabel('Naldo (naldo@yulelovelights.com)', 'admin')).toBe(
      'Naldo (naldo@yulelovelights.com)',
    );
  });

  it('drops the login email for a non-admin reader, keeping the name', () => {
    expect(actorLabel('Naldo (naldo@yulelovelights.com)', 'none')).toBe('Naldo');
  });

  it('leaves a stamp that carries no parenthetical exactly as it is', () => {
    // gateActor's name-only and email-only fallbacks. An email-only stamp is
    // the one case this cannot improve: there is no name behind it, and
    // blanking it would hide who changed someone's hours on the page whose
    // whole job is saying so.
    expect(actorLabel('Naldo', 'none')).toBe('Naldo');
    expect(actorLabel('naldo@yulelovelights.com', 'none')).toBe('naldo@yulelovelights.com');
    expect(actorLabel('admin', 'none')).toBe('admin');
  });

  it('does not eat a name that merely contains brackets mid-string', () => {
    expect(actorLabel('Naldo (the owner) Balroop', 'none')).toBe('Naldo (the owner) Balroop');
  });
});

describe('HoursDayList — what each reader sees', () => {
  it("keeps an admin's login email off a staff member's own hours page", () => {
    const staff = render('none', { manualBy: 'Naldo (naldo@yulelovelights.com)' });
    expect(staff).toContain('typed by Naldo');
    expect(staff).not.toContain('naldo@yulelovelights.com');

    // The admin record is unchanged — this is a self-view rule, not a
    // repo-wide redaction.
    const admin = render('admin', { manualBy: 'Naldo (naldo@yulelovelights.com)' });
    expect(admin).toContain('typed by Naldo (naldo@yulelovelights.com)');
  });

  it('stops asking for a correction that has already been made', () => {
    // close_source stays 'system' forever once the sweep closed a shift, so a
    // corrected row kept nagging directly above its own "typed by" stamp.
    // Seen live on a real prod row during the phase 4 browser check.
    const corrected = render('none', {
      closeSource: 'system',
      manualBy: 'Naldo (naldo@yulelovelights.com)',
    });
    expect(corrected).toContain('since corrected');
    expect(corrected).not.toContain('tell the office what time you stopped');

    // Still nags while it is genuinely uncorrected.
    const raw = render('none', { closeSource: 'system' });
    expect(raw).toContain('tell the office what time you stopped');
    expect(raw).not.toContain('since corrected');
  });

  it('lets the long sweep badge WRAP, or it is clipped away on a phone', () => {
    // The day card is overflow-hidden, so a nowrap badge wider than the card
    // loses its last words rather than pushing the page wide — measured at
    // 385px of text inside a 359px card at 375px wide, and invisible to a
    // page-level overflow check for exactly that reason.
    const html = render('none', { closeSource: 'system' });
    const badge = html.match(/<span class="rounded-full bg-amber-50[^"]*"/)?.[0] ?? '';
    expect(badge).not.toBe('');
    expect(badge).not.toContain('whitespace-nowrap');
  });

  it('renders no control of any kind for a staff reader, and all of them for an admin', () => {
    const staff = render('none', { removable: true });
    expect(staff).not.toContain('>Edit</button>');
    expect(staff).not.toContain('>Remove</button>');

    const admin = render('admin', { removable: true });
    expect(admin).toContain('>Edit</button>');
    expect(admin).toContain('>Remove</button>');
  });

  it('tells an admin a paid shift is locked, and never shows a staff reader the lock copy', () => {
    const admin = render('admin', { settlementId: 'settlement-1' });
    expect(admin).toContain('undo the payment below');

    // The self-view never reads settlements, so settlementId is always null
    // there — but if one ever arrived, it must still draw nothing.
    const staff = render('none', { settlementId: 'settlement-1' });
    expect(staff).not.toContain('undo the payment below');
  });
});

describe('HoursDayList — the Paid mark', () => {
  const WHOLE = { settlementId: 'settlement-1', settledSeconds: 8 * 3600 };
  const PART = { settlementId: 'settlement-1', settledSeconds: 3 * 3600 };

  it('marks a fully paid shift for a staff reader who asked for the marks', () => {
    expect(render('none', WHOLE, true)).toContain('>Paid<');
  });

  it('says PART paid, with the hours, when a payment stopped half way through', () => {
    // The whole reason for the rollover: a shift can be covered in part, and
    // saying only "Paid" there would claim money that was never handed over.
    const html = render('none', PART, true);
    expect(html).toContain('3h 00m of 8h 00m paid');
    expect(html).not.toContain('>Paid<');
  });

  it('marks nothing when the caller did NOT ask — the default', () => {
    // The default is off so a caller that has not thought about whether its
    // settlement data is trustworthy cannot render a payment claim by
    // accident. This is the failed-read path on the staff page.
    expect(render('none', WHOLE)).not.toContain('>Paid<');
  });

  it('never marks an unsettled shift, however loudly the caller asks', () => {
    expect(render('none', { settlementId: null, settledSeconds: 0 }, true)).not.toContain('>Paid<');
  });

  it('does not call a PART-paid shift simply "Paid" on the admin row', () => {
    // Seen live on Khaye's 28 Aug row: 3h 48m of a 4h 23m shift, reading a
    // bare "Paid". The LOCK is unconditional — any live payment refuses an
    // edit — but the claim about money is not.
    const admin = render('admin', PART, true);
    expect(admin).toContain('3h 00m of this is paid');
    expect(admin).toContain('undo the payment below');
    expect(admin).not.toContain('Paid — undo');
  });

  it('still says plainly PAID when the whole shift is covered', () => {
    expect(render('admin', WHOLE, true)).toContain('Paid — undo');
  });

  it('leaves the admin row to its own lock copy rather than adding a mark', () => {
    const admin = render('admin', WHOLE, true);
    expect(admin).not.toContain('>Paid<');
    expect(admin).toContain('undo the payment below');
  });
});

describe('a shift whose clock times are a PLACEHOLDER', () => {
  // The row-507 import had a date and a duration and no start time, so its
  // shifts are anchored at a fixed hour. They are `source: office`, which
  // renders as "web clock" — so before this they read as ordinary punches
  // with precise times, and 142 of Jason's real rows do (S61 admin lens).
  const IMPORTED = { manualBy: 'imported from Time Tracker.xlsx (row 507)' };

  it('is recognised by its import stamp, and an ordinary manual edit is NOT', () => {
    expect(hasPlaceholderTimes('imported from Time Tracker.xlsx (row 507)')).toBe(true);
    expect(hasPlaceholderTimes('Jason Balroop (jason@yulelovelights.com)')).toBe(false);
    expect(hasPlaceholderTimes(null)).toBe(false);
  });

  it('says it came from a timesheet instead of claiming to be a web clock punch', () => {
    const out = render('admin', IMPORTED);
    expect(out).toContain('imported from a timesheet');
    expect(out).not.toContain('web clock');
  });

  it('flags the start time as approximate, so a precise-looking time is not read as real', () => {
    expect(render('admin', IMPORTED)).toContain('start time approximate');
  });

  it('leaves a REAL punch alone — it still names how they clocked in', () => {
    const out = render('admin');
    expect(out).toContain('web clock');
    expect(out).not.toContain('start time approximate');
    expect(out).not.toContain('imported from a timesheet');
  });

  it('says the same thing on the staff self-view, which reads the same rows', () => {
    const out = render('none', IMPORTED);
    expect(out).toContain('imported from a timesheet');
    expect(out).toContain('start time approximate');
  });
});
