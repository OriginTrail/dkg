import assert from 'node:assert/strict';
import { defineSuite } from 'esbench';
import { skolemizeByEntity } from '../packages/publisher/dist/auto-partition.js';

// Build publisher, then use the repository's ESBENCH_RESULT / ESBENCH_DIFF
// reporters on the baseline and changed checkouts: pnpm exec esbench --file entity-grouping
export default defineSuite({
  params: { roots: [100, 1_000, 5_000] },
  timing: { iterations: 5, samples: 5, warmup: 2, unrollFactor: 1, evaluateOverhead: false },
  setup(scene) {
    const roots = scene.params.roots as number;
    const quads = Array.from({ length: roots }, (_, i) => Array.from({ length: 5 }, (_, j) => ({
      subject: `urn:root:${i}`, predicate: 'urn:p', object: `"${j}"`, graph: 'urn:g',
    }))).flat();
    assert.equal(skolemizeByEntity(quads).size, roots);
    scene.bench('group entity quads', () => skolemizeByEntity(quads));
  },
});
