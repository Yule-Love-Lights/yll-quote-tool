// Extracts rep commitments from one transcript using Claude's tool-use
// pattern to force structured output (calls_merge_plan_2026-08.md slice
// S6). Ported from the yll-call-copilot repo's src/lib/commitments/
// extract.ts (master fb1bf326), adapted:
//   - getClaudeClient comes from this repo's src/lib/claude.ts (same
//     module name and shape the copilot uses, so the import only changes
//     path, not usage).
//   - truncateTranscript is inlined here rather than imported from
//     ../transcripts/extract: that module is S4 scope (the grading
//     pipeline) and does not exist in this repo yet. Same constants/
//     algorithm as the copilot's version (MAX_TRANSCRIPT_CHARS/HEAD_CHARS/
//     TAIL_CHARS), so a later S4 build can delete this copy and import a
//     shared one without changing behavior.
//   - The "Vertical: X" line is dropped from the extraction prompt: no
//     verticals system exists in this repo yet (S3 is unbuilt per the
//     merge plan). extractRawCommitments therefore takes only the
//     transcript text, not a verticalName -- when S3 lands, a caller can
//     add the line back without touching this file's core logic.

import Anthropic from '@anthropic-ai/sdk';
import { getClaudeClient } from '../claude';
import { COMMITMENT_KINDS, MAX_PROMISED_DAY_OFFSET } from './types';
import type { RawCommitment } from './types';

// Same truncation shape as the copilot's src/lib/transcripts/extract.ts
// (not ported wholesale -- see this file's header). Keeps a long call
// transcript within a sane prompt size while preserving both ends, where a
// commitment is most likely to be made (the sign-off) or referenced (the
// opener).
const MAX_TRANSCRIPT_CHARS = 12000;
const HEAD_CHARS = 8000;
const TAIL_CHARS = 4000;
const TRUNCATION_MARKER = '\n\n[... transcript truncated for length ...]\n\n';

export function truncateTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  return text.slice(0, HEAD_CHARS) + TRUNCATION_MARKER + text.slice(text.length - TAIL_CHARS);
}

// Haiku, not Sonnet -- this runs once per transcript across a backfill of
// every synced call, so cost per call matters far more than it would for a
// one-off generation call.
export const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';

export class TerminalCommitmentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalCommitmentExtractionError';
  }
}

export function isTerminalCommitmentExtractionError(
  error: unknown,
): error is TerminalCommitmentExtractionError {
  return error instanceof TerminalCommitmentExtractionError;
}

const SYSTEM_PROMPT = `You are reviewing one real sales-call transcript for Yule Love Lights, a residential and commercial lighting company. Extract only PROMISES THE REP MADE to the customer during this call -- something the rep committed to doing after the call (sending a quote, sending photos, calling back, scheduling an estimate, sending information, or another concrete promise).

Never extract something the CUSTOMER said they would do ("I'll think about it and call you back", "let me talk to my spouse") -- that is not a rep commitment. Never extract a hypothetical or something the rep only floated as an option ("I could send you photos if you want") unless the rep actually committed to doing it. Never extract something the rep says they have ALREADY DONE ("I sent you that quote yesterday", "I already texted you the photos, did you get them?") -- that is a completed action, not an open commitment, even though the rep is talking about the same kind of thing (a quote, photos, a callback). When in doubt, leave it out.

If the rep mentioned a specific time they promised to do something (e.g. "I'll call you back around 3", "I'll send that over tonight"), extract promised_time_local as a 24-hour HH:MM local time in America/New_York (the call's own time zone), and promised_day_offset as how many days after the call date it falls (0 for later today, 1 for tomorrow). If no specific time was mentioned, leave both null.

If a call has no rep commitments, return an empty commitments array. Never invent a commitment that is not actually in the transcript.

Never use an em dash. Never use the words "unlock", "leverage", or "delve".`;

const EMIT_COMMITMENTS_TOOL: Anthropic.Tool = {
  name: 'emit_commitments',
  description: 'Return the rep commitments extracted from this call transcript.',
  input_schema: {
    type: 'object',
    properties: {
      commitments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: COMMITMENT_KINDS,
              description: 'The type of thing the rep promised.',
            },
            detail: {
              type: 'string',
              description: 'A short plain-English description of exactly what the rep promised, e.g. "send the quote for the roofline package".',
            },
            promised_time_local: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
              description: '24-hour HH:MM local time in America/New_York the rep promised, only if a specific time was mentioned. Null otherwise.',
            },
            promised_day_offset: {
              anyOf: [{ type: 'integer' }, { type: 'null' }],
              minimum: 0,
              maximum: MAX_PROMISED_DAY_OFFSET,
              description: 'Days after the call date this falls on: 0 for later today, 1 for tomorrow. Null if no specific time was mentioned.',
            },
          },
          required: ['kind', 'detail', 'promised_time_local', 'promised_day_offset'],
        },
        description: 'Rep commitments made on this call. Empty array if none.',
      },
    },
    required: ['commitments'],
  },
};

function isCommitmentKind(v: unknown): v is RawCommitment['kind'] {
  return typeof v === 'string' && (COMMITMENT_KINDS as string[]).includes(v);
}
function isNullableString(v: unknown): v is string | null {
  return typeof v === 'string' || v === null;
}
function isNullableInt(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isInteger(v));
}

type ValidationResult = { valid: true; commitments: RawCommitment[] } | { valid: false; error: string };

function validateCommitments(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null) {
    return { valid: false, error: 'Response must be an object.' };
  }
  const commitments = (value as Record<string, unknown>).commitments;
  if (!Array.isArray(commitments)) {
    return { valid: false, error: 'commitments must be an array.' };
  }

  const result: RawCommitment[] = [];
  for (const c of commitments) {
    if (typeof c !== 'object' || c === null) {
      return { valid: false, error: 'Each commitment must be an object.' };
    }
    const r = c as Record<string, unknown>;
    if (!isCommitmentKind(r.kind)) {
      return { valid: false, error: `kind must be one of ${COMMITMENT_KINDS.join(', ')}.` };
    }
    if (typeof r.detail !== 'string' || !r.detail.trim()) {
      return { valid: false, error: 'detail must be a non-empty string.' };
    }
    if (!isNullableString(r.promised_time_local)) {
      return { valid: false, error: 'promised_time_local must be a string or null.' };
    }
    if (!isNullableInt(r.promised_day_offset)) {
      return { valid: false, error: 'promised_day_offset must be an integer or null.' };
    }
    if (
      r.promised_day_offset !== null
      && (r.promised_day_offset < 0 || r.promised_day_offset > MAX_PROMISED_DAY_OFFSET)
    ) {
      return {
        valid: false,
        error: `promised_day_offset must be between 0 and ${MAX_PROMISED_DAY_OFFSET}, or null.`,
      };
    }
    result.push({
      kind: r.kind,
      detail: r.detail,
      promised_time_local: r.promised_time_local,
      promised_day_offset: r.promised_day_offset,
    });
  }
  return { valid: true, commitments: result };
}

// One retry: sends the validation error back as a tool_result so the second
// attempt can correct itself.
const MAX_ATTEMPTS = 2;
// Small structured-extraction call -- an array of short objects, nowhere
// near Haiku's ceiling. MAX_TOKENS_RETRY is a one-shot headroom bump before
// giving up entirely.
const MAX_TOKENS = 2048;
const MAX_TOKENS_RETRY = 4096;

export async function extractRawCommitments(transcript: string): Promise<RawCommitment[]> {
  const client = getClaudeClient();
  if (!client) {
    throw new Error('Claude not configured. Set ANTHROPIC_API_KEY in .env.local');
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        'Call transcript:',
        truncateTranscript(transcript),
        '',
        'Extract the rep commitments from this call now.',
      ].join('\n'),
    },
  ];

  const callExtract = (maxTokens: number) =>
    client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      tools: [EMIT_COMMITMENTS_TOOL],
      tool_choice: { type: 'tool', name: 'emit_commitments' },
      messages,
    });

  let lastError = 'unknown validation error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response = await callExtract(MAX_TOKENS);

    if (response.stop_reason === 'max_tokens') {
      response = await callExtract(MAX_TOKENS_RETRY);
      if (response.stop_reason === 'max_tokens') {
        throw new TerminalCommitmentExtractionError(
          'Commitment extraction ran past the token limit; nothing was saved.',
        );
      }
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'emit_commitments',
    );
    if (!toolUse) {
      throw new TerminalCommitmentExtractionError('Claude did not return commitments.');
    }

    const checked = validateCommitments(toolUse.input);
    if (checked.valid) {
      return checked.commitments;
    }
    lastError = checked.error;

    if (attempt < MAX_ATTEMPTS) {
      messages.push(
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: toolUse.id,
              is_error: true,
              content: `That result was rejected: ${checked.error} Call emit_commitments again with every field as real JSON of its declared type.`,
            },
          ],
        },
      );
    }
  }

  throw new TerminalCommitmentExtractionError(
    `Claude returned incomplete commitments (${lastError}); nothing was saved.`,
  );
}
