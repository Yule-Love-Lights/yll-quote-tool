import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Row 413 — the autosave behaviour lives in src/lib/quoteEditDraft.ts with its
// own tests, but WHETHER QuoteBuilder actually calls it cannot be tested any
// other way here: the component is ~8000 lines with no render harness in this
// repo, and this repo's record (row 328) proved the point — a probe deleted a
// call-site guard with every test staying green. Same source-level technique
// as nceDepositWiring.test.ts, one assertion per defect class.
const root = resolve(__dirname, '../../..');
const builder = readFileSync(resolve(root, 'src/components/quote/QuoteBuilder.tsx'), 'utf8');

describe('edit-mode autosave is actually wired (row 413)', () => {
  it('stashes the dirty form against the exact last-persisted base', () => {
    // The base is what makes restore safe: quoteEditDraft refuses the draft
    // unless the server row still serializes to it. Stashing against anything
    // else (say, the current form) would break that CAS-style check.
    expect(builder).toContain('saveQuoteEditDraft(editQuoteId, form, lastPersistedForm)');
  });

  it('offers the draft against the mount-time server truth, never mid-session state', () => {
    expect(builder).toContain('loadQuoteEditDraft(editQuoteId, lastPersistedForm)');
    expect(builder).toContain('sweepQuoteEditDrafts()');
  });

  it('clears the stash only after a save made the form clean, never on an untouched mount', () => {
    // The offer banner holds the draft at mount while hasUnsavedEdits is
    // false. An unconditional clear on !hasUnsavedEdits would delete the very
    // draft being offered before the operator answers.
    // ...and a mere TOUCH that changed no payload (a contact-search
    // keystroke) must not delete it either while the offer is un-answered
    // (PR #972 fix round).
    expect(builder).toContain('if (userTouched && !editDraftOffer) clearQuoteEditDraft(editQuoteId);');
  });

  it('restore is an explicit operator action that arms the dirty machinery', () => {
    // Restoring must immediately re-arm the row-406 banner + beforeunload:
    // the restored form is by definition unsaved.
    expect(builder).toMatch(/userTouchedRef\.current = true;\s*\n\s*setUserTouched\(true\);\s*\n\s*setForm\(draft\.form\);/);
  });

  it('flushes a pending stash at unmount — the in-app-navigation door itself', () => {
    // Premerge HIGH: the debounce cleanup cancels the pending write, and an
    // in-app next/link click unmounts within the 800ms window — the original
    // row-406 loss reintroduced. The unmount flush is ref-based on purpose: a
    // cleanup-flush on the debounce effect would fire per keystroke.
    expect(builder).toMatch(/stashFlushRef\.current =\s+editMode && editQuoteId && hasUnsavedEdits/);
    expect(builder).toMatch(/return \(\) => \{\s+stashFlushRef\.current\?\.\(\);/);
  });

  it('the offer withdraws on a REAL edit, never from the capture-phase touch latch', () => {
    // PR #972 staff lens HIGH: markUserTouched runs from capture-phase
    // pointer handlers on the whole builder, so dismissing the offer there
    // unmounts the Restore button before its own click dispatches - Restore
    // became Discard. The dismissal lives in the stash effect's dirty branch
    // (a payload actually changed), deferred per the set-state rule.
    expect(builder).toMatch(/if \(editDraftOffer\) queueMicrotask\(\(\) => setEditDraftOffer\(null\)\);/);
    // And markUserTouched itself must NOT dismiss: its body contains no
    // setEditDraftOffer call.
    const fnStart = builder.indexOf('const markUserTouched = () => {');
    const fnEnd = builder.indexOf('};', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    expect(builder.slice(fnStart, fnEnd)).not.toContain('setEditDraftOffer(null);');
  });

  it('a base-mismatched draft surfaces the informational notice instead of vanishing', () => {
    expect(builder).toContain("if (draft === 'server-moved') queueMicrotask(() => setEditDraftDiscardedNotice(true));");
  });
});
