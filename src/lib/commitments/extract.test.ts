// Coverage for extractRawCommitments -- the happy path, the
// throws-when-unconfigured path, the validate/retry recovery, and
// truncateTranscript. Ported from the yll-call-copilot repo's
// src/lib/commitments/extract.test.ts (master fb1bf326), adapted: no
// verticalName argument (see extract.ts's header for why).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const createMock = vi.fn();
const getClaudeClientMock = vi.fn();

vi.mock('../claude', () => ({
  getClaudeClient: () => getClaudeClientMock(),
}));

import { extractRawCommitments, EXTRACT_MODEL, truncateTranscript } from './extract';

describe('truncateTranscript', () => {
  it('leaves a short transcript untouched', () => {
    expect(truncateTranscript('short call')).toBe('short call');
  });

  it('truncates a long transcript, keeping both the head and the tail', () => {
    const long = 'A'.repeat(8000) + 'MIDDLE' + 'Z'.repeat(8000);
    const result = truncateTranscript(long);
    expect(result.startsWith('A'.repeat(8000))).toBe(true);
    expect(result.endsWith('Z'.repeat(4000))).toBe(true);
    expect(result).toContain('truncated for length');
    expect(result).not.toContain('MIDDLE');
  });
});

describe('extractRawCommitments', () => {
  beforeEach(() => {
    createMock.mockReset();
    getClaudeClientMock.mockReset();
    getClaudeClientMock.mockReturnValue({ messages: { create: createMock } });
  });

  describe('happy path', () => {
    it('parses one send_quote commitment from "I\'ll send your quote today"', async () => {
      createMock.mockResolvedValue({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'emit_commitments',
            input: {
              commitments: [
                { kind: 'send_quote', detail: "send today's quote for the roofline package", promised_time_local: null, promised_day_offset: null },
              ],
            },
          },
        ],
        stop_reason: 'tool_use',
      });

      const result = await extractRawCommitments("Rep: I'll send your quote today. Customer: great, thanks.");

      expect(result).toHaveLength(1);
      expect(result[0]!.kind).toBe('send_quote');
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('forces the emit_commitments tool and uses the configured model + token limit', async () => {
      createMock.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_commitments', input: { commitments: [] } }],
        stop_reason: 'tool_use',
      });

      await extractRawCommitments('a transcript');

      const call = createMock.mock.calls[0]![0];
      expect(call.model).toBe(EXTRACT_MODEL);
      expect(call.model).toBe('claude-haiku-4-5-20251001');
      expect(call.tool_choice).toEqual({ type: 'tool', name: 'emit_commitments' });
      expect(call.max_tokens).toBe(2048);
      expect(call.tools[0].name).toBe('emit_commitments');
    });

    it('instructs the model not to extract customer-made promises as rep commitments', async () => {
      createMock.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_commitments', input: { commitments: [] } }],
        stop_reason: 'tool_use',
      });

      await extractRawCommitments("Rep: sounds good. Customer: I'll think about it and call you back.");

      const call = createMock.mock.calls[0]![0];
      expect(call.system).toMatch(/customer/i);
      expect(call.system).toMatch(/not a rep commitment/i);
    });

    it('instructs the model not to extract something the rep already did as an open commitment', async () => {
      createMock.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_commitments', input: { commitments: [] } }],
        stop_reason: 'tool_use',
      });

      await extractRawCommitments('Rep: I sent you that quote yesterday, did you get it? Customer: let me check.');

      const call = createMock.mock.calls[0]![0];
      expect(call.system).toMatch(/already done/i);
      expect(call.system).toMatch(/completed action/i);
    });

    it('never asks the model for a "Vertical:" line -- no verticals system exists in this repo yet', async () => {
      createMock.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_commitments', input: { commitments: [] } }],
        stop_reason: 'tool_use',
      });

      await extractRawCommitments('a transcript');

      const call = createMock.mock.calls[0]![0];
      const userMessage = call.messages[0].content as string;
      expect(userMessage).not.toMatch(/^Vertical:/m);
    });

    it('returns an empty array for a transcript with no commitments, without error', async () => {
      createMock.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_commitments', input: { commitments: [] } }],
        stop_reason: 'tool_use',
      });

      const result = await extractRawCommitments('Rep: thanks for your time. Customer: no problem, bye.');

      expect(result).toEqual([]);
    });

    it('parses two distinct same-kind commitments as two separate entries', async () => {
      createMock.mockResolvedValue({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'emit_commitments',
            input: {
              commitments: [
                { kind: 'send_photos', detail: 'send photos of the front roofline', promised_time_local: null, promised_day_offset: null },
                { kind: 'send_photos', detail: 'send photos of the shed', promised_time_local: null, promised_day_offset: null },
              ],
            },
          },
        ],
        stop_reason: 'tool_use',
      });

      const result = await extractRawCommitments('a transcript with two photo promises');

      expect(result).toHaveLength(2);
      expect(result.every(c => c.kind === 'send_photos')).toBe(true);
    });
  });

  describe('not configured', () => {
    it('throws when Claude is not configured', async () => {
      getClaudeClientMock.mockReturnValue(null);

      await expect(extractRawCommitments('x')).rejects.toThrow(/not configured/i);
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe('malformed response', () => {
    it.each([-1, 31])('rejects promised_day_offset %s outside the supported 0..30 day window', async promisedDayOffset => {
      createMock.mockResolvedValue({
        content: [{
          type: 'tool_use',
          id: 'toolu_invalid_offset',
          name: 'emit_commitments',
          input: {
            commitments: [{
              kind: 'callback',
              detail: 'call back later',
              promised_time_local: '15:00',
              promised_day_offset: promisedDayOffset,
            }],
          },
        }],
        stop_reason: 'tool_use',
      });

      await expect(extractRawCommitments('x')).rejects.toThrow(/promised_day_offset/i);
      expect(createMock).toHaveBeenCalledTimes(2);
    });

    it('throws when Claude responds without a tool_use block', async () => {
      createMock.mockResolvedValue({ content: [{ type: 'text', text: 'oops' }], stop_reason: 'end_turn' });

      await expect(extractRawCommitments('x')).rejects.toThrow(/did not return commitments/i);
    });

    it('retries once with the validation error, then succeeds', async () => {
      createMock
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_commitments', input: { commitments: [{ kind: 'not_a_real_kind', detail: 'x', promised_time_local: null, promised_day_offset: null }] } }],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'emit_commitments', input: { commitments: [] } }],
          stop_reason: 'tool_use',
        });

      const result = await extractRawCommitments('x');

      expect(result).toEqual([]);
      expect(createMock).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting retries on a persistently invalid kind', async () => {
      createMock.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_commitments', input: { commitments: [{ kind: 'nonsense', detail: 'x', promised_time_local: null, promised_day_offset: null }] } }],
        stop_reason: 'tool_use',
      });

      await expect(extractRawCommitments('x')).rejects.toThrow(/incomplete commitments/i);
      expect(createMock).toHaveBeenCalledTimes(2);
    });

    it('retries once at a higher token ceiling when cut off, then throws if that also gets cut off', async () => {
      createMock.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'emit_commitments', input: { commitments: [] } }],
        stop_reason: 'max_tokens',
      });

      await expect(extractRawCommitments('x')).rejects.toThrow(/token limit/i);

      expect(createMock).toHaveBeenCalledTimes(2);
      expect(createMock.mock.calls[0]![0].max_tokens).toBe(2048);
      expect(createMock.mock.calls[1]![0].max_tokens).toBe(4096);
    });
  });
});
