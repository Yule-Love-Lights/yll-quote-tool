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
    expect(builder).toContain('if (userTouched) clearQuoteEditDraft(editQuoteId);');
  });

  it('restore is an explicit operator action that arms the dirty machinery', () => {
    // Restoring must immediately re-arm the row-406 banner + beforeunload:
    // the restored form is by definition unsaved.
    expect(builder).toMatch(/userTouchedRef\.current = true;\s*\n\s*setUserTouched\(true\);\s*\n\s*setForm\(draft\.form\);/);
  });

  it('the first real edit withdraws the offer (markUserTouched)', () => {
    // Editing the server value and then restoring a stale draft on top would
    // itself be a clobber, so the offer self-dismisses on first touch.
    expect(builder).toMatch(/setUserTouched\(true\);\s*\n\s*\/\/ Row 413:[\s\S]{0,400}?setEditDraftOffer\(null\);/);
  });
});
