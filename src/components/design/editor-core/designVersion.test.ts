import { describe, expect, it } from 'vitest';
import { shouldAdoptPrunedVersion } from './designVersion';

// Row 371 (final verify HIGH). The rule this pins is the difference between
// "the editor stops nagging about a save conflict it caused itself" and "one
// operator silently overwrites another's work".
describe('shouldAdoptPrunedVersion', () => {
  it('adopts a version exactly one ahead — the prune wrote on top of what we hold', () => {
    expect(shouldAdoptPrunedVersion(7, 8)).toBe(true);
    expect(shouldAdoptPrunedVersion(0, 1)).toBe(true);
  });

  // The whole point. Operator B saved between this client's last read and the
  // prune, so the prune's version carries B's edit. Adopting it would let this
  // client's next save pass the CAS and wipe B's work with no banner to either
  // of them. Refusing costs a false "Save blocked — reload", which is exactly
  // what happened before row 371 and loses nothing.
  it('refuses a version that jumped, because the gap is somebody else s edit', () => {
    expect(shouldAdoptPrunedVersion(7, 9)).toBe(false);
    expect(shouldAdoptPrunedVersion(7, 12)).toBe(false);
  });

  it('refuses a version that did not move, or moved backwards', () => {
    expect(shouldAdoptPrunedVersion(7, 7)).toBe(false);
    expect(shouldAdoptPrunedVersion(7, 6)).toBe(false);
  });

  // A delete that pruned nothing reports null; an unknown local version means
  // there is nothing to compare against. Both refuse rather than guess.
  it('refuses when either side is missing or not a real number', () => {
    for (const bad of [null, undefined, NaN, Infinity, '8' as unknown as number]) {
      expect(shouldAdoptPrunedVersion(7, bad as number)).toBe(false);
      expect(shouldAdoptPrunedVersion(bad as number, 8)).toBe(false);
    }
  });
});
