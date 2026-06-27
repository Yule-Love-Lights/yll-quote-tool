// Unit test for the /api/health probe (audit fix #41/#78/#100). Confirms it
// returns the per-service config booleans and — critically — never leaks the
// secret values themselves.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  isSupabaseServiceConfigured: () => false,
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => false,
}));
vi.mock('@/lib/claude', () => ({
  isClaudeConfigured: () => true,
}));
vi.mock('@/lib/googleMaps', () => ({
  isGoogleMapsConfigured: () => true,
}));

import { GET } from './route';

describe('GET /api/health', () => {
  it('returns the per-service config booleans', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.services).toEqual({
      supabase: true,
      supabaseService: false,
      highLevel: false,
      claude: true,
      googleMaps: true,
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('exposes no secret values, only booleans', async () => {
    const res = await GET();
    const body = await res.json();
    // Every service flag must be a boolean — no URLs, keys, or tokens.
    for (const v of Object.values(body.services as Record<string, unknown>)) {
      expect(typeof v).toBe('boolean');
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/key|token|secret|http/i);
  });
});
