// "Does this look like a real rep-customer exchange" heuristic, ported
// verbatim from the yll-call-copilot repo's src/lib/transcripts/junk.ts
// (master fb1bf326). Works against any array of { speaker, text } turns --
// a HighLevel-derived utterance satisfies that shape (see
// transcribeHighLevel.ts). Applied POST-transcription in the calls pipeline
// (calls_merge_plan_2026-08.md slice S2); the under-20-second duration skip
// is a separate, pre-transcription check (see sync.ts's MIN_RECORDING_SECONDS).

export type JunkTurn = { speaker: string; text: string };
export type JunkReason = 'single_speaker' | 'too_short' | 'automated_speaker';

// A "phrase" here is deliberately a short, punctuation-tolerant fragment
// (e.g. "stay on the line" rather than "please stay on the line") because
// real-world transcription inserts erratic commas/periods mid-sentence
// ("Thanks, please. Stay on the line."), which would break a longer literal
// match. Ported as-is from the copilot's phrase list (grepped from its own
// real call export, not guessed) -- best-effort, not exhaustive: a heavily
// garbled voicemail greeting can still slip through as "kept", which just
// means it gets treated as a real (if low-value) call rather than being
// excluded outright.
export const IVR_PHRASES = [
  'is not available',
  'not available right now',
  'not available at the tone',
  'forwarded to voicemail',
  'forwarded to an automatic voice',
  'forwarded to an automated voice',
  'voice messaging system',
  'record your message',
  'record your name and reason for calling',
  'you may hang up',
  'press 1',
  'press pound',
  'press 0',
  'the person you are calling is protected',
  'connect your call',
  'leave your message',
  'leave your name',
  'leave me your name',
  'leave a message',
  'leave me a message',
  'leave a detailed message',
  'give your message',
  'give me a message',
  'mailbox is full',
  "can't take your call",
  'cannot take your call',
  'stay on the line',
  "didn't get your message",
  'did not get your message',
  'were not speaking',
  'bad connection',
  'reply after the tone',
  'at the tone',
  'get back to you shortly',
  'back to you shortly',
  'as soon as possible',
];

// A transcribed turn that is nothing but digits/punctuation is never real
// speech (e.g. an automated readout transcribed as bare digits), so it
// counts as automated too.
const DIGIT_ONLY_TURN = /^[\d\s.,()-]+$/;

export function isAutomatedTurn(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (DIGIT_ONLY_TURN.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return IVR_PHRASES.some(phrase => lower.includes(phrase));
}

function wordsIn(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Below this, there's nothing to extract regardless of who's speaking.
const MIN_WORD_COUNT = 20;

// Returns why a set of turns looks like junk (voicemail/IVR noise, never a
// real rep-customer exchange), or null if it looks real: single_speaker,
// too_short, and automated_speaker.
export function junkReasonFromTurns(turns: JunkTurn[]): JunkReason | null {
  const speakers = [...new Set(turns.map(t => t.speaker))];
  if (speakers.length <= 1) return 'single_speaker';

  const wordCount = turns.reduce((sum, t) => sum + wordsIn(t.text), 0);
  if (wordCount < MIN_WORD_COUNT) return 'too_short';

  for (const speaker of speakers) {
    const speakerTurns = turns.filter(t => t.speaker === speaker && t.text.trim());
    if (speakerTurns.length > 0 && speakerTurns.every(t => isAutomatedTurn(t.text))) {
      return 'automated_speaker';
    }
  }
  return null;
}
