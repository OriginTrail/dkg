import assert from 'node:assert/strict';
import { defineSuite } from 'esbench';
import { skolemizeByEntity } from '../packages/publisher/src/auto-partition.ts';
import { canonicalPublishPayload } from '../packages/publisher/src/canonical-publish-payload.ts';
import type { Quad } from '../packages/storage/src/triple-store.ts';

// Uses source imports so the repository's standard esbench discovery works on
// a clean checkout. Compare revisions through ESBENCH_RESULT / ESBENCH_DIFF.
export default defineSuite({
  params: { roots: [100, 1_000, 5_000] },
  timing: { iterations: 5, samples: 5, warmup: 2, unrollFactor: 1, evaluateOverhead: false },
  setup(scene) {
    const roots = scene.params.roots as number;
    const quads: Quad[] = Array.from({ length: roots }, (_, i) => Array.from({ length: 5 }, (_, j) => ({
      subject: `urn:root:${i}`, predicate: 'urn:p', object: `"${j}"`, graph: 'urn:g',
    }))).flat();
    const privateQuads: Quad[] = Array.from({ length: roots }, (_, i) => [
      { subject: `urn:root:${i}`, predicate: 'urn:private', object: `"direct-${i}"`, graph: 'urn:g' },
      { subject: `urn:root:${i}/.well-known/genid/private`, predicate: 'urn:private', object: `"nested-${i}"`, graph: 'urn:g' },
    ]).flat();
    assert.equal(skolemizeByEntity(quads).size, roots);
    const canonical = canonicalPublishPayload(quads, privateQuads);
    assert.equal(canonical.manifestEntries.length, roots);
    assert.ok(canonical.manifestEntries.every(entry => entry.privateTripleCount === 2));
    scene.bench('group entity quads', () => skolemizeByEntity(quads));
    scene.bench('build canonical payload with private descendants', () =>
      canonicalPublishPayload(quads, privateQuads));
  },
});
