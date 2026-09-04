// Structural guard for the /qr namespace.
//
// operatorGate opens /qr as a PREFIX, so anything ever added under src/app/qr
// is public to the whole internet with no session and no further check. Today
// that namespace holds exactly one thing: a redirector that reads no database,
// touches no customer record and only ever 302s to our own marketing site.
// This test fails the moment a second route appears there, so that decision is
// made deliberately rather than inherited by accident. Mirrors the same guard
// already used for /api/crew (crewNamespace.test.ts).

import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(process.cwd(), 'src', 'app', 'qr');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts' || entry === 'route.tsx' || entry.startsWith('page.')) {
      out.push(full);
    }
  }
  return out;
}

describe('the public /qr namespace holds only the redirector', () => {
  // sep-split rather than a regex, so the assertion reads the same on Windows
  // and on the Linux box that runs CI.
  const files = routeFiles(ROOT).map((f) => relative(process.cwd(), f).split(sep).join('/'));

  it('finds something at all, so an empty scan can never pass silently', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('holds exactly the one redirector route and nothing else', () => {
    expect(files).toEqual(['src/app/qr/[[...slug]]/route.ts']);
  });
});
