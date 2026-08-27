import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Row 206 — a stale new-quote localStorage draft (src/lib/quoteDraft.ts) can
// silently overwrite a lead prefill's serviceType and fight the picked-contact
// chip: the restore effect's ONLY guard was customerIsEmpty(form.customer),
// and applyPrefill has already written form.customer by the time it runs — so
// a prefill carrying serviceType/ghlContactId but no name/phone/email/address
// leaves form.customer empty, and the effect restores right over it. The fix
// lives entirely inside QuoteBuilder's draft-restore effect (a call site, not
// src/lib/quoteDraft.ts, which has its own untouched tests) — same situation
// row 413 was in, same source-level technique as editDraftWiring.test.ts:
// this component is ~8000 lines with no render harness in this repo, and row
// 328 already proved a call-site guard can vanish with every other test green.
const root = resolve(__dirname, '../../..');
// Normalize CRLF -> LF (this checkout's source files are CRLF on Windows) so
// every literal newline in the assertions below matches regardless of the
// checkout's line-ending config.
const builder = readFileSync(resolve(root, 'src/components/quote/QuoteBuilder.tsx'), 'utf8').replace(/\r\n/g, '\n');

describe('new-quote draft restore skips on an incoming prefill (row 206)', () => {
  it('the restore effect checks prefill before ever loading/applying the draft', () => {
    const effectStart = builder.indexOf('if (!draftActive || draftRestoreTriedRef.current) return;');
    expect(effectStart).toBeGreaterThan(-1);
    const effectEnd = builder.indexOf('}, []);', effectStart);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const body = builder.slice(effectStart, effectEnd);

    const prefillGuardIdx = body.indexOf('if (prefill) {');
    const loadDraftIdx = body.indexOf('const draft = loadQuoteDraft();');
    const restoreCallIdx = body.indexOf('setForm((f) =>');
    expect(prefillGuardIdx).toBeGreaterThan(-1);
    expect(loadDraftIdx).toBeGreaterThan(-1);
    expect(restoreCallIdx).toBeGreaterThan(-1);
    // The prefill check must run BEFORE the unconditional draft load/restore
    // path — a guard placed after either would be inert (a mutation-probe
    // technique: moving this check below loadQuoteDraft would still let the
    // clobber through on the way to it).
    expect(prefillGuardIdx).toBeLessThan(loadDraftIdx);
    expect(prefillGuardIdx).toBeLessThan(restoreCallIdx);
  });

  it('a prefill branch returns without ever calling setForm (the actual clobber)', () => {
    const guardIdx = builder.indexOf('if (prefill) {\n      if (loadQuoteDraft()) queueMicrotask(() => setDraftWithheldByPrefill(true));\n      return;\n    }');
    expect(guardIdx).toBeGreaterThan(-1);
  });

  it('the withheld draft is announced, not silently dropped — and the draft is never cleared', () => {
    expect(builder).toContain('{draftWithheldByPrefill && (');
    // The notice's own block must not call clearQuoteDraft/clearDraftAndReset
    // — the fix leaves the stashed draft in storage for a later plain
    // /quote/new visit, it only skips restoring it here.
    const noticeStart = builder.indexOf('{draftWithheldByPrefill && (');
    const noticeEnd = builder.indexOf('\n            )}', noticeStart);
    expect(noticeEnd).toBeGreaterThan(noticeStart);
    const notice = builder.slice(noticeStart, noticeEnd);
    expect(notice).not.toContain('clearQuoteDraft');
    expect(notice).not.toContain('clearDraftAndReset');
  });

  it('the prefill guard gates on whether a prefill was applied at all, not on which fields it carried', () => {
    // prefill is only ever truthy when NewQuotePage found at least one of
    // name/email/phone/address/serviceType/ghlContactId (src/app/quote/new/page.tsx)
    // — so checking the whole object, not a specific field, is what covers the
    // serviceType-and-ghlContactId-only shape the row describes.
    expect(builder).toMatch(/if \(prefill\) \{\s*\n\s*if \(loadQuoteDraft\(\)\) queueMicrotask/);
  });
});
