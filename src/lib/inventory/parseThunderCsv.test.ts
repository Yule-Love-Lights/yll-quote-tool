import { describe, it, expect } from 'vitest';
import { parseThunderCsv, type ParsedCatalogItem } from './parseThunderCsv';

// A trimmed slice of the real Thunder sheet: header, two section dividers, a
// normal bulb row, a hardware (clip) row, a quoted wreath row, and a trailing
// note row (no SKU).
const SAMPLE = [
  'SKU, Wholesale , Retail 26 ,ProductName, Category  , Wattage , Voltage ,Color,Spaceing / Size ,Adapter Needed,Bag CT,Case CT, BULk BUY  , Bulk Buy Qty  ,,',
  ',,,BULBS,,,,,,,,,,,,',
  ',,,Faceted C9 Bulbs ,,,,,,,,,,,,',
  '20009-SPK, $ 0.59 , $ 1.24 ,C9 Sun Warm White Faceted Spk,Bulb ,  0.80 ,120,Sun Warm White 2600K,C9 / E17,xx,25,500, $ 0.52 ,4000,,',
  '14147, $ 0.23 , $ 0.32 ,C9 Flex Clip- White,Hardware ,xx,xx,White ,xx,xx,100,800, $ 0.20 ,800,,',
  '23999, $ 4.29 , $ 5.99 ,C9 LED Glitzer RGBWW,RGB,xx,xx,Rgb,E17,YES,25,500,,,,',
  '50018-30, $ 52.99 , $ 73.99 ,"18"" Warm White Noble Wreath - HBL",Greenery ,0,120,Warm White ,"18""",xx,-2,6,,,,',
  ',,,,,,,,,,,,,,2026 Wholesale prices subject to change.',
].join('\n');

describe('parseThunderCsv', () => {
  it('skips the header, section dividers, and note rows (no SKU)', () => {
    const items = parseThunderCsv(SAMPLE);
    expect(items.map((i) => i.sku)).toEqual(['20009-SPK', '14147', '23999', '50018-30']);
  });

  it('parses a normal bulb row into clean fields', () => {
    const bulb = parseThunderCsv(SAMPLE).find((i) => i.sku === '20009-SPK') as ParsedCatalogItem;
    expect(bulb).toMatchObject({
      sku: '20009-SPK',
      name: 'C9 Sun Warm White Faceted Spk',
      category: 'Bulb',
      color: 'Sun Warm White 2600K',
      size: 'C9 / E17',
      wholesale_cost: 0.59,
      needs_adapter: false,
      bag_ct: 25,
      case_ct: 500,
    });
  });

  it('reads needs_adapter from YES vs xx', () => {
    const rgb = parseThunderCsv(SAMPLE).find((i) => i.sku === '23999')!;
    const clip = parseThunderCsv(SAMPLE).find((i) => i.sku === '14147')!;
    expect(rgb.needs_adapter).toBe(true);
    expect(clip.needs_adapter).toBe(false);
  });

  it('handles quoted fields with embedded inch-marks and commas', () => {
    const wreath = parseThunderCsv(SAMPLE).find((i) => i.sku === '50018-30')!;
    expect(wreath.name).toBe('18" Warm White Noble Wreath - HBL');
    expect(wreath.size).toBe('18"');
    expect(wreath.category).toBe('Greenery');
    expect(wreath.bag_ct).toBe(-2); // imported faithfully, operator fixes later
  });

  it('turns empty color/size into null', () => {
    const clip = parseThunderCsv(SAMPLE).find((i) => i.sku === '14147')!;
    expect(clip.size).toBeNull();   // "xx" in the size column → null
    expect(clip.color).toBe('White');
  });

  it('returns [] for empty input', () => {
    expect(parseThunderCsv('')).toEqual([]);
    expect(parseThunderCsv('SKU,Wholesale\n')).toEqual([]);
  });
});
