import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the Claude client seam is mocked — the validation logic (enum guard,
// confidence bar, malformed-response handling) runs for real.
const seam = vi.hoisted(() => {
  const create = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  return {
    create,
    client: null as null | { messages: { create: typeof create } },
  };
});
vi.mock('@/lib/claude', () => ({
  getClaudeClient: () => seam.client,
  isClaudeConfigured: () => seam.client !== null,
}));

import { interpretBotText } from './botInterpreter';

const toolUse = (input: Record<string, unknown>) => ({
  content: [{ type: 'tool_use', id: 't1', name: 'route', input }],
});

beforeEach(() => {
  vi.clearAllMocks();
  seam.client = { messages: { create: seam.create } };
});

describe('interpretBotText (Phase 1 read-only interpreter)', () => {
  it('returns null when no API key is configured (bot degrades to keyword-only)', async () => {
    seam.client = null;
    expect(await interpretBotText('status on alvarez')).toBeNull();
    expect(seam.create).not.toHaveBeenCalled();
  });

  it('parses a well-formed routing into {tool, args, confidence}', async () => {
    seam.create.mockResolvedValue(toolUse({ tool: 'status', query: ' Alvarez ', confidence: 0.92 }));
    expect(await interpretBotText('status on the Alvarez quote')).toEqual({
      tool: 'status',
      args: { query: 'Alvarez' },
      confidence: 0.92,
    });
  });

  it('passes schedule.when and stock.sku through', async () => {
    seam.create.mockResolvedValue(toolUse({ tool: 'schedule', when: 'week', confidence: 0.8 }));
    expect(await interpretBotText('installs this week?')).toEqual({
      tool: 'schedule',
      args: { when: 'week' },
      confidence: 0.8,
    });
    seam.create.mockResolvedValue(toolUse({ tool: 'stock', sku: '1042', confidence: 0.9 }));
    expect(await interpretBotText('how many 1042 do we have')).toEqual({
      tool: 'stock',
      args: { sku: '1042' },
      confidence: 0.9,
    });
  });

  it('discards a low-confidence interpretation', async () => {
    seam.create.mockResolvedValue(toolUse({ tool: 'status', query: 'x', confidence: 0.4 }));
    expect(await interpretBotText('hmm?')).toBeNull();
  });

  it('rejects an out-of-enum tool name — a write can never escape the interpreter', async () => {
    seam.create.mockResolvedValue(toolUse({ tool: 'set', sku: '1042', confidence: 0.99 }));
    expect(await interpretBotText('set 1042 to 900')).toBeNull();
  });

  it('rejects a malformed response (missing confidence / no tool_use block)', async () => {
    seam.create.mockResolvedValue(toolUse({ tool: 'status', query: 'x' }));
    expect(await interpretBotText('status x')).toBeNull();
    seam.create.mockResolvedValue({ content: [{ type: 'text', text: 'nope' }] });
    expect(await interpretBotText('status x')).toBeNull();
  });

  it('returns null on an API failure without throwing into the webhook', async () => {
    seam.create.mockRejectedValue(new Error('api down'));
    await expect(interpretBotText('status on alvarez')).resolves.toBeNull();
  });

  it('drops an invalid when value instead of passing it through', async () => {
    seam.create.mockResolvedValue(toolUse({ tool: 'schedule', when: 'next month', confidence: 0.9 }));
    expect(await interpretBotText('installs next month')).toEqual({
      tool: 'schedule',
      args: {},
      confidence: 0.9,
    });
  });
});

describe('interpretBotText (captureLead, Phase 3 write)', () => {
  it('rejects captureLead when allowWrites is not set — a write can never escape read-only mode', async () => {
    seam.create.mockResolvedValue(
      toolUse({ tool: 'captureLead', name: 'John Smith', phone: '6315550100', confidence: 0.95 }),
    );
    // No { allowWrites: true } — defaults to read-only.
    expect(await interpretBotText('new lead John Smith 631-555-0100')).toBeNull();
  });

  it('parses name/phone/address/service through when allowWrites is set', async () => {
    seam.create.mockResolvedValue(
      toolUse({
        tool: 'captureLead',
        name: ' John Smith ',
        phone: ' 631-555-0100 ',
        address: ' 12 Oak St ',
        service: 'permanent',
        confidence: 0.95,
      }),
    );
    expect(
      await interpretBotText('new lead John Smith 631-555-0100 12 Oak St wants permanent', {
        allowWrites: true,
      }),
    ).toEqual({
      tool: 'captureLead',
      args: {
        name: 'John Smith',
        phone: '631-555-0100',
        address: '12 Oak St',
        service: 'permanent',
      },
      confidence: 0.95,
    });
  });

  it('omits service when the sender never said it (bot must ask, not guess)', async () => {
    seam.create.mockResolvedValue(
      toolUse({ tool: 'captureLead', name: 'John Smith', phone: '6315550100', confidence: 0.9 }),
    );
    const res = await interpretBotText('new lead John Smith 631-555-0100', { allowWrites: true });
    expect(res?.args.service).toBeUndefined();
  });

  it('drops an invalid/hallucinated service value instead of passing it through', async () => {
    seam.create.mockResolvedValue(
      toolUse({
        tool: 'captureLead',
        name: 'John Smith',
        phone: '6315550100',
        service: 'residential-holiday', // not a real LeadService
        confidence: 0.9,
      }),
    );
    const res = await interpretBotText('new lead John Smith 631-555-0100', { allowWrites: true });
    expect(res?.args.service).toBeUndefined();
  });

  it('carries note through alongside captureLead fields', async () => {
    seam.create.mockResolvedValue(
      toolUse({
        tool: 'captureLead',
        name: 'John Smith',
        phone: '6315550100',
        note: 'met at the fence',
        confidence: 0.9,
      }),
    );
    const res = await interpretBotText('new lead John Smith 631-555-0100, met at the fence', {
      allowWrites: true,
    });
    expect(res?.args.note).toBe('met at the fence');
  });
});
