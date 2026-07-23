// Tests for the text-ops bot's role tiers. The security-relevant property here
// is that every unknown or unconfigured path lands on the LEAST privilege, and
// that roles key off the SENDER (so a staff group chat doesn't hand a crew
// member an admin's powers).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  roleForUser,
  hasRole,
  mayRunTool,
  isKnownTool,
  TOOL_MIN_ROLE,
} from './botRoles';

const ENV_KEYS = ['TELEGRAM_ADMIN_USERS', 'TELEGRAM_STAFF_USERS', 'TELEGRAM_CREW_USERS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('roleForUser', () => {
  it('reads each tier from its own env list', () => {
    process.env.TELEGRAM_ADMIN_USERS = '111';
    process.env.TELEGRAM_STAFF_USERS = '222';
    process.env.TELEGRAM_CREW_USERS = '333';
    expect(roleForUser('111')).toBe('admin');
    expect(roleForUser('222')).toBe('staff');
    expect(roleForUser('333')).toBe('crew');
  });

  it('accepts a numeric id (Telegram sends numbers, env holds strings)', () => {
    process.env.TELEGRAM_ADMIN_USERS = '111';
    expect(roleForUser(111)).toBe('admin');
  });

  it('tolerates spaces and empty entries in the list', () => {
    process.env.TELEGRAM_STAFF_USERS = ' 222 , ,333 ';
    expect(roleForUser('222')).toBe('staff');
    expect(roleForUser('333')).toBe('staff');
  });

  it('takes the HIGHEST tier when an id is listed twice', () => {
    process.env.TELEGRAM_ADMIN_USERS = '111';
    process.env.TELEGRAM_CREW_USERS = '111';
    expect(roleForUser('111')).toBe('admin');
  });

  it('returns null for an unlisted, empty, or missing id', () => {
    process.env.TELEGRAM_ADMIN_USERS = '111';
    expect(roleForUser('999')).toBeNull();
    expect(roleForUser('')).toBeNull();
    expect(roleForUser(null)).toBeNull();
    expect(roleForUser(undefined)).toBeNull();
  });

  it('returns null for everyone when nothing is configured', () => {
    expect(roleForUser('111')).toBeNull();
  });
});


describe('higherRole (how the DB roster and env floor combine)', () => {
  it('returns the higher-ranked of the two', async () => {
    const { higherRole } = await import('./botRoles');
    expect(higherRole('crew', 'admin')).toBe('admin');
    expect(higherRole('admin', 'crew')).toBe('admin');
    expect(higherRole('staff', 'crew')).toBe('staff');
  });

  it('returns whichever is present when the other is null', async () => {
    const { higherRole } = await import('./botRoles');
    expect(higherRole('staff', null)).toBe('staff');
    expect(higherRole(null, 'admin')).toBe('admin');
  });

  it('returns null only when both are null', async () => {
    const { higherRole } = await import('./botRoles');
    expect(higherRole(null, null)).toBeNull();
  });
});

describe('hasRole', () => {
  it('lets a higher tier satisfy a lower minimum', () => {
    expect(hasRole('admin', 'crew')).toBe(true);
    expect(hasRole('staff', 'crew')).toBe(true);
    expect(hasRole('crew', 'crew')).toBe(true);
  });

  it('refuses a lower tier against a higher minimum', () => {
    expect(hasRole('crew', 'staff')).toBe(false);
    expect(hasRole('crew', 'admin')).toBe(false);
    expect(hasRole('staff', 'admin')).toBe(false);
  });
});

describe('mayRunTool', () => {
  it('lets crew run the reads and the field capture tools', () => {
    for (const tool of ['status', 'schedule', 'stock', 'low', 'jobs', 'help', 'completeInstall', 'captureLead']) {
      expect(mayRunTool('crew', tool)).toBe(true);
    }
  });

  it('keeps stock-moving keyword writes above crew', () => {
    expect(mayRunTool('crew', 'prep')).toBe(false);
    expect(mayRunTool('crew', 'set')).toBe(false);
    expect(mayRunTool('staff', 'prep')).toBe(true);
    expect(mayRunTool('staff', 'set')).toBe(true);
  });

  it('refuses an unknown tool for every role, including admin', () => {
    expect(isKnownTool('deleteEverything')).toBe(false);
    expect(mayRunTool('admin', 'deleteEverything')).toBe(false);
    expect(mayRunTool('crew', '')).toBe(false);
  });

  it('declares a minimum role for every tool it knows', () => {
    for (const [tool, min] of Object.entries(TOOL_MIN_ROLE)) {
      expect(['crew', 'staff', 'admin']).toContain(min);
      expect(isKnownTool(tool)).toBe(true);
    }
  });
});
