import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  PortalImageVisibilityControls,
  persistPortalImageVisibility,
  portalVisibilityPatch,
  portalVisibilityConfirmMessage,
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

// Row 429 — the confirm on an APPROVED quote.
//
// Deliberately a confirm and not a freeze: these switches are presentational
// (the design, measurements and price are frozen by rows 367/427), row 370
// already audits them, and gating them would leave a booked customer's portal
// stuck with a bad image whose only remedy is destroying a real approval.
//
// The component itself has no test harness (ledger row 259 — this repo has no
// React DOM testing), so the WORDING is what can be pinned here. It is the
// whole value of the change: a confirm that does not say what is about to
// change is just an extra click.
describe('portalVisibilityConfirmMessage (row 429)', () => {
  it('names the customer approval, the specific image, and the direction', () => {
    const hidingStreet = portalVisibilityConfirmMessage('street', false);
    expect(hidingStreet).toContain('already approved');
    expect(hidingStreet).toContain('house design');
    expect(hidingStreet).toContain('Hiding');

    const showingSatellite = portalVisibilityConfirmMessage('satellite', true);
    expect(showingSatellite).toContain('already approved');
    expect(showingSatellite).toContain('satellite plan');
    expect(showingSatellite).toContain('Showing');
  });

  it('says what the customer sees, not what the database does', () => {
    // Staff read this on a phone. It must not name a column or a table — the
    // S50 lesson about fixing a false claim by replacing it with jargon.
    for (const kind of ['street', 'satellite'] as const) {
      for (const visible of [true, false]) {
        const msg = portalVisibilityConfirmMessage(kind, visible);
        expect(msg).toContain('their portal');
        // "house design" is the staff-facing NAME of the image on this very
        // control, not jargon — an earlier version of this assertion excluded
        // the word "design" outright and failed on correct copy.
        expect(msg).not.toMatch(/portal_show|quotes\.|designs\.|column|jsonb|api\//i);
        expect(msg.endsWith('Continue?')).toBe(true);
      }
    }
  });

  it('distinguishes the two images from each other', () => {
    expect(portalVisibilityConfirmMessage('street', false)).not.toBe(
      portalVisibilityConfirmMessage('satellite', false),
    );
  });
});
