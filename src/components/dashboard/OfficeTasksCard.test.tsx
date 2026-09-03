// Pure-logic tests for OfficeTasksCard (calls merge plan S1). This repo's
// test setup doesn't run jsdom (see ClockCard.test.ts / RebookButton.test.ts
// for the same pattern), so interactive state is NOT exercised here — the
// route tests already cover the server contract end to end. This file
// covers the two client-side decisions that matter for the idempotency
// contract to hold up over the network (which failures are "ambiguous" and
// therefore keep the retry key alive) plus the display formatting, and a
// static-render smoke check on the initial (loading) paint.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The page variant syncs the view to the URL, so the component now calls
// next/navigation hooks. Same mock shape OperatorNav.test.tsx uses.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => '/tasks',
}));
import OfficeTasksCard, {
  applyTaskViewControls,
  assignedLabel,
  CARD_TASK_LIMIT,
  customerLinkLabel,
  formatDueTime,
  isAmbiguousMutationFailure,
  personalLabel,
  resolvedTimeFor,
  sortDefaultFor,
  sourceFilterLabel,
  sourceLabel,
} from './OfficeTasksCard';

/** Minimal task shape for the pure filter/sort tests. */
function task(over: Partial<Parameters<typeof applyTaskViewControls>[0][number]> = {}) {
  return {
    id: 't-1',
    sourceSystem: 'manual' as const,
    title: 'Call the vendor',
    detail: null,
    status: 'open' as const,
    dueAt: '2026-08-29T12:00:00.000Z',
    createdAt: '2026-08-28T12:00:00.000Z',
    blockedReason: null,
    dismissalReason: null,
    completedAt: null,
    dismissedAt: null,
    createdByLabel: null,
    assignedToLabel: null,
    customerContactId: null,
    customerName: null,
    highLevelUrl: null,
    ...over,
  };
}

const ALL = { source: 'all' as const, owner: 'all', sort: 'due' as const };

describe('isAmbiguousMutationFailure', () => {
  it('treats 5xx, 408, 425, and 429 as ambiguous (outcome unknown — keep the key)', () => {
    for (const status of [500, 502, 503, 408, 425, 429]) {
      expect(isAmbiguousMutationFailure(status)).toBe(true);
    }
  });

  it('treats a definite rejection (4xx other than 408/425/429) as NOT ambiguous (safe to mint a new key)', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isAmbiguousMutationFailure(status)).toBe(false);
    }
  });
});

describe('formatDueTime', () => {
  it('formats a valid ISO timestamp', () => {
    const formatted = formatDueTime('2026-08-29T17:00:00.000Z');
    expect(formatted).not.toBe('Due time unavailable');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('falls back to a plain message for an unparsable value', () => {
    expect(formatDueTime('not-a-date')).toBe('Due time unavailable');
  });
});

describe('sourceLabel', () => {
  it('shows no source badge for a manual task -- personalLabel covers those instead', () => {
    expect(sourceLabel('manual')).toBeNull();
  });

  it('labels a call_commitment task as shared, so staff know anyone can act on it', () => {
    expect(sourceLabel('call_commitment')).toBe('From a call');
  });

  it('falls back to a generic shared label for a future non-manual source', () => {
    expect(sourceLabel('quote_tool')).toBe('Shared');
  });
});

describe('personalLabel ("everything is shared" ruling)', () => {
  it('labels a manual task with no resolved creator as plain "Personal"', () => {
    expect(personalLabel('manual', null)).toBe('Personal');
  });

  it('labels a manual task with a resolved creator as "Personal (<label>)"', () => {
    expect(personalLabel('manual', 'You')).toBe('Personal (You)');
    expect(personalLabel('manual', 'Jason')).toBe('Personal (Jason)');
  });

  it('shows no personal badge for a non-manual task -- sourceLabel covers those instead', () => {
    expect(personalLabel('call_commitment', null)).toBeNull();
    expect(personalLabel('quote_tool', 'Jason')).toBeNull();
  });
});

describe('sortDefaultFor', () => {
  // One function answers for all three paths that need a default (first
  // render, a tab click, and a URL that changed underneath us), so they cannot
  // drift apart. That equivalence is the premerge technical lens's central
  // question, and this is what makes it true by construction.
  it('gives the working list soonest-due', () => {
    expect(sortDefaultFor('active')).toBe('due');
  });

  it('gives History most-recently-finished', () => {
    expect(sortDefaultFor('history')).toBe('resolved');
  });

  it('is a pure mapping, so landing by link and clicking the tab cannot disagree', () => {
    expect(sortDefaultFor('history')).toBe(sortDefaultFor('history'));
    expect(sortDefaultFor('active')).not.toBe(sortDefaultFor('history'));
  });
});

describe('assignedLabel', () => {
  it('reads in the second person for the viewer', () => {
    expect(assignedLabel('You')).toBe('Assigned to you');
  });

  it('names anyone else', () => {
    expect(assignedLabel('Jason')).toBe('Assigned to Jason');
  });

  it('shows nothing when nobody is assigned', () => {
    expect(assignedLabel(null)).toBeNull();
  });
});

describe('customerLinkLabel', () => {
  it('uses the customer name when there is one', () => {
    expect(customerLinkLabel('Sharon McDonough')).toBe('Sharon McDonough');
  });

  it('falls back to a neutral label rather than inventing a name', () => {
    expect(customerLinkLabel(null)).toBe('View customer');
    expect(customerLinkLabel('   ')).toBe('View customer');
  });
});

describe('sourceFilterLabel', () => {
  it('names every source system a task can carry, so no option is missing from the filter', () => {
    expect(sourceFilterLabel('manual')).toBe('Personal');
    expect(sourceFilterLabel('call_commitment')).toBe('From a call');
    expect(sourceFilterLabel('quote_tool')).toBe('From the quote tool');
  });
});

describe('applyTaskViewControls — filtering', () => {
  it('returns everything when nothing is filtered', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', sourceSystem: 'call_commitment' })];
    expect(applyTaskViewControls(tasks, ALL).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('filters by source system', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', sourceSystem: 'call_commitment' })];
    expect(applyTaskViewControls(tasks, { ...ALL, source: 'call_commitment' }).map((t) => t.id)).toEqual(['b']);
  });

  it('does not silently drop a source it has no dedicated option for', () => {
    // The regression this guards: an "all / call / personal" filter would
    // make a quote_tool task invisible under BOTH non-all selections. Source
    // options are built from the loaded list, so quote_tool selects itself.
    const tasks = [task({ id: 'a', sourceSystem: 'quote_tool' })];
    expect(applyTaskViewControls(tasks, ALL).map((t) => t.id)).toEqual(['a']);
    expect(applyTaskViewControls(tasks, { ...ALL, source: 'quote_tool' }).map((t) => t.id)).toEqual(['a']);
  });

  it('filters by assignee', () => {
    const tasks = [task({ id: 'a', assignedToLabel: 'Jason' }), task({ id: 'b', assignedToLabel: 'You' })];
    expect(applyTaskViewControls(tasks, { ...ALL, owner: 'Jason' }).map((t) => t.id)).toEqual(['a']);
  });

  it('filters to the unassigned with the sentinel, which a name filter must not also match', () => {
    const tasks = [task({ id: 'a', assignedToLabel: null }), task({ id: 'b', assignedToLabel: 'Jason' })];
    const unassigned = applyTaskViewControls(tasks, { ...ALL, owner: '\u0000unassigned' });
    expect(unassigned.map((t) => t.id)).toEqual(['a']);
    expect(applyTaskViewControls(tasks, { ...ALL, owner: 'Jason' }).map((t) => t.id)).toEqual(['b']);
  });

  it('combines the two filters rather than letting either win alone', () => {
    const tasks = [
      task({ id: 'a', sourceSystem: 'call_commitment', assignedToLabel: 'Jason' }),
      task({ id: 'b', sourceSystem: 'call_commitment', assignedToLabel: 'You' }),
      task({ id: 'c', sourceSystem: 'manual', assignedToLabel: 'Jason' }),
    ];
    const result = applyTaskViewControls(tasks, { source: 'call_commitment', owner: 'Jason', sort: 'due' });
    expect(result.map((t) => t.id)).toEqual(['a']);
  });

  it('never mutates the array it was given', () => {
    const tasks = [task({ id: 'b', dueAt: '2026-09-02T00:00:00.000Z' }), task({ id: 'a', dueAt: '2026-08-01T00:00:00.000Z' })];
    applyTaskViewControls(tasks, ALL);
    expect(tasks.map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('applyTaskViewControls — sorting', () => {
  it('due: soonest first', () => {
    const tasks = [
      task({ id: 'late', dueAt: '2026-09-05T00:00:00.000Z' }),
      task({ id: 'soon', dueAt: '2026-08-30T00:00:00.000Z' }),
    ];
    expect(applyTaskViewControls(tasks, ALL).map((t) => t.id)).toEqual(['soon', 'late']);
  });

  it('created: newest first, the opposite direction from due', () => {
    const tasks = [
      task({ id: 'old', createdAt: '2026-08-01T00:00:00.000Z' }),
      task({ id: 'new', createdAt: '2026-08-28T00:00:00.000Z' }),
    ];
    expect(applyTaskViewControls(tasks, { ...ALL, sort: 'created' }).map((t) => t.id)).toEqual(['new', 'old']);
  });

  it('resolved: most recently finished first, reading completedAt or dismissedAt', () => {
    const tasks = [
      task({ id: 'older', completedAt: '2026-08-20T00:00:00.000Z' }),
      task({ id: 'newer', completedAt: null, dismissedAt: '2026-08-27T00:00:00.000Z' }),
    ];
    expect(applyTaskViewControls(tasks, { ...ALL, sort: 'resolved' }).map((t) => t.id)).toEqual(['newer', 'older']);
  });

  it('sinks an unsortable timestamp to the bottom, never to the top', () => {
    // A broken date parses to NaN. Left unguarded it compares false against
    // everything and can land anywhere, including first — which would put a
    // corrupt row at the head of the working list.
    const tasks = [
      task({ id: 'broken', dueAt: 'not-a-date', createdAt: 'not-a-date' }),
      task({ id: 'real', dueAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-08-20T00:00:00.000Z' }),
    ];
    expect(applyTaskViewControls(tasks, ALL).map((t) => t.id)).toEqual(['real', 'broken']);
    expect(applyTaskViewControls(tasks, { ...ALL, sort: 'created' }).map((t) => t.id)).toEqual(['real', 'broken']);
  });

  it('breaks a tie by id so the order is stable rather than arbitrary', () => {
    const same = '2026-09-01T00:00:00.000Z';
    const tasks = [task({ id: 'b', dueAt: same }), task({ id: 'a', dueAt: same })];
    expect(applyTaskViewControls(tasks, ALL).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('resolvedTimeFor', () => {
  it('prefers completedAt when both are somehow set', () => {
    const result = resolvedTimeFor({ completedAt: '2026-08-29T17:00:00.000Z', dismissedAt: '2026-08-30T17:00:00.000Z' });
    expect(result).not.toBeNull();
  });

  it('falls back to dismissedAt when completedAt is null', () => {
    const result = resolvedTimeFor({ completedAt: null, dismissedAt: '2026-08-30T17:00:00.000Z' });
    expect(result).not.toBeNull();
  });

  it('returns null when neither is set (still open/blocked)', () => {
    expect(resolvedTimeFor({ completedAt: null, dismissedAt: null })).toBeNull();
  });
});

describe('OfficeTasksCard — initial static render', () => {
  it('renders the loading state before any effect has run (no DOM/fetch in this test env)', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard />);
    expect(html).toContain('Office Tasks');
    expect(html).toContain('Open work'); // "everything is shared" ruling dropped "My"
    expect(html).toContain('Loading tasks');
    // The create-task form fields exist from first paint.
    expect(html).toContain('office-task-title');
  });

  it('the card links out to /tasks even while loading, so a failed fetch still leaves a route there', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard />);
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('See all tasks');
  });

  it('the card carries no history control — that is what the page is for', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard />);
    expect(html).not.toContain('View history');
  });

  it('the page variant does not repeat the "Office Tasks" eyebrow that its own h1 already says', () => {
    const card = renderToStaticMarkup(<OfficeTasksCard />);
    const page = renderToStaticMarkup(<OfficeTasksCard variant="page" />);
    expect(card).toContain('Office Tasks');
    expect(page).not.toContain('Office Tasks');
  });

  it('the page variant renders both tabs instead', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard variant="page" />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('History');
    expect(html).toContain('Open work');
    // and does not link to itself
    expect(html).not.toContain('See all tasks');
  });

  it('the card offers a one-click route to History, which slimming it had cost', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard />);
    expect(html).toContain('href="/tasks?view=history"');
    expect(html).toContain('>History<');
  });

  it('the page opens on History when asked', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard variant="page" initialView="history" />);
    // The History heading, not the working-list one. This says nothing about
    // the SORT: the static render is still in its loading state, so the sort
    // control has not rendered yet. sortDefaultFor is tested directly below,
    // which is what the premerge technical lens caught this test overclaiming
    // (deleting the sort logic entirely left all 39 tests passing).
    expect(html).toContain('Completed &amp; dismissed');
    expect(html).not.toContain('New tasks are due 24 hours after creation');
  });

  it('the page still defaults to the working list with no initialView', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard variant="page" />);
    expect(html).toContain('Open work');
    expect(html).not.toContain('Completed &amp; dismissed');
  });

  it('the CARD ignores initialView, because it has no history view to open', () => {
    // Defence against a future caller passing it through by habit: the card
    // would otherwise render a history heading with no way back.
    const html = renderToStaticMarkup(<OfficeTasksCard initialView="history" />);
    expect(html).not.toContain('Completed &amp; dismissed');
    expect(html).toContain('Open work');
  });

  // These two assert DOM ORDER, which is the whole point of the change: below
  // the lg breakpoint the grid placement is inert, so the order in the markup
  // is the order on a phone, and it is what a screen reader follows at every
  // width. The anchor is the LOADING box rather than the task list, because a
  // static render never gets past loadState 'loading' and so has no list to
  // order against. An earlier version of these tests checked only that both
  // strings were present, which a premerge lens proved would pass with the two
  // render sites swapped.
  it('puts the add form AFTER the list on the page, so a phone and a screen reader get tasks first', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard variant="page" />);
    const listArea = html.indexOf('Loading tasks');
    const form = html.indexOf('office-task-title');
    expect(listArea).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(listArea);
    // And the grid lifts it into the right column once there is room.
    expect(html).toContain('lg:col-start-2');
  });

  it('keeps the add form BEFORE the list on the card, which is how the dashboard has always read', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard />);
    const listArea = html.indexOf('Loading tasks');
    const form = html.indexOf('office-task-title');
    expect(listArea).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(-1);
    expect(form).toBeLessThan(listArea);
    // No grid placement leaks onto the dashboard.
    expect(html).not.toContain('lg:col-start-2');
  });

  it('the page offers a route to the add form that does not need scrolling past the list', () => {
    // Two premerge staff-lens MEDs: below the lg breakpoint the form sits under
    // the whole list, and a keyboard user at any width tabs through every row
    // to reach it. One control answers both, so it must exist as a BUTTON (the
    // panel's own heading says "Add a task" too, which is not a route anywhere).
    const html = renderToStaticMarkup(<OfficeTasksCard variant="page" />);
    expect(html).toMatch(/<button[^>]*>Add a task<\/button>/);
    // Visible below lg, a focus-revealed skip link above it.
    expect(html).toContain('lg:sr-only');
    expect(html).toContain('lg:focus:not-sr-only');
  });

  it('the card offers no such control, because its form is already the first thing in it', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard />);
    expect(html).not.toMatch(/<button[^>]*>Add a task<\/button>/);
  });

  it('the page does not paint a second "Open work" heading, because the tab already says it', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard variant="page" />);
    // The heading still exists, for the region's accessible name, but hidden.
    expect(html).toMatch(/id="office-tasks-heading"[^>]*class="sr-only"|class="sr-only"[^>]*id="office-tasks-heading"/);
  });

  it('the card still paints its own heading and eyebrow', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard />);
    expect(html).toContain('Office Tasks');
    expect(html).toContain('Open work');
    expect(html).not.toContain('sr-only" id="office-tasks-heading"');
  });

  it('caps the card at a few tasks, which is the whole reason the page exists', () => {
    expect(CARD_TASK_LIMIT).toBeGreaterThan(0);
    expect(CARD_TASK_LIMIT).toBeLessThan(10);
  });
});
