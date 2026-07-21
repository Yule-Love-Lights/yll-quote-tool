import { describe, it, expect, vi, beforeEach } from 'vitest';

// The dispatcher contract (Phase 1): keyword commands NEVER touch the LLM;
// only parser-unknown text reaches the interpreter, and every interpreter
// failure lands on the same "didn't understand" reply the bot always had.
const { interpretBotText, runStatusTool, runScheduleTool, listFulfillmentCards } = vi.hoisted(() => ({
  interpretBotText: vi.fn(async (): Promise<unknown> => null),
  runStatusTool: vi.fn(async () => 'STATUS-REPLY'),
  runScheduleTool: vi.fn(async () => 'SCHEDULE-REPLY'),
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('./botInterpreter', () => ({ interpretBotText }));
vi.mock('./botTools', () => ({ runStatusTool, runScheduleTool }));
vi.mock('@/lib/inventory/jobs', () => ({
  listFulfillmentCards,
  setJobFulfillmentStage: vi.fn(),
  prepareJobMaterials: vi.fn(),
}));
vi.mock('@/lib/inventory/onHand', () => ({
  listOnHand: vi.fn(async () => []),
  upsertOnHand: vi.fn(),
  toQty: (n: number) => n,
}));

import { handleWhatsAppText } from './whatsapp';

const NOT_UNDERSTOOD = 'Didn\'t understand that. Text "help" for commands.';

beforeEach(() => {
  vi.clearAllMocks();
  interpretBotText.mockResolvedValue(null);
});

describe('handleWhatsAppText dispatcher (keyword first, interpreter fallback)', () => {
  it('runs keyword commands without ever calling the interpreter', async () => {
    listFulfillmentCards.mockResolvedValue([]);
    expect(await handleWhatsAppText('jobs')).toBe('No active jobs.');
    expect(interpretBotText).not.toHaveBeenCalled();
  });

  it('falls back to the interpreter on parser-unknown text', async () => {
    interpretBotText.mockResolvedValue({ tool: 'status', args: { query: 'alvarez' }, confidence: 0.9 });
    expect(await handleWhatsAppText('how is the alvarez quote doing?')).toBe('STATUS-REPLY');
    expect(runStatusTool).toHaveBeenCalledWith('alvarez');
  });

  it('uses the raw text as the status query when the model omitted one', async () => {
    interpretBotText.mockResolvedValue({ tool: 'status', args: {}, confidence: 0.9 });
    await handleWhatsAppText('whats up with smith');
    expect(runStatusTool).toHaveBeenCalledWith('whats up with smith');
  });

  it('defaults schedule to today', async () => {
    interpretBotText.mockResolvedValue({ tool: 'schedule', args: {}, confidence: 0.9 });
    expect(await handleWhatsAppText('any installs?')).toBe('SCHEDULE-REPLY');
    expect(runScheduleTool).toHaveBeenCalledWith('today');
  });

  it('keeps the old reply when the interpreter returns null', async () => {
    expect(await handleWhatsAppText('gibberish zzz')).toBe(NOT_UNDERSTOOD);
    expect(interpretBotText).toHaveBeenCalledOnce();
  });

  it('routes interpreted stock without a sku to the not-understood reply', async () => {
    interpretBotText.mockResolvedValue({ tool: 'stock', args: {}, confidence: 0.9 });
    expect(await handleWhatsAppText('got any of those left')).toBe(NOT_UNDERSTOOD);
  });
});
