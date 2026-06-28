import { describe, it, expect } from 'vitest';
import { parseWhatsAppCommand } from './whatsappCommands';

describe('parseWhatsAppCommand (#82 Phase 3)', () => {
  it('parses simple verbs (case-insensitive) + aliases', () => {
    expect(parseWhatsAppCommand('help')).toEqual({ kind: 'help' });
    expect(parseWhatsAppCommand('?')).toEqual({ kind: 'help' });
    expect(parseWhatsAppCommand('JOBS')).toEqual({ kind: 'jobs' });
    expect(parseWhatsAppCommand('board')).toEqual({ kind: 'jobs' });
    expect(parseWhatsAppCommand('low')).toEqual({ kind: 'low' });
  });

  it('parses move with fuzzy stage words', () => {
    expect(parseWhatsAppCommand('move 1042 prepared')).toEqual({ kind: 'move', jobNumber: 1042, stage: 'to_be_prepared' });
    expect(parseWhatsAppCommand('move 1042 ready')).toEqual({ kind: 'move', jobNumber: 1042, stage: 'ready_for_install' });
    expect(parseWhatsAppCommand('move 7 pick up')).toEqual({ kind: 'move', jobNumber: 7, stage: 'awaiting_pickup' });
    expect(parseWhatsAppCommand('MOVE 9 ORDERED')).toEqual({ kind: 'move', jobNumber: 9, stage: 'to_be_ordered' });
  });

  it('rejects move with a bad number or unrecognized stage', () => {
    expect(parseWhatsAppCommand('move abc prepared').kind).toBe('unknown');
    expect(parseWhatsAppCommand('move 1042 sideways').kind).toBe('unknown');
    expect(parseWhatsAppCommand('move 1042').kind).toBe('unknown');
  });

  it('parses prep (+ aliases) and rejects a missing number', () => {
    expect(parseWhatsAppCommand('prep 1042')).toEqual({ kind: 'prep', jobNumber: 1042 });
    expect(parseWhatsAppCommand('prepare 5')).toEqual({ kind: 'prep', jobNumber: 5 });
    expect(parseWhatsAppCommand('prep').kind).toBe('unknown');
  });

  it('parses stock + set (preserves SKU casing/dashes)', () => {
    expect(parseWhatsAppCommand('stock 14147')).toEqual({ kind: 'stock', sku: '14147' });
    expect(parseWhatsAppCommand('stock 50036-30')).toEqual({ kind: 'stock', sku: '50036-30' });
    expect(parseWhatsAppCommand('set 14147 200')).toEqual({ kind: 'set', sku: '14147', qty: 200 });
    expect(parseWhatsAppCommand('set 14147')).toEqual({ kind: 'unknown', raw: 'set 14147' });
    expect(parseWhatsAppCommand('set 14147 -3').kind).toBe('unknown'); // non-numeric qty
  });

  it('unknown for empty / gibberish', () => {
    expect(parseWhatsAppCommand('')).toEqual({ kind: 'unknown', raw: '' });
    expect(parseWhatsAppCommand('   ')).toEqual({ kind: 'unknown', raw: '' });
    expect(parseWhatsAppCommand('hello there')).toEqual({ kind: 'unknown', raw: 'hello there' });
  });
});
