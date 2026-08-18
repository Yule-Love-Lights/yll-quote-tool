import { describe, it, expect } from 'vitest';
import { isEnrichableSelfServeDraft } from './quote';

// enrichSelfServeQuote gates the PUBLIC contact-attach write to self-serve DRAFTS
// only (a UUID is the portal capability token, so a staff quote must never be
// mutable this way). Both customer-created sources must pass — the upload path
// (self_serve_upload) shipped refused, leaving every uploaded-photo lead stuck
// 'Anonymous'. These lock the ownership scope.
describe('isEnrichableSelfServeDraft', () => {
  it('accepts both self-serve draft sources', () => {
    expect(isEnrichableSelfServeDraft('draft', 'self_serve_estimate')).toBe(true);
    expect(isEnrichableSelfServeDraft('draft', 'self_serve_upload')).toBe(true);
  });

  it('refuses a non-draft status even for a self-serve source', () => {
    for (const status of ['sent', 'approved', 'booked', 'declined', null]) {
      expect(isEnrichableSelfServeDraft(status, 'self_serve_estimate'), String(status)).toBe(false);
    }
  });

  it('refuses a draft that is not self-serve (a staff-built quote)', () => {
    expect(isEnrichableSelfServeDraft('draft', undefined)).toBe(false);
    expect(isEnrichableSelfServeDraft('draft', null)).toBe(false);
    expect(isEnrichableSelfServeDraft('draft', 'staff')).toBe(false);
    expect(isEnrichableSelfServeDraft('draft', 'self_serve_something_else')).toBe(false);
  });
});
