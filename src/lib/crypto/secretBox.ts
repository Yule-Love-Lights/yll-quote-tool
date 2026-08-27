// src/lib/crypto/secretBox.ts — symmetric encryption for secrets held at rest.
//
// WHY THIS EXISTS. `integration_tokens.refresh_token_enc` has carried the comment
// "encrypted at rest (Vault/pgcrypto)" since the Gmail work, and nothing ever
// implemented it — Gmail ended up reading a refresh token from an env var, so the
// column stayed empty and the promise stayed untested. Row 403's fleet-GPS work
// is the first real user of that table, and Bouncie's tokens ROTATE, so they
// genuinely have to live in the database rather than in an env var.
//
// Storing a live token in plaintext under a column named `_enc` would be worse
// than storing it honestly, because the next person to read the schema would
// believe a protection that was not there. So this module makes the name true.
//
// WHAT IT PROTECTS AGAINST, and what it does not. AES-256-GCM with a key held
// only in the environment means a database read alone — a leaked service-role
// key, a support session, a restored backup — does not hand over usable tokens.
// It does NOT protect against an attacker who already has the running
// application's environment, because at that point they have the key. That is
// the honest boundary, and it is still worth having: database exposure and
// environment exposure are different incidents with very different likelihoods.
//
// FAILS CLOSED. With no key configured, encrypt throws rather than silently
// storing plaintext. A misconfigured deploy must refuse to write a token, not
// quietly write an unprotected one.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Format marker, so a future algorithm change is detectable rather than a mystery. */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the value GCM is specified for
const KEY_BYTES = 32; // 256 bits

export class SecretBoxNotConfiguredError extends Error {}
export class SecretBoxDecryptError extends Error {}

/**
 * The encryption key, as raw bytes.
 *
 * `TOKEN_ENCRYPTION_KEY` must be 32 bytes, base64-encoded. Generate one with:
 *   [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
 *
 * A wrong-length key throws at use time rather than being padded or truncated
 * into something that appears to work: a silently weakened key is the failure
 * mode this whole module exists to avoid.
 */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new SecretBoxNotConfiguredError(
      'TOKEN_ENCRYPTION_KEY is not set; refusing to handle secrets unencrypted.',
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new SecretBoxNotConfiguredError(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${buf.length}.`,
    );
  }
  return buf;
}

/** True when a usable key is configured. Never throws; for health checks. */
export function isSecretBoxConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a secret for storage.
 *
 * Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64. The IV is random per
 * call, so encrypting the same token twice produces different output and the
 * stored value leaks nothing by comparison.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

/**
 * Decrypt a stored secret.
 *
 * GCM authenticates as well as encrypts, so a tampered or truncated value fails
 * here rather than decrypting into plausible garbage that later code would treat
 * as a real token.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretBoxDecryptError(`Unrecognised secret format (expected ${VERSION}.iv.tag.ciphertext).`);
  }
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64!, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64!, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof SecretBoxNotConfiguredError) throw err;
    // Deliberately does not echo the stored value or the underlying error text,
    // either of which can end up in a log.
    throw new SecretBoxDecryptError('Could not decrypt stored secret (wrong key, or the value was altered).');
  }
}
