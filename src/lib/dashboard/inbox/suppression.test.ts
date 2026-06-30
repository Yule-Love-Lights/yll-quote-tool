import { describe, it, expect } from 'vitest';
import { normalizeSuppressionValues } from './suppression';

describe('normalizeSuppressionValues', () => {
  it('lowercases emails and E.164-normalizes phones, dropping blanks/dupes', () => {
    const out = normalizeSuppressionValues(['  Sales@Vendor.COM ', '(631) 481-9575', 'sales@vendor.com', '', null]);
    expect(out).toContain('sales@vendor.com');
    expect(out).toContain('+16314819575');
    expect(out.filter((v) => v === 'sales@vendor.com')).toHaveLength(1);
    expect(out).not.toContain('');
  });
});
