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

describe('parseLineItem — custom $/ft labels (#102)', () => {
  // The #102 custom rate replaces the "(medium)" token with "($X/ft)". Pin the
  // kind + footage so the label→kind→buildLineItemId→approve-route selection
  // chain can't silently regress (the "$5/ft" must not be mistaken for footage,
  // and "/ft" must not trip the Stake/Ridge/Roofline classifiers).
  it('classifies custom-rate labels to the same kind as preset labels', () => {
    expect(parseLineItem("Santa's Roofline – 100ft ($5/ft)").kind).toBe('roofline');
    expect(parseLineItem('Winter Wonderland – 40ft ($15/ft)').kind).toBe('ridge');
    expect(parseLineItem('Stake Lighting – 100ft ($4/ft)').kind).toBe('stake-lighting');
  });

  it('extracts the real footage, not the rate digits', () => {
    expect(parseLineItem("Santa's Roofline – 100ft ($5/ft)").detail).toBe('100 ft');
    expect(parseLineItem('Stake Lighting – 50ft ($6.5/ft)').detail).toBe('50 ft'); // fractional rate
    expect(parseLineItem('Stake Lighting – 50ft ($6.5/ft)').kind).toBe('stake-lighting');
  });
});

describe('parseLineItem — Bistro (#117)', () => {
  it('classifies event Bistro Lighting as its own kind', () => {
    const parsed = parseLineItem('Bistro Lighting – 40ft');
    expect(parsed.kind).toBe('bistro');
    expect(parsed.detail).toBe('40 ft');
  });

  it('classifies design-projected Permanent Bistro Lighting as the same kind, not roofline', () => {
    const parsed = parseLineItem('Permanent Bistro Lighting – 30ft');
    expect(parsed.kind).toBe('bistro');
    expect(parsed.detail).toBe('30 ft');
  });
});
