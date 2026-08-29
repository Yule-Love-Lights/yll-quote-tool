// Structural guard for the /api/crew namespace.
//
// operatorGate lets the whole namespace past the perimeter (a crew session is a
// cookie the proxy cannot read), so a route added here WITHOUT a guard would be
// public to anyone. This test fails the moment such a route appears.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src', 'app', 'api', 'crew');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(full);
  }
  return out;
}

describe('every /api/crew route guards itself', () => {
  const files = routeFiles(ROOT);

  it('finds the routes at all, so an empty scan can never pass silently', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s goes through withCrewSession', (file) => {
    expect(readFileSync(file, 'utf8')).toContain('withCrewSession');
  });
});
