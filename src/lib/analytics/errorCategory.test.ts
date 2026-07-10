import { describe, it, expect } from 'vitest';
import { categorizeApproveError } from './errorCategory';

describe('categorizeApproveError (PostHog Wave 1)', () => {
  it('buckets a 5xx status as http_5xx', () => {
    expect(categorizeApproveError(500, new Error('server exploded'))).toBe('http_5xx');
    expect(categorizeApproveError(503, new Error('valor unavailable'))).toBe('http_5xx');
  });

  it('buckets a 4xx status as http_4xx', () => {
    expect(categorizeApproveError(400, new Error('bad request'))).toBe('http_4xx');
    expect(categorizeApproveError(409, new Error('conflict'))).toBe('http_4xx');
  });

  it('buckets a fetch-level TypeError with no status as network', () => {
    expect(categorizeApproveError(undefined, new TypeError('Failed to fetch'))).toBe('network');
  });

  it('falls back to unknown for a non-HTTP, non-TypeError failure with no status', () => {
    expect(categorizeApproveError(undefined, new Error('something odd'))).toBe('unknown');
    expect(categorizeApproveError(undefined, 'a thrown string')).toBe('unknown');
  });

  it('prefers the status bucket over the error type when both are present', () => {
    // A JSON-parsing TypeError after a real 500 response should still read as
    // the HTTP bucket, not 'network' — the failure did reach the server.
    expect(categorizeApproveError(500, new TypeError('Unexpected token in JSON'))).toBe('http_5xx');
  });

  it('never needs the raw error message — only status + err type feed the bucket', () => {
    const category = categorizeApproveError(404, new Error('Supabase service role not configured'));
    expect(category).toBe('http_4xx');
    expect(category).not.toMatch(/Supabase|service role/);
  });
});
