import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// posthog-js is mocked wholesale — these tests only cover OUR fail-open
// wrapper (init gating, safe no-ops), never real network/SDK behavior.
const init = vi.fn();
const capture = vi.fn();
const isFeatureEnabled = vi.fn();
const register = vi.fn();

vi.mock('posthog-js', () => ({
  default: { init, capture, isFeatureEnabled, register },
}));

const ORIGINAL_ENV = process.env;

// The wrapper's `initialized` flag is module-level state, so each test needs
// a fresh module instance (vi.resetModules + a dynamic re-import) to test
// the pre-init and post-init paths in isolation.
beforeEach(() => {
  vi.resetModules();
  init.mockReset();
  capture.mockReset();
  isFeatureEnabled.mockReset();
  register.mockReset();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.unstubAllGlobals();
});

describe('initPostHog — fails open when unconfigured', () => {
  it('no-ops (returns false) when NEXT_PUBLIC_POSTHOG_KEY is unset', async () => {
    const { initPostHog } = await import('./posthog');
    expect(initPostHog()).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('no-ops when called outside the browser (no window)', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    // vitest's default (node) environment already has no `window`, but assert
    // the guard explicitly in case the test environment ever changes.
    expect(typeof window).toBe('undefined');
    const { initPostHog } = await import('./posthog');
    expect(initPostHog()).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('initializes once a key is present + window exists, defaulting the host', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    const { initPostHog } = await import('./posthog');
    expect(initPostHog()).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    const [token, config] = init.mock.calls[0];
    expect(token).toBe('phc_test_key');
    expect(config).toMatchObject({
      api_host: 'https://us.i.posthog.com',
      capture_exceptions: true,
      session_recording: { maskAllInputs: true, maskTextSelector: '*' },
    });
  });

  it('uses NEXT_PUBLIC_POSTHOG_HOST when set instead of the default', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
    vi.stubGlobal('window', {});
    const { initPostHog } = await import('./posthog');
    initPostHog();
    expect(init.mock.calls[0][1]).toMatchObject({ api_host: 'https://eu.i.posthog.com' });
  });

  it('is idempotent — a second call does not re-init', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    const { initPostHog } = await import('./posthog');
    initPostHog();
    initPostHog();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('fails open when posthog.init itself throws', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    init.mockImplementation(() => {
      throw new Error('blocked by ad-blocker');
    });
    const { initPostHog } = await import('./posthog');
    expect(initPostHog()).toBe(false);
  });
});

describe('track — safe no-op wrapper', () => {
  it('no-ops (no network) when PostHog was never initialized', async () => {
    const { track } = await import('./posthog');
    expect(() => track('quote_approved', { quote_id: 'q1' })).not.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });

  it('lazily initializes when called before initPostHog (child effects run before the root Providers effect)', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    const { track } = await import('./posthog');
    // No explicit initPostHog() — this is the portal_opened-on-mount path.
    track('portal_opened', { quote_id: 'q1' });
    expect(init).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('portal_opened', { quote_id: 'q1' });
  });

  it('forwards to posthog.capture once initialized', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    const { initPostHog, track } = await import('./posthog');
    initPostHog();
    track('package_selected', { quote_id: 'q1', package: 'B' });
    expect(capture).toHaveBeenCalledWith('package_selected', { quote_id: 'q1', package: 'B' });
  });

  it('never throws even if posthog.capture throws', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    capture.mockImplementation(() => {
      throw new Error('network down');
    });
    const { initPostHog, track } = await import('./posthog');
    initPostHog();
    expect(() => track('quote_sent')).not.toThrow();
  });
});

describe('registerStaffDevice — staff-device super property', () => {
  it('registers staff_device once PostHog can initialize', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    const { registerStaffDevice } = await import('./posthog');
    registerStaffDevice();
    expect(register).toHaveBeenCalledWith({ staff_device: true });
  });

  it('no-ops (no register call) when PostHog cannot initialize', async () => {
    // No NEXT_PUBLIC_POSTHOG_KEY set.
    const { registerStaffDevice } = await import('./posthog');
    registerStaffDevice();
    expect(register).not.toHaveBeenCalled();
  });

  it('never throws even if posthog.register throws', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    register.mockImplementation(() => {
      throw new Error('boom');
    });
    const { registerStaffDevice } = await import('./posthog');
    expect(() => registerStaffDevice()).not.toThrow();
  });
});

describe('isFlagEnabled — safe no-op wrapper', () => {
  it('returns false when PostHog was never initialized', async () => {
    const { isFlagEnabled } = await import('./posthog');
    expect(isFlagEnabled('some-flag')).toBe(false);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('returns the SDK result once initialized', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    isFeatureEnabled.mockReturnValue(true);
    const { initPostHog, isFlagEnabled } = await import('./posthog');
    initPostHog();
    expect(isFlagEnabled('some-flag')).toBe(true);
  });

  it('treats an `undefined` SDK result (flags not loaded yet) as false', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    isFeatureEnabled.mockReturnValue(undefined);
    const { initPostHog, isFlagEnabled } = await import('./posthog');
    initPostHog();
    expect(isFlagEnabled('some-flag')).toBe(false);
  });

  it('never throws even if posthog.isFeatureEnabled throws', async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
    vi.stubGlobal('window', {});
    isFeatureEnabled.mockImplementation(() => {
      throw new Error('boom');
    });
    const { initPostHog, isFlagEnabled } = await import('./posthog');
    initPostHog();
    expect(() => isFlagEnabled('some-flag')).not.toThrow();
    expect(isFlagEnabled('some-flag')).toBe(false);
  });
});
