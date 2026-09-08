// Build publisher first, then: node --expose-gc bench/workspace-snapshot-validation.mjs
// This measures local validation work, not end-to-end network sync throughput.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  FileWorkspacePublicSnapshotStore,
  workspacePublicQuadsDigest,
} from '../packages/publisher/dist/workspace-snapshot-store.js';

class MeasuredStore extends FileWorkspacePublicSnapshotStore {
  loads = 0;
  rows = 0;
  // Instrument the lease-free read primitive used by both public operations.
  async readSnapshot(source, ref) {
    const quads = await super.readSnapshot(source, ref);
    this.loads++;
    this.rows += quads?.length ?? 0;
    return quads;
  }
}

const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-validation-bench-'));
try {
  const store = new MeasuredStore(directory, undefined, { gc: { enabled: false } });
  const metadata = [];
  for (let snapshot = 0; snapshot < 20; snapshot++) {
    const quads = Array.from({ length: 50_000 }, (_, row) => ({
      subject: `urn:benchmark:${snapshot}:${row.toString().padStart(5, '0')}`,
      predicate: 'urn:benchmark:value',
      object: `"${row}"`,
      graph: '',
    }));
    const digest = workspacePublicQuadsDigest(quads);
    const { ref } = await store.putSnapshot({ digest, quads });
    metadata.push({ ref, digest, count: quads.length });
  }
  async function measure(validate) {
    globalThis.gc?.();
    store.loads = 0;
    store.rows = 0;
    const results = [];
    const passMs = [];
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let pass = 0; pass < 4; pass++) {
      const passStart = performance.now();
      for (const snapshot of metadata) results.push(await validate(snapshot));
      passMs.push(performance.now() - passStart);
    }
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    return { results, fullLoads: store.loads, quadsMaterialized: store.rows, wallMs, cpuMs: (used.user + used.system) / 1000, passMs };
  }
  const baseline = await measure(async ({ ref, digest, count }) => {
    const quads = await store.getSnapshot(ref);
    return quads !== null && quads.length === count && workspacePublicQuadsDigest(quads) === digest;
  });
  const cached = await measure(({ ref, digest, count }) => store.validateSnapshot(ref, digest, count));
  assert.deepEqual(cached.results, baseline.results);
  assert.equal(cached.results.every(Boolean), true);
  assert.equal(baseline.fullLoads, 80);
  assert.equal(baseline.quadsMaterialized, 4_000_000);
  assert.equal(cached.fullLoads, 20);
  assert.equal(cached.quadsMaterialized, 1_000_000);
  const report = ({ results, ...metrics }) => ({ ...metrics, validResults: results.filter(Boolean).length });
  console.log(JSON.stringify({ node: process.version, snapshots: 20, quadsPerSnapshot: 50_000, passes: 4, baseline: report(baseline), cached: report(cached) }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
