// Pure parser for the generic ingest endpoint (#58 Phase 2). A normalized JSON
// contract that a Zapier Zap (Homeworks, or any future source) POSTs to
// /api/dashboard/ingest. Validates + maps to a NormalizedTouch. Read-only source:
// Handled only updates our row, never writes back. Pure — the route does the I/O.
//
// Contract:
//   { externalId, occurredAt, source?='homeworks', direction?, channel?,
//     preview?, subject?, contact: { email?, phone?, name?, ghlContactId? } }

import type { Channel, Direction, InboxSource, NormalizedTouch } from './types';
import { isInboxSource } from './types';
import { normalizeEmail, normalizeName, normalizePhone, toDate } from './normalize';

const CHANNELS: readonly string[] = ['sms', 'email', 'call', 'fb', 'ig', 'app'];

export type IngestParseResult = { ok: true; touch: NormalizedTouch } | { ok: false; error: string };

export function parseIngestPayload(body: unknown): IngestParseResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;

  const externalId = b.externalId;
  if (typeof externalId !== 'string' || !externalId) return { ok: false, error: 'externalId is required' };

  const occurredAt = b.occurredAt;
  if (typeof occurredAt !== 'string' && typeof occurredAt !== 'number') {
    return { ok: false, error: 'occurredAt (ISO string or epoch ms) is required' };
  }
  const lastMessageAt = toDate(occurredAt);
  if (Number.isNaN(lastMessageAt.getTime())) {
    // Reject garbage here for a clean 400 — otherwise it would throw at
    // .toISOString() during the upsert and surface as a 500.
    return { ok: false, error: 'occurredAt is not a valid date/time' };
  }

  let source: InboxSource = 'homeworks';
  if (b.source !== undefined) {
    if (!isInboxSource(b.source)) return { ok: false, error: `Unknown source: ${String(b.source)}` };
    source = b.source;
  }

  const contact = (b.contact && typeof b.contact === 'object' ? b.contact : {}) as Record<string, unknown>;
  const email = typeof contact.email === 'string' ? normalizeEmail(contact.email) : null;
  const phone = typeof contact.phone === 'string' ? normalizePhone(contact.phone) : null;
  const name = typeof contact.name === 'string' ? normalizeName(contact.name) : null;
  const ghlContactId =
    typeof contact.ghlContactId === 'string' && contact.ghlContactId ? contact.ghlContactId : null;
  if (!email && !phone && !name && !ghlContactId) {
    return { ok: false, error: 'contact needs at least one of email/phone/name/ghlContactId' };
  }

  const direction: Direction | null = b.direction === 'inbound' || b.direction === 'outbound' ? b.direction : null;
  const channel: Channel | null =
    typeof b.channel === 'string' && CHANNELS.includes(b.channel) ? (b.channel as Channel) : null;

  return {
    ok: true,
    touch: {
      source,
      externalId,
      sourceMessageId: null,
      direction,
      channel,
      lastMessageAt,
      preview: typeof b.preview === 'string' ? b.preview.slice(0, 2000) : null,
      subject: typeof b.subject === 'string' ? b.subject.slice(0, 500) : null,
      identity: {
        ghlContactId,
        emails: email ? [email] : [],
        phones: phone ? [phone] : [],
        displayName: name,
      },
      raw: body,
    },
  };
}
