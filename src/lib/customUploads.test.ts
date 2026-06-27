import { describe, it, expect } from 'vitest';
import { isAllowedImageType, extFor, isValidUploadPath, resolvePublicUrl } from './customUploads';

describe('isAllowedImageType', () => {
  it('accepts the supported raster image types', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(isAllowedImageType(t)).toBe(true);
    }
  });
  // Audit fix (g28): SVG is no longer an accepted upload type (stored-XSS vector).
  it('rejects svg and other types', () => {
    expect(isAllowedImageType('image/svg+xml')).toBe(false);
    expect(isAllowedImageType('application/pdf')).toBe(false);
    expect(isAllowedImageType('text/html')).toBe(false);
    expect(isAllowedImageType('')).toBe(false);
  });
});

describe('extFor', () => {
  it('maps the content type to an extension', () => {
    expect(extFor('image/png', 'x.png')).toBe('png');
    expect(extFor('image/jpeg', 'x.jpg')).toBe('jpg');
  });
  it('falls back to the filename extension when the type is unknown', () => {
    expect(extFor('application/octet-stream', 'photo.PNG')).toBe('png');
    expect(extFor('', 'wreath.jpeg')).toBe('jpg'); // jpeg normalizes to jpg
    expect(extFor('', 'art.webp')).toBe('webp');
  });
  // Audit fix (g28): svg no longer maps to an allowed extension, by type or name.
  it('rejects svg uploads', () => {
    expect(extFor('image/svg+xml', 'logo.svg')).toBeNull();
    expect(extFor('', 'logo.svg')).toBeNull();
  });
  it('returns null when neither the type nor the filename is an allowed image', () => {
    expect(extFor('application/pdf', 'doc.pdf')).toBeNull();
    expect(extFor('', 'noext')).toBeNull();
  });
});

// Audit fix (g28): /photos path validation — only well-formed {uuid}.{ext} keys resolve.
describe('isValidUploadPath', () => {
  const uuid = '0f2ef5c8-f6d0-4e84-a687-2aec3f3e31f4';
  it('accepts a well-formed {uuid}.{ext} object key', () => {
    for (const ext of ['png', 'jpg', 'webp', 'gif', 'svg']) {
      expect(isValidUploadPath(`${uuid}.${ext}`)).toBe(true);
    }
  });
  it('rejects path traversal, subpaths, and arbitrary keys', () => {
    expect(isValidUploadPath('../secrets.png')).toBe(false);
    expect(isValidUploadPath(`folder/${uuid}.png`)).toBe(false);
    expect(isValidUploadPath(`${uuid}.png/../../etc`)).toBe(false);
    expect(isValidUploadPath(`${uuid}.exe`)).toBe(false);
    expect(isValidUploadPath('notauuid.png')).toBe(false);
    expect(isValidUploadPath('')).toBe(false);
    expect(isValidUploadPath(null)).toBe(false);
    expect(isValidUploadPath(undefined)).toBe(false);
  });
});

describe('resolvePublicUrl', () => {
  it('returns null for an invalid / unset path (no Supabase URL built)', () => {
    expect(resolvePublicUrl(null)).toBeNull();
    expect(resolvePublicUrl('../secrets.png')).toBeNull();
    expect(resolvePublicUrl('arbitrary/object/path')).toBeNull();
  });
});
