import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  StaffColorRequestForm,
  resolveStaffColorState,
  submitStaffColorRequest,
} from './StaffColorRequestForm';

const schemes = [
  { id: 'as-designed', label: "Staff's pick", colorIds: null },
  { id: 'warm-white', label: 'Warm White', colorIds: ['warm-white'] },
];
const buildableColorIds = ['red', 'green', 'custom-color'];
const colors = [
  { id: 'red', label: 'Red', hex: '#ff0000' },
  { id: 'green', label: 'Green', hex: '#00ff00' },
  { id: 'custom-color', label: 'Settings-only colour', hex: '#123456' },
];

describe('StaffColorRequestForm', () => {
  it('offers the live schemes and the custom-pattern path', () => {
    const html = renderToStaticMarkup(
      <StaffColorRequestForm
        quoteId="quote-1"
        schemes={schemes}
        buildableColorIds={buildableColorIds}
        colors={colors}
        initialColorSchemeId="warm-white"
      />,
    );

    expect(html).toContain('Record customer colour request');
    expect(html).toContain('Warm White');
    expect(html).toContain('Build a custom pattern');
    expect(html).toContain('same pending request as the customer portal');
  });

  it('sanitizes a stored custom pattern before showing it to staff', () => {
    expect(
      resolveStaffColorState('custom', ['red', 'not-buildable', 'green'], schemes, buildableColorIds),
    ).toEqual({ schemeId: 'custom', pattern: ['red', 'green'] });
  });

  it('renders Settings-added colours from the live catalog instead of a built-in fallback', () => {
    const html = renderToStaticMarkup(
      <StaffColorRequestForm
        quoteId="quote-1"
        schemes={schemes}
        buildableColorIds={buildableColorIds}
        colors={colors}
        initialColorSchemeId="custom"
        initialCustomPattern={['custom-color']}
      />,
    );

    expect(html).toContain('Settings-only colour');
    expect(html).toContain('background:#123456');
  });

  it('posts the staff choice through the existing customer-request workflow', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, label: 'Custom pattern (2 colours)' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      submitStaffColorRequest('quote-1', 'custom', ['red', 'green'], request),
    ).resolves.toEqual({ label: 'Custom pattern (2 colours)' });
    expect(request).toHaveBeenCalledWith('/api/quotes/quote-1/color-change-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        colorSchemeId: 'custom',
        customPattern: ['red', 'green'],
        onlyIfNoPending: true,
      }),
    });
  });

  it('surfaces the route error instead of claiming the request was recorded', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'The order was just updated — please try again.' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      submitStaffColorRequest('quote-1', 'warm-white', [], request),
    ).rejects.toThrow('The order was just updated — please try again.');
  });
});
