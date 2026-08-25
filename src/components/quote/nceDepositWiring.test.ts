import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Row 328 (delta-verify MED): the money behaviour lives in pure functions with
// their own tests, but WHETHER QuoteBuilder actually calls them cannot be
// tested any other way here — the component is ~7000 lines with no render
// harness in this repo, and a probe proved the point: deleting the chip-change
// guard at its call site left all 744 tests green.
//
// So these are source-level assertions, the same technique
// designEditorWiring.test.ts and StaffNotesPanel.test.tsx already use to pin
// their own call sites. Each one corresponds to a defect a lens actually found.
const root = resolve(__dirname, '../../..');
const builder = readFileSync(resolve(root, 'src/components/quote/QuoteBuilder.tsx'), 'utf8');

describe('the NCE deposit rules are actually wired (row 328)', () => {
  it('suppresses the deposit move on the async inherit path when the quote left draft', () => {
    expect(builder).toContain('applyIsNce(inheritedNce, { moveDeposit: !quoteLeftDraft })');
  });

  it('feeds the notice the real chip-change answer, not a constant', () => {
    expect(builder).toContain('const chipWouldChange = inheritedNce !== isNceRef.current;');
    expect(builder).toMatch(/nceTagDepositWasSuppressed\(\{\s*chipWouldChange,/);
  });

  it('claims deposit provenance through the rule, never unconditionally', () => {
    expect(builder).toContain('nceDepositSetByRuleRef.current = shouldClaimNceDepositProvenance({');
    // The pre-fix line was a bare `= next`. If it ever comes back, the rule is
    // being bypassed and a hand-typed 40 is up for adoption again.
    expect(builder).not.toContain('nceDepositSetByRuleRef.current = next;');
  });

  // Every path that changes which contact the quote points at, or that acts on
  // the deposit deliberately, must retire a standing notice — a lens found two
  // of these missing, one per round.
  //
  // Asserted SITE BY SITE, not by counting. A delta-verify ran the obvious
  // attack on the count version: delete the real clear in the contact pick, add
  // a spurious one in an unrelated handler, and the total stays at four with
  // every test green while the stale-notice bug ships. designEditorWiring.test
  // .ts warns about exactly this shape; round 2 cited that precedent without
  // applying it, which is how the hole got here.
  const clearsIn = (fnName: string, marker: string) => {
    const start = builder.indexOf(fnName);
    expect(start).toBeGreaterThan(-1);
    const end = builder.indexOf(marker, start);
    expect(end).toBeGreaterThan(start);
    return builder.slice(start, end).includes('setNceDepositHeldBack(null)');
  };

  it('clears it when a new contact pick supersedes the old one', () => {
    // Between the pick handler's start and the tag-lookup fetch it fires.
    expect(clearsIn('const pickHighLevelContact = (c: CrmContact) => {', 'const tagLookupSeq')).toBe(true);
  });

  it('clears it when the contact is unlinked entirely', () => {
    expect(clearsIn('const clearHighLevelContact = () => {', 'attachSeqRef.current++')).toBe(true);
  });

  it('clears it when the staffer edits the deposit themselves', () => {
    // The deposit input's own onChange, which already clears rule provenance.
    expect(clearsIn('nceDepositSetByRuleRef.current = false;', "set('depositPercent'")).toBe(true);
  });

  it('clears it when a deliberate chip move actually changes the deposit', () => {
    expect(clearsIn('const applyIsNce = (next: boolean', 'const wasRuleSet')).toBe(true);
  });
});
