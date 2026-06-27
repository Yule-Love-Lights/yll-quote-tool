// Pure parser for the Thunder Lighting wholesale CSV (#82 Slice 1a). No deps —
// the sheet quotes fields containing commas / inch-marks (e.g. "18"" Wreath"),
// so we hand-roll RFC4180-style quote-aware splitting.

export type ParsedCatalogItem = {
  sku: string;
  name: string;
  category: string;
  color: string | null;
  size: string | null;
  wholesale_cost: number | null;
  needs_adapter: boolean;
  bag_ct: number | null;
  case_ct: number | null;
};

// Column order in the Thunder sheet (0-based):
// 0 SKU · 1 Wholesale · 2 Retail · 3 ProductName · 4 Category · 5 Wattage ·
// 6 Voltage · 7 Color · 8 Spacing/Size · 9 Adapter Needed · 10 Bag CT · 11 Case CT
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped ""
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function text(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length ? t : null;
}

function money(v: string | undefined): number | null {
  const n = parseFloat((v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function int(v: string | undefined): number | null {
  const cleaned = (v ?? '').replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseThunderCsv(csv: string): ParsedCatalogItem[] {
  const lines = csv.split(/\r?\n/);
  const out: ParsedCatalogItem[] = [];
  // Start at 1 to skip the header row.
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const f = splitCsvLine(raw);
    const sku = (f[0] ?? '').trim();
    if (!sku) continue; // section-divider + note rows carry no SKU
    const name = (f[3] ?? '').trim();
    if (!name) continue; // skip malformed rows defensively
    const sizeRaw = (f[8] ?? '').trim();
    out.push({
      sku,
      name,
      category: (f[4] ?? '').trim() || 'Uncategorized',
      color: text(f[7]),
      size: sizeRaw.toLowerCase() === 'xx' ? null : text(sizeRaw),
      wholesale_cost: money(f[1]),
      needs_adapter: /^yes$/i.test((f[9] ?? '').trim()),
      bag_ct: int(f[10]),
      case_ct: int(f[11]),
    });
  }
  return out;
}
