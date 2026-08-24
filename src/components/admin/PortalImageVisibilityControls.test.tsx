import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  PortalImageVisibilityControls,
  persistPortalImageVisibility,
  portalVisibilityPatch,
} from './PortalImageVisibilityControls';

const DESIGN_ID = '11111111-1111-1111-1111-111111111111';

describe('PortalImageVisibilityControls', () => {
  it('renders two accessible, independently initialized checkboxes', () => {
    const html = renderToStaticMarkup(
      <PortalImageVisibilityControls
        designId={DESIGN_ID}
        portalShowStreetView={false}
        portalShowSatelliteView
        hasStreetImage
        hasSatelliteImage
      />,
    );

    expect(html).toContain('Customer portal images');
    expect(html).toContain('Show house design on customer portal');
    expect(html).toContain('Show satellite plan on customer portal');
    expect((html.match(/type="checkbox"/g) ?? [])).toHaveLength(2);
    expect((html.match(/checked=""/g) ?? [])).toHaveLength(1);
  });

  it('keeps the controls reachable on a satellite-only design', () => {
    const html = renderToStaticMarkup(
      <PortalImageVisibilityControls
        designId={DESIGN_ID}
        portalShowStreetView
        portalShowSatelliteView
        hasStreetImage={false}
        hasSatelliteImage
      />,
    );

    expect(html).toContain('No house design image is stored.');
    expect(html).toContain('Show satellite plan on customer portal');
    expect((html.match(/disabled=""/g) ?? [])).toHaveLength(1);
  });
});

describe('portal image visibility transport', () => {
  it('builds a one-field patch so the sibling setting is never stale-overwritten', () => {
    expect(portalVisibilityPatch('street', false)).toEqual({ portalShowStreetView: false });
    expect(portalVisibilityPatch('satellite', true)).toEqual({ portalShowSatelliteView: true });
  });

  it('sends the exact partial PUT and returns the canonical pair', async () => {
    const request = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          portalShowStreetView: false,
          portalShowSatelliteView: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      persistPortalImageVisibility(
        DESIGN_ID,
        { portalShowStreetView: false },
        request,
      ),
    ).resolves.toEqual({
      portalShowStreetView: false,
      portalShowSatelliteView: true,
    });
    expect(request).toHaveBeenCalledWith(`/api/designs/${DESIGN_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ portalShowStreetView: false }),
    });
  });

  it('rejects server errors, network errors, and malformed success bodies', async () => {
    const serverError = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Write failed' }), { status: 500 }),
    );
    await expect(
      persistPortalImageVisibility(DESIGN_ID, { portalShowStreetView: false }, serverError),
    ).rejects.toThrow('Write failed');

    const networkError = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      persistPortalImageVisibility(DESIGN_ID, { portalShowStreetView: false }, networkError),
    ).rejects.toThrow('offline');

    const malformed = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(
      persistPortalImageVisibility(DESIGN_ID, { portalShowStreetView: false }, malformed),
    ).rejects.toThrow(/could not confirm/i);
  });
});
