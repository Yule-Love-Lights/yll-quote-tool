import { describe, it, expect, afterEach } from 'vitest';
import { appBaseUrl } from './telegramNotify';

const savedPortalBaseUrl = process.env.PORTAL_BASE_URL;

describe('appBaseUrl', () => {
  afterEach(() => {
    if (savedPortalBaseUrl === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = savedPortalBaseUrl;
  });

  it('uses PORTAL_BASE_URL when set (trailing slash stripped)', () => {
    process.env.PORTAL_BASE_URL = 'https://example.com/';
    expect(appBaseUrl()).toBe('https://example.com');
  });

  it('falls back to the prod domain when unset', () => {
    delete process.env.PORTAL_BASE_URL;
    expect(appBaseUrl()).toBe('https://quote.yulelovelights.com');
  });
});
