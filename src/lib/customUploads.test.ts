import { describe, it, expect } from 'vitest';
import { isAllowedImageType, extFor } from './customUploads';

describe('isAllowedImageType', () => {
  it('accepts the supported image types', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']) {
      expect(isAllowedImageType(t)).toBe(true);
    }
  });
  it('rejects other types', () => {
    expect(isAllowedImageType('application/pdf')).toBe(false);
    expect(isAllowedImageType('text/html')).toBe(false);
    expect(isAllowedImageType('')).toBe(false);
  });
});

describe('extFor', () => {
  it('maps the content type to an extension', () => {
    expect(extFor('image/png', 'x.png')).toBe('png');
    expect(extFor('image/jpeg', 'x.jpg')).toBe('jpg');
    expect(extFor('image/svg+xml', 'logo.svg')).toBe('svg');
  });
  it('falls back to the filename extension when the type is unknown', () => {
    expect(extFor('application/octet-stream', 'photo.PNG')).toBe('png');
    expect(extFor('', 'wreath.jpeg')).toBe('jpg'); // jpeg normalizes to jpg
    expect(extFor('', 'art.webp')).toBe('webp');
  });
  it('returns null when neither the type nor the filename is an allowed image', () => {
    expect(extFor('application/pdf', 'doc.pdf')).toBeNull();
    expect(extFor('', 'noext')).toBeNull();
  });
});
