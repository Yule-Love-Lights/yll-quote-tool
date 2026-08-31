// Coverage for the call summariser. The Anthropic client is mocked; no live
// model call runs here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('../claude', () => ({
  getClaudeClient: () => ({ messages: { create: (...args: unknown[]) => createMock(...args) } }),
  isClaudeConfigured: () => true,
}));

import { summarizeCall, SUMMARY_MODEL, TerminalSummaryError } from './summarize';

function textReply(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('summarizeCall', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('returns the model summary text, trimmed', async () => {
    createMock.mockResolvedValue(textReply('  Customer wants a quote for roofline lights.  '));
    const summary = await summarizeCall('Speaker 0: hello\n\nSpeaker 1: hi');
    expect(summary).toBe('Customer wants a quote for roofline lights.');
  });

  it('runs on the cheap tier, once per call', async () => {
    createMock.mockResolvedValue(textReply('A summary.'));
    await summarizeCall('Speaker 0: hello');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toMatchObject({ model: SUMMARY_MODEL });
  });

  it('truncates a very long transcript rather than sending all of it', async () => {
    createMock.mockResolvedValue(textReply('A summary.'));
    const long = 'x'.repeat(40000);
    await summarizeCall(long);
    const sent = JSON.stringify(createMock.mock.calls[0][0]);
    expect(sent.length).toBeLessThan(40000);
    expect(sent).toContain('truncated for length');
  });

  it('treats an empty model reply as a terminal failure, never an empty summary', async () => {
    createMock.mockResolvedValue(textReply('   '));
    await expect(summarizeCall('Speaker 0: hello')).rejects.toBeInstanceOf(TerminalSummaryError);
  });

  it('treats a reply with no text block as a terminal failure', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }] });
    await expect(summarizeCall('Speaker 0: hello')).rejects.toBeInstanceOf(TerminalSummaryError);
  });

  it('lets a transport failure through as a normal error, so it can be retried', async () => {
    createMock.mockRejectedValue(new Error('socket hang up'));
    await expect(summarizeCall('Speaker 0: hello')).rejects.toThrow('socket hang up');
    await expect(summarizeCall('Speaker 0: hello')).rejects.not.toBeInstanceOf(TerminalSummaryError);
  });

  it('refuses an empty transcript instead of asking the model to invent one', async () => {
    await expect(summarizeCall('   ')).rejects.toBeInstanceOf(TerminalSummaryError);
    expect(createMock).not.toHaveBeenCalled();
  });
});
