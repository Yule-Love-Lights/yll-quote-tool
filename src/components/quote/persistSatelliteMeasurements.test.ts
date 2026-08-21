import { describe, expect, it, vi } from 'vitest';
import {
  parkSatelliteContext,
  persistSatelliteMeasurements,
  satelliteContextAfterPhotoChange,
  satelliteLinesHaveContent,
} from './persistSatelliteMeasurements';

const DESIGN_ID = '11111111-1111-4111-8111-111111111111';
const QUOTE_ID = '22222222-2222-4222-8222-222222222222';
const SATELLITE_CONTEXT = {
  satelliteBase64: 'satellite-base64',
  satelliteMediaType: 'image/png',
  satelliteFeetPerPixel: null,
};
const SATELLITE_LINES = {
  front: [{ points: [[0.1, 0.2], [0.8, 0.2]], label: 'Front roofline' }],
  left: [],
  right: [],
  back: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('persistSatelliteMeasurements', () => {
  it('creates a quote-linked design before saving a satellite-only Permanent Lighting upload and trace', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ design: { id: DESIGN_ID } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onDesignCreated = vi.fn();

    const savedDesignId = await persistSatelliteMeasurements({
      designId: null,
      quoteId: QUOTE_ID,
      satelliteContext: SATELLITE_CONTEXT,
      satelliteLines: SATELLITE_LINES,
      inFlightSatelliteSave: null,
      onDesignCreated,
      request,
    });

    expect(savedDesignId).toBe(DESIGN_ID);
    expect(onDesignCreated).toHaveBeenCalledWith(DESIGN_ID);
    expect(request).toHaveBeenNthCalledWith(
      1,
      '/api/designs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ quoteId: QUOTE_ID }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      `/api/designs/${DESIGN_ID}/analysis-context`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(SATELLITE_CONTEXT),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      `/api/designs/${DESIGN_ID}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ quoteId: QUOTE_ID, satelliteLines: SATELLITE_LINES }),
      }),
    );
  });

  it('waits for an existing satellite upload before saving lines so the upload cannot clear them afterward', async () => {
    let finishUpload: (() => void) | undefined;
    const upload = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const save = persistSatelliteMeasurements({
      designId: DESIGN_ID,
      quoteId: QUOTE_ID,
      satelliteContext: SATELLITE_CONTEXT,
      satelliteLines: SATELLITE_LINES,
      inFlightSatelliteSave: {
        designId: DESIGN_ID,
        context: SATELLITE_CONTEXT,
        promise: upload,
      },
      onDesignCreated: vi.fn(),
      request,
    });

    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();

    finishUpload?.();
    await save;

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      `/api/designs/${DESIGN_ID}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ quoteId: QUOTE_ID, satelliteLines: SATELLITE_LINES }),
      }),
    );
  });

  it('retries a failed background satellite upload before saving the trace', async () => {
    const failedUpload = Promise.reject(new Error('network failed'));
    void failedUpload.catch(() => {});
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await persistSatelliteMeasurements({
      designId: DESIGN_ID,
      quoteId: QUOTE_ID,
      satelliteContext: SATELLITE_CONTEXT,
      satelliteLines: SATELLITE_LINES,
      inFlightSatelliteSave: {
        designId: DESIGN_ID,
        context: SATELLITE_CONTEXT,
        promise: failedUpload,
      },
      onDesignCreated: vi.fn(),
      request,
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      `/api/designs/${DESIGN_ID}/analysis-context`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      `/api/designs/${DESIGN_ID}`,
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('surfaces a failed trace save instead of reporting success', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: 'Failed to save satellite lines' }, 500),
    );

    await expect(
      persistSatelliteMeasurements({
        designId: DESIGN_ID,
        quoteId: QUOTE_ID,
        satelliteContext: null,
        satelliteLines: SATELLITE_LINES,
        inFlightSatelliteSave: null,
        onDesignCreated: vi.fn(),
        request,
      }),
    ).rejects.toThrow('Failed to save satellite lines');
  });
});

describe('manual satellite context across a street-photo selection', () => {
  it('keeps the parked satellite when the street photo belongs to the same address', () => {
    const parked = parkSatelliteContext(
      { analysis: { notes: 'belongs to the old street photo' } },
      SATELLITE_CONTEXT,
      ' 123 Main St ',
    );

    const preserved = satelliteContextAfterPhotoChange(
      parked.context,
      parked.address,
      '123 Main St',
    );

    expect(preserved).toEqual({
      context: SATELLITE_CONTEXT,
      address: '123 Main St',
    });
  });

  it('drops the parked satellite when staff changed to a different address', () => {
    const parked = parkSatelliteContext(null, SATELLITE_CONTEXT, '123 Main St');

    expect(
      satelliteContextAfterPhotoChange(parked.context, parked.address, '500 Oak Ave'),
    ).toEqual({ context: null, address: null });
  });
});

describe('satellite replacement guards', () => {
  it('treats a Permanent side trace as content that must be confirmed and reset', () => {
    expect(
      satelliteLinesHaveContent({
        santas: [],
        gingerbread: [],
        c9: [],
        stake: [],
        bistro: [],
        permanent: {
          front: [],
          left: SATELLITE_LINES.front,
          right: [],
          back: [],
        },
      }),
    ).toBe(true);
  });
});
