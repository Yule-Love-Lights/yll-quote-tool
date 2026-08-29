// Summarises one call transcript into the paragraph that goes at the top of
// the HighLevel note (Naldo's ask, 2026-08-29).
//
// Haiku, for the same reason src/lib/commitments/extract.ts uses it: this
// runs once per call across every call the company takes, so cost per call
// matters far more than it would for a one-off generation. The result is
// stored on the transcript row, so a note retry never pays for a second
// summary.
//
// truncateTranscript is imported from the commitment extractor rather than
// duplicated: both callers want the same head-and-tail window of the same
// transcripts, and one copy means one place to change it.

import { getClaudeClient } from '../claude';
import { truncateTranscript } from '../commitments/extract';

// Same tier as the commitment extractor.
export const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

const MAX_SUMMARY_TOKENS = 400;

/**
 * A failure that will happen again on a retry: an empty transcript, or a
 * model reply with nothing usable in it. The worker records these without
 * burning further attempts on the same broken input, the same way
 * TerminalCommitmentExtractionError is treated in the extractor.
 */
export class TerminalSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalSummaryError';
  }
}

const SYSTEM_PROMPT = `You are summarising one real phone call for Yule Love Lights, a residential and commercial lighting company on Long Island. The summary is pasted into the customer's CRM record and read by office staff who were not on the call.

Write one short paragraph, three or four sentences at most. Say what the customer wanted, what was discussed, and where the call landed. Name concrete details a staff member would need: the property, the service they asked about, a price or a date if one was said, and any problem the customer raised.

HighLevel's transcription regularly garbles proper nouns: the company comes through as "Yellow Lights" or similar, and rep names are often wrong. The company is Yule Love Lights. Use that name, and when a person's name is clearly garbled call them the rep or the customer rather than repeating a name that may be wrong.

Write plainly, as a colleague would. Do not open with "In this call" or "The customer called to". Do not add advice, next steps, or a task list; something else handles those. Do not invent anything that is not in the transcript. If the call is too garbled or too short to summarise honestly, say that in one sentence rather than guessing.

Never use an em dash. Never use the words "unlock", "leverage", or "delve".`;

export async function summarizeCall(transcript: string): Promise<string> {
  if (!transcript || !transcript.trim()) {
    throw new TerminalSummaryError('Cannot summarise an empty transcript.');
  }

  const client = getClaudeClient();
  if (!client) throw new Error('Claude not configured. Set ANTHROPIC_API_KEY.');

  // Any transport or rate-limit failure propagates as an ordinary error, so
  // the worker treats it as retryable rather than terminal.
  const response = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: MAX_SUMMARY_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: truncateTranscript(transcript) }],
  });

  const textBlock = response.content.find(block => block.type === 'text');
  const summary = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
  if (!summary) {
    throw new TerminalSummaryError('The model returned no summary text for this call.');
  }
  return summary;
}
