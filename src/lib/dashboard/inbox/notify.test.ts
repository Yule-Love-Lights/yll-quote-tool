import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// row 234 / W7-025: a customer's contact name or message preview is
// attacker-controlled and lands in a team-wide staff email — a crafted value
// must render as inert text, never as markup, in both email builders.
describe('escalationEmailHtml — escapes customer-supplied text', () => {
  it('escapes a crafted <img onerror> name so it cannot execute in a mail client', () => {
    const html = escalationEmailHtml({
      level: 2,
      items: [{ name: '<img src=x onerror=alert(1)>', preview: null, waiting: '4h' }],
      baseUrl: 'https://quote.yulelovelights.com',
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a crafted <script> preview and stray quotes', () => {
    const html = escalationEmailHtml({
      level: 2,
      items: [{ name: 'Jane Doe', preview: '<script>alert("hi")</script>', waiting: '4h' }],
      baseUrl: 'https://quote.yulelovelights.com',
    });
    expect(html).not.toContain('<script>alert("hi")</script>');
    expect(html).toContain('&lt;script&gt;alert("hi")&lt;/script&gt;');
  });

  it('escapes a bare ampersand in a name so it is not read as a broken entity', () => {
    const html = escalationEmailHtml({
      level: 1,
      items: [{ name: 'Smith & Sons', preview: null, waiting: '20m' }],
      baseUrl: 'https://quote.yulelovelights.com',
    });
    expect(html).toContain('Smith &amp; Sons');
  });
});

describe('eodDigestHtml — escapes customer-supplied text', () => {
  it('escapes a crafted name + preview in the end-of-day digest', () => {
    const html = eodDigestHtml(
      [{ name: '<b>Evil</b>', preview: '<img src=x onerror=alert(1)>', waiting: '9h' }],
      'https://quote.yulelovelights.com',
    );
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('module hygiene', () => {
  it('has zero imports — notify.ts is env-free and client-safe by design (formatWaiting is imported by client components)', () => {
    const filePath = fileURLToPath(new URL('./notify.ts', import.meta.url));
    const source = readFileSync(filePath, 'utf8');
    const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(importLines).toEqual([]);
  });
});
