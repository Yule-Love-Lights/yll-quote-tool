export type DesignAnalysisContext = {
  analysis?: Record<string, unknown>;
  satelliteBase64?: string;
  satelliteMediaType?: string;
  satelliteFeetPerPixel?: number | null;
};

export type InFlightSatelliteSave = {
  designId: string;
  context: DesignAnalysisContext;
  promise: Promise<void>;
};

export function satelliteLinesHaveContent(lines: {
  santas: readonly unknown[];
  gingerbread: readonly unknown[];
  c9: readonly unknown[];
  stake: readonly unknown[];
  bistro: readonly unknown[];
  permanent: Record<'front' | 'left' | 'right' | 'back', readonly unknown[]>;
}): boolean {
  return (
    lines.santas.length > 0 ||
    lines.gingerbread.length > 0 ||
    lines.c9.length > 0 ||
    lines.stake.length > 0 ||
    lines.bistro.length > 0 ||
    Object.values(lines.permanent).some((side) => side.length > 0)
  );
}

export function parkSatelliteContext(
  pending: DesignAnalysisContext | null,
  satellite: DesignAnalysisContext,
  address: string,
): { context: DesignAnalysisContext; address: string } {
  return {
    context: { ...(pending ?? {}), ...satellite },
    address: address.trim(),
  };
}

export function satelliteContextAfterPhotoChange(
  pending: DesignAnalysisContext | null,
  pendingAddress: string | null,
  currentAddress: string,
): { context: DesignAnalysisContext | null; address: string | null } {
  if (pending?.satelliteBase64 != null && pendingAddress === currentAddress.trim()) {
    return {
      context: {
        satelliteBase64: pending.satelliteBase64,
        satelliteMediaType: pending.satelliteMediaType,
        satelliteFeetPerPixel: pending.satelliteFeetPerPixel,
      },
      address: pendingAddress,
    };
  }
  return { context: null, address: null };
}

type PersistSatelliteMeasurementsArgs = {
  designId: string | null;
  quoteId: string;
  satelliteContext: DesignAnalysisContext | null;
  satelliteLines: Record<string, unknown>;
  inFlightSatelliteSave: InFlightSatelliteSave | null;
  onDesignCreated: (designId: string) => void;
  request?: typeof fetch;
};

async function responseError(res: Response, fallback: string): Promise<Error> {
  const data = await res.json().catch(() => ({})) as { error?: unknown };
  return new Error(typeof data.error === 'string' ? data.error : `${fallback} (${res.status})`);
}

export async function saveAnalysisContext(
  designId: string,
  context: DesignAnalysisContext,
  request: typeof fetch = fetch,
): Promise<void> {
  const res = await request(`/api/designs/${designId}/analysis-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(context),
  });
  if (!res.ok) throw await responseError(res, 'Failed to save the satellite image');
}

export async function persistSatelliteMeasurements({
  designId,
  quoteId,
  satelliteContext,
  satelliteLines,
  inFlightSatelliteSave,
  onDesignCreated,
  request = fetch,
}: PersistSatelliteMeasurementsArgs): Promise<string> {
  let targetDesignId = designId;
  let contextSaved = false;

  if (
    targetDesignId &&
    inFlightSatelliteSave?.designId === targetDesignId
  ) {
    try {
      await inFlightSatelliteSave.promise;
      contextSaved = inFlightSatelliteSave.context === satelliteContext;
    } catch {
      // Retry the same upload below. Calculate is the final persistence gate.
    }
  }

  if (!targetDesignId) {
    if (!satelliteContext?.satelliteBase64) {
      throw new Error('Satellite image is not ready to save. Re-upload it and calculate again.');
    }
    const createRes = await request('/api/designs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId }),
    });
    if (!createRes.ok) throw await responseError(createRes, 'Failed to create the satellite design');
    const data = await createRes.json().catch(() => ({})) as { design?: { id?: unknown } };
    if (typeof data.design?.id !== 'string') {
      throw new Error('The satellite design was created without an id. Calculate again.');
    }
    targetDesignId = data.design.id;
    onDesignCreated(targetDesignId);
  }

  if (!contextSaved && satelliteContext?.satelliteBase64) {
    await saveAnalysisContext(targetDesignId, satelliteContext, request);
  }

  const linesRes = await request(`/api/designs/${targetDesignId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteId, satelliteLines }),
  });
  if (!linesRes.ok) throw await responseError(linesRes, 'Failed to save the satellite trace');

  return targetDesignId;
}
