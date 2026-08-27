import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isSecretBoxConfigured,
  SecretBoxNotConfiguredError,
  SecretBoxDecryptError,
} from './secretBox';

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
});
afterEach(() => {
  if (prev === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = prev;
});

describe('round trip', () => {
  it('decrypts back to the original', () => {
    const secret = 'a-refresh-token-value-12345';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('handles an empty string and unicode', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('');
    expect(decryptSecret(encryptSecret('café ☕ 東京'))).toBe('café ☕ 東京');
  });

  it('never stores the plaintext in the output', () => {
    const secret = 'SUPERSECRETTOKEN';
    expect(encryptSecret(secret)).not.toContain(secret);
  });

  it('produces DIFFERENT ciphertext each time, so equal tokens are not comparable at rest', () => {
    const secret = 'same-token';
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });
});

describe('fails closed', () => {
  it('refuses to encrypt with no key rather than storing plaintext', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSecret('x')).toThrow(SecretBoxNotConfiguredError);
  });

  it('refuses a key that is the wrong length instead of padding it', () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptSecret('x')).toThrow(SecretBoxNotConfiguredError);
  });

  it('reports configuration without throwing', () => {
    expect(isSecretBoxConfigured()).toBe(true);
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(isSecretBoxConfigured()).toBe(false);
  });
});

describe('tampering and wrong keys are detected, not silently mis-decrypted', () => {
  it('rejects a value encrypted under a different key', () => {
    const box = encryptSecret('token');
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    expect(() => decryptSecret(box)).toThrow(SecretBoxDecryptError);
  });

  it('rejects an altered ciphertext', () => {
    const parts = encryptSecret('token').split('.');
    const data = Buffer.from(parts[3]!, 'base64');
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString('base64');
    expect(() => decryptSecret(parts.join('.'))).toThrow(SecretBoxDecryptError);
  });

  it('rejects a malformed or truncated value', () => {
    expect(() => decryptSecret('nonsense')).toThrow(SecretBoxDecryptError);
    expect(() => decryptSecret('v1.only.three')).toThrow(SecretBoxDecryptError);
  });

  it('rejects an unknown format version rather than guessing', () => {
    const parts = encryptSecret('token').split('.');
    parts[0] = 'v2';
    expect(() => decryptSecret(parts.join('.'))).toThrow(/Unrecognised secret format/);
  });

  it('does not leak the stored value in the error message', () => {
    const box = encryptSecret('token');
    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    try {
      decryptSecret(box);
      throw new Error('should have thrown');
    } catch (e) {
      expect(String(e)).not.toContain(box.split('.')[3]);
    }
  });

  it('surfaces a missing key as NOT-CONFIGURED, not as a decrypt failure', () => {
    // These mean different things operationally: one is a deploy problem, the
    // other is a corrupted or foreign value.
    const box = encryptSecret('token');
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => decryptSecret(box)).toThrow(SecretBoxNotConfiguredError);
  });
});
