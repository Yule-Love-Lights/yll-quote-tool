import { describe, it, expect } from 'vitest';
import { parseIngestPayload } from './ingest';

const valid = {
  externalId: 'hw-123',
  occurredAt: '2026-06-28T14:00:00Z',
  preview: 'Contract signed',
  contact: { email: 'Jane@Example.com', phone: '(631) 555-1234', name: 'Jane Doe' },
};

describe('parseIngestPayload — generic ingest (Homeworks + future sources)', () => {
  it('parses a valid payload into a homeworks touch by default', () => {
    const r = parseIngestPayload(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.touch.source).toBe('homeworks');
      expect(r.touch.externalId).toBe('hw-123');
      expect(r.touch.lastMessageAt.toISOString()).toBe('2026-06-28T14:00:00.000Z');
      expect(r.touch.preview).toBe('Contract signed');
      expect(r.touch.identity.emails).toEqual(['jane@example.com']); // normalized
      expect(r.touch.identity.phones).toEqual(['+16315551234']);
      expect(r.touch.identity.displayName).toBe('Jane Doe');
    }
  });

  it('accepts epoch-ms occurredAt', () => {
    const r = parseIngestPayload({ ...valid, occurredAt: 1782693272654 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.touch.lastMessageAt.getTime()).toBe(1782693272654);
  });

  it('honors an explicit valid source and passes direction through', () => {
    const r = parseIngestPayload({ ...valid, source: 'homeworks', direction: 'inbound' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.touch.source).toBe('homeworks');
      expect(r.touch.direction).toBe('inbound');
    }
  });

  it('rejects an unknown source', () => {
    const r = parseIngestPayload({ ...valid, source: 'slack' });
    expect(r.ok).toBe(false);
  });

  it('rejects a missing externalId', () => {
    const { externalId, ...rest } = valid;
    void externalId;
    expect(parseIngestPayload(rest).ok).toBe(false);
  });

  it('rejects a missing occurredAt', () => {
    const { occurredAt, ...rest } = valid;
    void occurredAt;
    expect(parseIngestPayload(rest).ok).toBe(false);
  });

  it('rejects an invalid occurredAt (clean 400 rather than a later 500)', () => {
    expect(parseIngestPayload({ ...valid, occurredAt: 'not-a-date' }).ok).toBe(false);
  });

  it('rejects a payload with no usable contact identifier', () => {
    const r = parseIngestPayload({ externalId: 'x', occurredAt: '2026-06-28T14:00:00Z', contact: {} });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(parseIngestPayload(null).ok).toBe(false);
    expect(parseIngestPayload('nope').ok).toBe(false);
  });
});
