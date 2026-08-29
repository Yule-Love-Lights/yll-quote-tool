import { describe, it, expect } from 'vitest';
import { isMissingTableError } from './errors';

describe('isMissingTableError', () => {
  it('is true for Postgres error code 42P01 (relation does not exist)', () => {
    expect(isMissingTableError({ code: '42P01', message: 'relation "call_recordings" does not exist' })).toBe(true);
  });

  it('is false for any other error code', () => {
    expect(isMissingTableError({ code: '22P02', message: 'invalid input syntax' })).toBe(false);
  });

  it('is false for a plain Error with no code', () => {
    expect(isMissingTableError(new Error('boom'))).toBe(false);
  });

  it('is false for null/undefined', () => {
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
  });
});
