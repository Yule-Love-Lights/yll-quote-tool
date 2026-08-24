import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { applyOutcomeFromResponse } from './ColorRequestPanel';

describe('ColorRequestPanel applied result', () => {
  it('shows the live label returned by apply instead of the stale request-time label', () => {
    const outcome = applyOutcomeFromResponse(
      { label: 'Ocean Twinkle', smsSent: true, emailSent: true, notifySkipped: false },
      "Staff's pick",
    );

    expect(outcome.label).toBe('Ocean Twinkle');
  });

  it('falls back to the request label for an older response without a label', () => {
    expect(
      applyOutcomeFromResponse(
        { smsSent: false, emailSent: false, notifySkipped: true },
        'Warm White',
      ).label,
    ).toBe('Warm White');
  });
});
