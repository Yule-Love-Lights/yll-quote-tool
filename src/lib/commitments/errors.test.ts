import { describe, it, expect } from 'vitest';
import { commitmentsErrorCode, isCommitmentsSchemaUnavailable } from './errors';

describe('commitmentsErrorCode / isCommitmentsSchemaUnavailable', () => {
  it('reads the code off a Postgres/PostgREST error object', () => {
    expect(commitmentsErrorCode({ code: '23505' })).toBe('23505');
    expect(commitmentsErrorCode({})).toBeNull();
    expect(commitmentsErrorCode(null)).toBeNull();
    expect(commitmentsErrorCode('boom')).toBeNull();
  });

  it('flags missing-table/missing-function codes as schema-unavailable', () => {
    for (const code of ['42P01', 'PGRST205', '42883', 'PGRST202']) {
      expect(isCommitmentsSchemaUnavailable({ code })).toBe(true);
    }
  });

  it('does not flag an unrelated error code', () => {
    expect(isCommitmentsSchemaUnavailable({ code: '23505' })).toBe(false);
    expect(isCommitmentsSchemaUnavailable(null)).toBe(false);
  });
});
