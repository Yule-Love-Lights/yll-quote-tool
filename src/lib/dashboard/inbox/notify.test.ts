import { describe, it, expect } from 'vitest';
import {
  formatWaiting,
  escalationEmailSubject,
  escalationEmailHtml,
  eodDigestSubject,
  eodDigestHtml,
} from './notify';

describe('formatWaiting', () => {
  it('shows minutes under an hour', () => {
    expect(formatWaiting(45 * 60_000)).toBe('45m');
  });
  it('shows hours + minutes under a day', () => {
    expect(formatWaiting((2 * 60 + 5) * 60_000)).toBe('2h 5m');
  });
  it('shows days + hours past a day', () => {
    expect(formatWaiting(26 * 60 * 60_000)).toBe('1d 2h');
  });
});

describe('escalationEmailSubject', () => {
  it('is urgent + counts at red (level 2)', () => {
    const s = escalationEmailSubject({ level: 2, count: 3 });
    expect(s).toContain('3');
    expect(s.toLowerCase()).toContain('urgent');
  });
  it('is a heads-up at amber (level 1)', () => {
    const s = escalationEmailSubject({ level: 1, count: 1 });
    expect(s).toContain('1');
    expect(s.toLowerCase()).not.toContain('urgent');
  });
});

describe('eodDigestSubject', () => {
  it('counts the still-open items', () => {
    expect(eodDigestSubject(4)).toContain('4');
  });
});

describe('escalationEmailHtml', () => {
  it('lists each item with its name + preview + wait time', () => {
    const html = escalationEmailHtml({
      level: 2,
      items: [{ name: 'Jane Doe', preview: 'Can I get a quote?', waiting: '4h 10m' }],
      baseUrl: 'https://quote.yulelovelights.com',
    });
    expect(html).toContain('Jane Doe');
    expect(html).toContain('Can I get a quote?');
    expect(html).toContain('4h 10m');
  });

  // Email clients have no page origin: a bare href="/inbox" resolves as the
  // HOSTNAME "inbox" (DNS_PROBE_FINISHED_NXDOMAIN), so the link must be absolute.
  it('links to the inbox with an absolute URL', () => {
    const html = escalationEmailHtml({
      level: 2,
      items: [{ name: 'Jane Doe', preview: null, waiting: '4h 10m' }],
      baseUrl: 'https://quote.yulelovelights.com',
    });
    expect(html).toContain('href="https://quote.yulelovelights.com/inbox"');
    expect(html).not.toContain('href="/inbox"');
  });
});

describe('eodDigestHtml', () => {
  it('links to the inbox with an absolute URL', () => {
    const html = eodDigestHtml(
      [{ name: 'Jane Doe', preview: null, waiting: '9h' }],
      'https://quote.yulelovelights.com/',
    );
    expect(html).toContain('href="https://quote.yulelovelights.com/inbox"');
    expect(html).not.toContain('href="/inbox"');
  });
});
