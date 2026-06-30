import { describe, it, expect } from 'vitest';
import {
  INBOX_SOURCES,
  INBOX_STATUSES,
  ESCALATION_LEVEL,
  isInboxSource,
  isInboxStatus,
} from './types';

describe('inbox source/status constants', () => {
  it('lists the four ingestion sources', () => {
    expect(INBOX_SOURCES).toEqual(['ghl', 'gmail', 'quotetool', 'homeworks']);
  });
  it('lists the three item statuses', () => {
    expect(INBOX_STATUSES).toEqual(['unresponded', 'handled', 'dismissed']);
  });
  it('names the escalation levels', () => {
    expect(ESCALATION_LEVEL).toEqual({ NONE: 0, AMBER: 1, RED: 2, EOD: 3 });
  });
});

describe('runtime type guards', () => {
  it('isInboxSource accepts known sources, rejects others', () => {
    expect(isInboxSource('ghl')).toBe(true);
    expect(isInboxSource('gmail')).toBe(true);
    expect(isInboxSource('slack')).toBe(false);
    expect(isInboxSource('')).toBe(false);
  });
  it('isInboxStatus accepts known statuses, rejects others', () => {
    expect(isInboxStatus('handled')).toBe(true);
    expect(isInboxStatus('open')).toBe(false);
  });
});
