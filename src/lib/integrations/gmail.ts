// Gmail REST client (#58) — dependency-free (no googleapis SDK; raw fetch). READ
// side only: refresh-token OAuth + threads.list / threads.get. The dashboard
// adapter (src/lib/dashboard/inbox/gmail.ts) maps the raw threads into touches.
//
// Auth: a long-lived refresh token (Workspace "Internal" OAuth consent, scope
// gmail.modify/readonly) exchanged for short-lived access tokens. Creds come from
// env (set during go-live) so this is dormant until configured:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER (sales@…)
// Go-live hardening (noted): move the refresh token into integration_tokens
// (encrypted) instead of env.

import type { RawGmailThread } from '@/lib/dashboard/inbox/gmail';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

export function isGmailConfigured(): boolean {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
}

function gmailUser(): string {
  return process.env.GMAIL_USER || 'me';
}

// Access tokens last ~1h; cache across requests in a process (mirrors supabase.ts).
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(now: number = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Gmail not configured');
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gmail token refresh → ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Gmail token refresh: no access_token');
  cachedToken = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

async function gmailGet<T>(path: string, accessToken: string): Promise<T> {
  // ⚠️ The access token is in the Authorization header. Don't enable verbose HTTP
  // request logging in prod without masking Authorization (it's a live credential,
  // short-lived but still a leak).
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gmail GET ${path} → ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export type GmailThreadRef = { id: string; snippet?: string; historyId?: string };

/** Recent inbox threads (ids + snippets). Bounded; needs-reply is decided per-thread. */
export async function listInboxThreads(accessToken: string, opts: { maxResults?: number } = {}): Promise<GmailThreadRef[]> {
  const params = new URLSearchParams({
    q: 'in:inbox',
    maxResults: String(Math.min(Math.max(opts.maxResults ?? 25, 1), 100)),
  });
  const json = await gmailGet<{ threads?: GmailThreadRef[] }>(
    `/users/${encodeURIComponent(gmailUser())}/threads?${params}`,
    accessToken,
  );
  return json.threads ?? [];
}

/** One thread with message metadata (From/Subject headers, labels, internalDate). */
export async function getThread(accessToken: string, threadId: string): Promise<RawGmailThread> {
  const params = new URLSearchParams({ format: 'metadata' });
  for (const h of ['From', 'Subject']) params.append('metadataHeaders', h);
  return gmailGet<RawGmailThread>(
    `/users/${encodeURIComponent(gmailUser())}/threads/${encodeURIComponent(threadId)}?${params}`,
    accessToken,
  );
}

// ─── WRITE side (gmail.modify) — the Handled write-back ─────────────────────
// Coded, but only invoked from the Handled route (never auto-run). The poll above
// is strictly read; these mutate the mailbox.

async function gmailPost<T>(path: string, accessToken: string, body: unknown): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gmail POST ${path} → ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export type GmailLabel = { id: string; name: string };

/** ⚠️ WRITE. Find the label by name, or create it; returns its id. */
export async function getOrCreateLabel(accessToken: string, name: string): Promise<string> {
  const user = encodeURIComponent(gmailUser());
  const list = await gmailGet<{ labels?: GmailLabel[] }>(`/users/${user}/labels`, accessToken);
  const found = list.labels?.find((l) => l.name === name);
  if (found) return found.id;
  const created = await gmailPost<GmailLabel>(`/users/${user}/labels`, accessToken, { name });
  return created.id;
}

/** ⚠️ WRITE. Add/remove labels on a thread (Handled: + YLL/Handled, − UNREAD).
 *  Affects EVERY message on the thread — see modifyMessage below for the
 *  single-message sibling the Handled write-back prefers whenever it knows
 *  the specific message id (#288 fix round). */
export async function modifyThread(
  accessToken: string,
  threadId: string,
  body: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<void> {
  const user = encodeURIComponent(gmailUser());
  await gmailPost<unknown>(`/users/${user}/threads/${encodeURIComponent(threadId)}/modify`, accessToken, body);
}

/** ⚠️ WRITE. Add/remove labels on a single MESSAGE (not its whole thread).
 *  #288 fix round (staff HIGH): the Handled write-back uses this instead of
 *  modifyThread whenever the target row knows its own message id (any
 *  GML-split touch), so marking one customer's row Handled doesn't also
 *  stamp sibling customers' still-unworked forwards on the same coalesced
 *  thread as read/labeled. */
export async function modifyMessage(
  accessToken: string,
  messageId: string,
  body: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<void> {
  const user = encodeURIComponent(gmailUser());
  await gmailPost<unknown>(`/users/${user}/messages/${encodeURIComponent(messageId)}/modify`, accessToken, body);
}
