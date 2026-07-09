// S26 — offered-colors is a DELIBERATE public read. The customer portal's color
// picker (DesignCanvas → buildRenderColorMap) fetches this anonymously; a
// requireOperator() gate here 401'd every anonymous customer once
// AUTH_GATE_ENABLED went live, silently killing the picker. This pins the public
// contract (no auth mock, gate ON, still 200) so a future auth sweep can't
// silently re-add a gate to this route.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { getInventoryBindings } = vi.hoisted(() => ({
  getInventoryBindings: vi.fn(async () => ({ bindings: {}, clipRules: {} })),
}));

vi.mock('@/lib/inventory/bindings', () => ({ getInventoryBindings }));

import { GET } from './route';

const PREV_AUTH_GATE_ENABLED = process.env.AUTH_GATE_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  getInventoryBindings.mockResolvedValue({ bindings: {}, clipRules: {} });
});

afterEach(() => {
  if (PREV_AUTH_GATE_ENABLED === undefined) delete process.env.AUTH_GATE_ENABLED;
  else process.env.AUTH_GATE_ENABLED = PREV_AUTH_GATE_ENABLED;
});

describe('GET /api/inventory/offered-colors — public read (S26)', () => {
  it('returns 200 with the offered-color lists for an unauthenticated request, even with the auth gate ON', async () => {
    process.env.AUTH_GATE_ENABLED = 'true';
    getInventoryBindings.mockResolvedValue({
      bindings: { 'mini:Warm White': 'SKU-1', 'spritzer:cool-white:24': 'SKU-2' },
      clipRules: {},
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mini).toContain('warm-white');
    expect(body.spritzer['24']).toContain('cool-white');
  });

  it('500s when reading bindings throws', async () => {
    getInventoryBindings.mockRejectedValue(new Error('boom'));
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
