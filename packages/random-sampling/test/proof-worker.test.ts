/**
 * Worker-thread proof builder smoke test.
 *
 * Spawns the actual `worker_threads.Worker` against the compiled
 * `dist/proof-worker-entry.js` and verifies a round-trip build matches
 * the in-process result. The dist artifact must exist (test depends on
 * `pnpm build` having run first; CI runs `pnpm -r build` before tests).
 *
 * Because tsc compiles `import.meta.url` to ESM, both the host and
 * the worker must be loaded from `dist/`. We pass an explicit
 * `entryPath` so the test does not rely on the package layout.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  V10MerkleTree,
  hashTripleV10,
  buildV10ProofMaterial,
} from '@origintrail-official/dkg-core';
import { WorkerThreadProofBuilder } from '../src/proof-worker.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../dist/proof-worker-entry.js');

describe.skipIf(!existsSync(ENTRY))('WorkerThreadProofBuilder (requires dist build)', () => {
  let builder: WorkerThreadProofBuilder;

  beforeAll(() => {
    builder = new WorkerThreadProofBuilder({ entryPath: ENTRY });
  });

  it('builds proof material that matches the in-process result', async () => {
    const triples = [
      { subject: 'urn:e:1', predicate: 'urn:p', object: '"a"' },
      { subject: 'urn:e:2', predicate: 'urn:p', object: '"b"' },
      { subject: 'urn:e:3', predicate: 'urn:p', object: '"c"' },
      { subject: 'urn:e:4', predicate: 'urn:p', object: '"d"' },
    ];
    const leaves = triples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
    const tree = new V10MerkleTree(leaves);
    const expected = { merkleRoot: tree.root, merkleLeafCount: tree.leafCount };

    for (let chunkId = 0; chunkId < tree.leafCount; chunkId++) {
      const inProcess = buildV10ProofMaterial(leaves, chunkId, expected);
      const fromWorker = await builder.build({ leaves, chunkId, expected });
      expect(fromWorker.leaf).toEqual(inProcess.leaf);
      expect(fromWorker.proof.length).toEqual(inProcess.proof.length);
      for (let i = 0; i < fromWorker.proof.length; i++) {
        expect(fromWorker.proof[i]).toEqual(inProcess.proof[i]);
      }
    }

    await builder.close();
  });

  it('rejects with a named error class on root mismatch', async () => {
    const leaves = [hashTripleV10('urn:e:1', 'urn:p', '"a"')];
    const wrongRoot = new Uint8Array(32).fill(0xff);

    const local = new WorkerThreadProofBuilder({ entryPath: ENTRY });
    await expect(
      local.build({ leaves, chunkId: 0, expected: { merkleRoot: wrongRoot, merkleLeafCount: 1 } }),
    ).rejects.toMatchObject({ name: 'V10ProofRootMismatchError' });
    await local.close();
  });
});
