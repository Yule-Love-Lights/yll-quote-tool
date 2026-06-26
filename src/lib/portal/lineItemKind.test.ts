import { describe, it, expect } from 'vitest';
import { parseLineItem } from './lineItemKind';

describe('parseLineItem — Stake Lighting', () => {
  it('classifies a Stake Lighting label as its own kind', () => {
    const parsed = parseLineItem('Stake Lighting – 50ft (medium)');
    expect(parsed.kind).toBe('stake-lighting');
    expect(parsed.detail).toBe('50 ft');
  });

  it('does not steal the roofline / ridge labels', () => {
    expect(parseLineItem("Santa's Roofline – 180ft (medium)").kind).toBe('roofline');
    expect(parseLineItem('Gingerbread – 90ft (medium)').kind).toBe('ridge');
    expect(parseLineItem('Winter Wonderland – 50ft (easy)').kind).toBe('ridge');
  });
});
