#!/usr/bin/env node
// Read the task ledger without reading the task ledger.
//
// `docs/context/task_ledger.md` is ~210 KB of prose in ~123 single-line table
// rows (the fattest is >25,000 characters). Answering "what is still open, and
// whose is it?" by reading it costs a large slice of a session's context every
// time, and the answer is easy to get wrong in BOTH directions: finished rows
// linger in the ACTIVE tables, and a row can declare its own completion in any
// cell — not just a status column, because there is no status column.
//
// This encodes the file's real, messy status vocabulary ONCE so no future
// session has to re-derive it. It is a READER and a LINTER: it never writes to
// the ledger.
//
// Usage:
//   node scripts/ledger.mjs open                 every row that still looks open
//   node scripts/ledger.mjs open --owner jason   ...filtered by owner guess
//   node scripts/ledger.mjs done                 rows in ACTIVE tables that read as finished
//   node scripts/ledger.mjs row 453              one row, in full
//   node scripts/ledger.mjs stats                counts + the file's fattest lines
//   node scripts/ledger.mjs lint                 exit 1 if a finished row sits in an ACTIVE table
//
//   node scripts/ledger.mjs prs                 rows citing a PR as open that has since MERGED
//
// Flags: --owner <jason|naldo|unclear>  --json  --file <path>  --width <n>
//
// WHAT THIS CANNOT SEE — state it, don't let a comfortable number stand in for
// coverage. Classification keys off a status marker at the HEAD of a cell,
// because a marker anywhere else is almost always the row narrating some other
// PR. Rows that bury their own completion mid-paragraph are therefore invisible
// to it. Measured against a careful human read of the same file on 2026-08-29,
// eight such rows were missed: 458, 468, 221, 360, 318, 251, 118, 355. Row 355
// is the extreme case and the reason `prs` exists — its text never says it
// shipped at all; the only evidence is that the PR it cites has merged.
// So: `done` is a floor, never a complete list. Treat a clean `lint` as "no
// row ADMITS to being finished", not as "nothing here is finished".

import { readFileSync } from 'node:fs';

const DEFAULT_FILE = 'docs/context/task_ledger.md';

// ── the vocabulary ────────────────────────────────────────────────────────
// Derived by counting every marker actually present in the file (2026-08-29),
// not from a convention doc — there isn't one. Deliberately CASE-SENSITIVE on
// the words: the ledger writes finished states in caps ("SHIPPED", "CLOSED"),
// while lowercase "closed" appears constantly in ordinary prose ("fails
// closed", "the PR was closed unmerged"). Matching case-insensitively here
// turned an open row into a finished one in testing.
// THE RULE, derived empirically rather than assumed: a status marker LEADS a
// cell. Every row's prose mentions shipped work — the PR that caused it, the
// sibling fix that landed, the audit that found it — so a marker found
// anywhere in a row means nothing. A marker in the first few characters of a
// cell is the row declaring its own state. Scanning whole rows instead
// classified 44 rows as finished when ~25 are; scanning cell openings agrees
// with a careful human read.
// ...and it must be ANCHORED at the cell's opening, not merely near it. Row
// 450's verdict reads "✅ SHIPPED S57 — PR #1113. Was recorded as DORMANT on
// the reasoning that…" — a proximity match on the first 64 characters reads
// DORMANT and files a shipped row as parked. Only the first token counts.
const NOISE = String.raw`[\s~*\[\(]*`; // markdown/bracket noise before the marker
const DONE_LEAD = new RegExp(`^${NOISE}(?:[✅🟢]${NOISE})?(SHIPPED|CLOSED|RESOLVED|BUILT S\\d|FIXED by|ANSWERED|DONE\\b)`, 'u');
const DONE_TICK = new RegExp(`^${NOISE}[✅🟢]`, 'u'); // a bare tick, no verdict word
// Deliberately NOT done-markers: "LIVE" and "COMPLETE". Both lead rows that are
// still open — an epic reading "core LIVE" with unbuilt slices below it, and
// "AUDIT COMPLETE" on a row whose tail is unfinished.
const PARKED_LEAD = new RegExp(`^${NOISE}(?:[⏸📝]️?${NOISE})?(PARKED|DORMANT|RECORDED, NOT ACTIONABLE)`, 'u');

const OWNER_HINTS = {
  naldo: [
    /NALDO/i, /Naldo's (call|area|item|lane)/i, /needs Naldo/i, /flagged NALDO/i,
    /dashboard/i, /marketing site/i, /Elementor/i, /WordPress/i, /call.?copilot/i,
    /advertising/i, /fleet/i, /Bouncie/i, /geofence/i, /payroll/i, /crew_members/i,
    /shifts?\b/i, /P4P/i, /calls.?merge/i,
  ],
  jason: [
    /JASON/i, /Jason ruled/i, /Jason's call/i,
    /portal/i, /quote builder/i, /pricing/i, /design editor/i, /editor-core/i,
    /inbox/i, /training/i, /migrated/i, /home\.?works/i, /installment/i,
  ],
};

// ── parsing ───────────────────────────────────────────────────────────────
// A row's number cell may or may not be bold, and may carry a letter suffix
// (189b). A pattern requiring bold silently misses rows — that mistake has
// already been made once in this repo and reported as fact.
const ROW_RE = /^\|\s*\*{0,2}(\d+[a-z]?)\*{0,2}\s*\|/;
const HEADING_RE = /^(#{2,4})\s+(.*)$/;

function parse(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const rows = [];
  let section = '(no section)';
  let counter = null;

  for (const [i, line] of lines.entries()) {
    const h = line.match(HEADING_RE);
    if (h) { section = h[2].trim(); continue; }

    if (counter === null) {
      const c = line.match(/Next free task #:\s*(\d+)/);
      if (c) counter = Number(c[1]);
    }

    const m = line.match(ROW_RE);
    if (!m) continue;

    // Cell counts are NOT uniform (four rows carry 4, 6 or 7 cells because
    // their prose contains a literal pipe). Index defensively and keep the
    // whole line for status scanning, so an odd row is never silently skipped.
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    // The nominal header is `# | Task | Size | Notes | Old #`, but the LAST
    // cell is where recent rows actually park their verdict ("✅ SHIPPED S57 —
    // PR #1113"); older rows leave it "—" and declare state at the head of the
    // Task or Notes cell instead. So keep all three separately.
    rows.push({
      num: m[1],
      section,
      task: cells[1] ?? '',
      size: cells.length >= 5 ? (cells[2] ?? '') : '',
      notes: cells[3] ?? '',
      verdict: cells.length > 4 ? (cells[cells.length - 1] ?? '') : '',
      raw: line,
      lineNo: i + 1,
      bytes: line.length,
    });
  }
  return { rows, counter };
}

// ── classification ────────────────────────────────────────────────────────
function classify(row) {
  // A row whose whole Task cell is struck through has been retired in place.
  const struck = /^\|\s*\*{0,2}\d+[a-z]?\*{0,2}\s*\|\s*(\*\*)?~~/.test(row.raw);

  // Parked outranks everything: row 451's verdict opens "⏸️ OPEN, genuinely
  // dormant" in a cell that also names two merged PRs.
  if (PARKED_LEAD.test(row.verdict) || PARKED_LEAD.test(row.notes)) {
    return { status: 'parked', confidence: 'high' };
  }
  // A finished WORD ("SHIPPED", "CLOSED", "RESOLVED"…) at the head of any cell
  // is the row declaring itself finished, wherever it chose to say it: newer
  // rows use the verdict cell, older ones open the Task cell with "[✅ SHIPPED
  // S69 — PR #1045 merged". A struck-through row counts too.
  if (struck || DONE_LEAD.test(row.verdict) || DONE_LEAD.test(row.notes) || DONE_LEAD.test(row.task)) {
    return { status: 'done', confidence: 'high' };
  }

  // A BARE tick with no verdict word is the ambiguous case, and the file has
  // earned that caution: a careful human read and this parser disagreed on 18
  // of 123 rows, in both directions. "✅ core + /inbox LIVE" heads an epic with
  // unbuilt slices below it — finished-looking, not finished. Report it as
  // 'unclear' so a person decides; `lint` never fails on these, or it would
  // nag forever about rows nothing can mechanically resolve.
  if (DONE_TICK.test(row.verdict) || DONE_TICK.test(row.notes) || DONE_TICK.test(row.task)) {
    return { status: 'unclear', confidence: 'low' };
  }

  return { status: 'open', confidence: 'high' };
}

function guessOwner(row) {
  const score = (pats) => pats.reduce((n, p) => n + (p.test(row.raw) ? 1 : 0), 0);
  const n = score(OWNER_HINTS.naldo);
  const j = score(OWNER_HINTS.jason);
  if (/⏸️ Pending \/ needs Naldo/i.test(row.section)) return 'naldo';
  if (n === 0 && j === 0) return 'unclear';
  if (n === j) return 'unclear';
  return n > j ? 'naldo' : 'jason';
}

// ── output ────────────────────────────────────────────────────────────────
const strip = (s) =>
  s.replace(/~~/g, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function summarize(row, width) {
  const t = strip(row.task);
  return t.length > width ? `${t.slice(0, width - 1)}…` : t;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'open';
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const file = flag('file', DEFAULT_FILE);
  const width = Number(flag('width', 96));
  const ownerFilter = flag('owner', null);
  const asJson = argv.includes('--json');

  const { rows, counter } = parse(file);
  const enriched = rows.map((r) => ({ ...r, ...classify(r), owner: guessOwner(r) }));

  const pick = (status) =>
    enriched
      .filter((r) => r.status === status)
      .filter((r) => !ownerFilter || r.owner === ownerFilter.toLowerCase());

  if (cmd === 'stats') {
    const open = pick('open');
    const done = pick('done');
    const unclear = pick('unclear');
    const parked = pick('parked');
    const by = (o) => enriched.filter((r) => r.status === 'open' && r.owner === o).length;
    console.log(`file            ${file}`);
    console.log(`next free #     ${counter ?? '(not found)'}`);
    console.log(`rows in ACTIVE  ${enriched.length}`);
    console.log(`  open          ${open.length}  (jason ${by('jason')} · naldo ${by('naldo')} · unclear ${by('unclear')})`);
    console.log(`  read as done  ${done.length}  <- these should be in task_ledger_archive.md`);
    console.log(`  parked        ${parked.length}  (deliberately dormant, stay put)`);
    console.log(`  UNCLEAR       ${unclear.length}  <- looks finished but the row does not say so plainly; a human decides`);
    console.log('\nfattest lines (chars):');
    for (const r of [...enriched].sort((a, b) => b.bytes - a.bytes).slice(0, 5)) {
      console.log(`  line ${String(r.lineNo).padStart(4)}  row ${String(r.num).padEnd(5)} ${String(r.bytes).padStart(6)}`);
    }
    return;
  }

  if (cmd === 'row') {
    const want = argv[argv.indexOf('row') + 1];
    const hit = enriched.find((r) => r.num === want);
    if (!hit) { console.error(`no row ${want} in the ACTIVE tables (try task_ledger_archive.md)`); process.exit(1); }
    if (asJson) { console.log(JSON.stringify(hit, null, 2)); return; }
    console.log(`row ${hit.num}  [${hit.status}/${hit.confidence}]  owner=${hit.owner}  line ${hit.lineNo}`);
    console.log(`section: ${hit.section}\n`);
    console.log(`TASK:  ${strip(hit.task)}\n`);
    console.log(`NOTES: ${strip(hit.notes)}`);
    return;
  }

  if (cmd === 'lint') {
    const stale = pick('done');
    if (stale.length === 0) { console.log('ledger lint: clean — no finished rows in the ACTIVE tables.'); return; }
    console.error(`ledger lint: ${stale.length} finished row(s) still in the ACTIVE tables:\n`);
    for (const r of stale) {
      console.error(`  row ${String(r.num).padEnd(5)} line ${String(r.lineNo).padStart(4)}  ${summarize(r, 70)}`);
    }
    console.error('\nMove them to docs/context/task_ledger_archive.md.');
    process.exit(1);
  }

  if (cmd === 'prs') {
    // Row 355 shipped in PR #1017 and its text still reads as awaiting a
    // merge-go; a human read found three more of the same shape (#680, #543,
    // #482). The row never has to admit anything for this check to work — the
    // PR's own state is the evidence. Only flags a reference the row itself
    // frames as still-pending, so a row that merely cites the PR that CAUSED
    // it is left alone.
    const PENDING_NEAR = /\b(OPEN|pending|awaits?|awaiting|merge-go|unmerged|not yet merged)\b/i;
    const candidates = new Map(); // pr number -> [row nums]
    for (const r of enriched) {
      if (r.status === 'done' || r.status === 'parked') continue;
      // This file writes "#221" for a PR AND for a ledger row — row 231's
      // "the #221 lockdown" means ROW 221. A bare "#N" is therefore useless
      // here; require the reference to say PR explicitly, or this reports row
      // numbers as merged pull requests.
      for (const m of r.raw.matchAll(/\bPRs?\s+#(\d{2,4})\b/g)) {
        const around = r.raw.slice(Math.max(0, m.index - 70), m.index + 90);
        if (!PENDING_NEAR.test(around)) continue;
        if (!candidates.has(m[1])) candidates.set(m[1], []);
        if (!candidates.get(m[1]).includes(r.num)) candidates.get(m[1]).push(r.num);
      }
    }
    if (candidates.size === 0) { console.log('no rows frame a PR reference as still pending.'); return; }
    console.log(`checking ${candidates.size} PR reference(s) framed as pending…\n`);
    const { execFileSync } = await import('node:child_process');
    let stale = 0;
    for (const [pr, rows] of [...candidates].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      let state;
      try {
        state = execFileSync('gh', ['pr', 'view', pr, '--json', 'state', '-q', '.state'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        // A FAILED lookup is not good news — say so rather than counting it clean.
        console.log(`  #${pr.padEnd(5)} LOOKUP FAILED (not a PR, or gh unavailable) — rows ${rows.join(', ')}`);
        continue;
      }
      if (state === 'MERGED' || state === 'CLOSED') {
        stale++;
        console.log(`  #${pr.padEnd(5)} ${state}  <- rows ${rows.join(', ')} still describe it as pending`);
      }
    }
    console.log(`\n${stale} stale PR reference(s).`);
    return;
  }

  const STATUSES = ['open', 'done', 'parked', 'unclear'];
  if (!STATUSES.includes(cmd)) {
    console.error(`unknown command '${cmd}'. Try: ${STATUSES.join(' | ')} | row <n> | stats | lint`);
    process.exit(2);
  }
  const list = pick(cmd);
  if (asJson) { console.log(JSON.stringify(list, null, 2)); return; }

  let section = null;
  for (const r of list) {
    if (r.section !== section) { section = r.section; console.log(`\n## ${section}`); }
    const conf = r.confidence === 'low' ? ' ?' : '  ';
    console.log(`${String(r.num).padStart(4)} ${r.owner.padEnd(7)} ${(r.size || '-').padEnd(4)}${conf} ${summarize(r, width)}`);
  }
  console.log(`\n${list.length} row(s). '?' = low confidence, eyeball it. Next free #: ${counter ?? '?'}`);
}

await main();
