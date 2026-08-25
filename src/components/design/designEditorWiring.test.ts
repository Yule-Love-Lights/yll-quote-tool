import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Row 371 (delta-verify HIGH): the post-delete version adoption runs through
// three hops — the DELETE route's response, DesignEditor.deletePhoto, a ref
// wrapper, and finally editor.ts's removePhotoItems. The ref wrapper silently
// dropped the version argument, so the whole fix was inert, and NOTHING could
// catch it: `tsc` accepts a narrower function where a wider one is expected,
// and editor.ts cannot be imported in this environment at all (it pulls in
// Konva, whose Node entrypoint needs the optional `canvas` package — the same
// constraint that put drawContext.ts in its own module).
//
// So this is a source-level assertion, matching the precedent in
// StaffNotesPanel.test.tsx, which pins its own render sites the same way. It
// is deliberately narrow: it checks that the version actually crosses each
// hop, not how the surrounding code is written.
const root = resolve(__dirname, '../../..');
const designEditor = readFileSync(resolve(root, 'src/components/design/DesignEditor.tsx'), 'utf8');
const editorCore = readFileSync(resolve(root, 'src/components/design/editor-core/editor.ts'), 'utf8');

describe('photo-delete version adoption is actually wired (row 371)', () => {
  it('forwards the version through the ref wrapper, not just the photo id', () => {
    expect(designEditor).toContain('handle!.removePhotoItems!(photoId, serverVersion)');
  });

  it('reads the version off the DELETE response and passes it at the call site', () => {
    expect(designEditor).toContain(
      "removePhotoItemsRef.current?.(id, typeof data.version === 'number' ? data.version : null)",
    );
  });

  it('adopts it in the editor BEFORE the no-items early return, GATED by the guard', () => {
    const fn = editorCore.slice(editorCore.indexOf('function removePhotoItems('));
    const earlyReturn = fn.indexOf('return; // nothing on this photo at all');
    expect(earlyReturn).toBeGreaterThan(-1);

    // Verify-round MED: an earlier version of this test only checked that the
    // guard was CALLED somewhere before the early return, which a mutation
    // that calls it and throws the answer away would have passed — silently
    // reopening the lost-update the guard exists to close. So match the whole
    // gated assignment, not two substrings in order.
    const gated =
      /if \(shouldAdoptPrunedVersion\(design\.version, serverVersion\)\) \{\s*design\.version = serverVersion as number;\s*\}/;
    const match = fn.match(gated);
    expect(match).not.toBeNull();
    // A photo with a brightness override and no drawn items still bumps the
    // server's version, and that is exactly the case the early return skips.
    expect(fn.indexOf(match![0])).toBeLessThan(earlyReturn);

    // And the assignment appears nowhere else, ungated.
    expect(fn.split('design.version = serverVersion').length - 1).toBe(1);
  });
});
