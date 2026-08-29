import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTERNAL_LITERAL_REF_DATATYPE,
  OxigraphStore,
  SharedMemoryLiteralBlobStore,
} from '../src/index.js';
import {
  AUTHOR,
  P_HEAD,
  P_VALUE,
  PROJECTION_GRAPH,
  authorCommitInput,
  objectFor,
  overrideStore,
  quad,
  seedOldState,
} from './rfc64-author-commit-cas-harness.js';

describe('RFC-64 author commit external literal mapping', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('translates oversized scalar guards and next values through the blob representation', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-scalar-blobs-'));
    tempDirs.push(blobDir);
    const raw = new OxigraphStore();
    const store = new SharedMemoryLiteralBlobStore(raw, { blobDir, thresholdBytes: 20 });
    await seedOldState(store);
    const scalarGraph = 'did:dkg:context-graph:rfc64/control/_shared_memory';
    const oldValue = `"${'old-guard-value'.repeat(10)}"`;
    const nextValue = `"${'next-guard-value'.repeat(10)}"`;
    await store.insert([quad(AUTHOR, P_HEAD, oldValue, scalarGraph)]);
    const input = authorCommitInput({
      currentHead: {
        graphUri: scalarGraph,
        subject: AUTHOR,
        predicate: P_HEAD,
        expectedObject: oldValue,
        quads: [quad(AUTHOR, P_HEAD, nextValue, scalarGraph)],
      },
    });
    await expect(store.rfc64AuthorCommitCasV1(input)).resolves.toBe('committed');
    expect(await objectFor(store, scalarGraph, AUTHOR, P_HEAD)).toBe(nextValue);

    const nextHash = createHash('sha256').update(nextValue, 'utf8').digest('hex');
    const nextRef = `"sha256:${nextHash}"^^<${EXTERNAL_LITERAL_REF_DATATYPE}>`;
    expect(await objectFor(raw, scalarGraph, AUTHOR, P_HEAD)).toBe(nextRef);
    await expect(readFile(join(blobDir, nextHash), 'utf8')).resolves.toBe(nextValue);
  });

  it('retains newly-created literal blobs after a clean conflict for reference-aware GC', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-conflict-blobs-'));
    tempDirs.push(blobDir);
    const base = new OxigraphStore();
    const inner = overrideStore(base, {
      rfc64AuthorCommitCasV1: async () => 'conflict',
    });
    const store = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 20 });
    const largeLiteral = `"${'conflicting-value'.repeat(20)}"`;

    await expect(store.rfc64AuthorCommitCasV1(authorCommitInput({
      sharedProjectionQuads: [
        quad('urn:test:rfc64:conflict', P_VALUE, largeLiteral, PROJECTION_GRAPH),
      ],
    }))).resolves.toBe('conflict');
    expect(await readdir(blobDir)).toHaveLength(1);
  });

  it('preserves pre-existing and concurrently committed shared blob hashes', async () => {
    const preexistingDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-shared-blob-'));
    tempDirs.push(preexistingDir);
    const largeLiteral = `"${'shared-value'.repeat(30)}"`;
    const preexistingInner = overrideStore(new OxigraphStore(), {
      rfc64AuthorCommitCasV1: async () => 'conflict',
    });
    const preexisting = new SharedMemoryLiteralBlobStore(
      preexistingInner,
      { blobDir: preexistingDir, thresholdBytes: 20 },
    );
    await preexisting.insert([
      quad('urn:test:rfc64:existing', P_VALUE, largeLiteral, PROJECTION_GRAPH),
    ]);
    const existingFiles = await readdir(preexistingDir);
    await expect(preexisting.rfc64AuthorCommitCasV1(authorCommitInput({
      sharedProjectionQuads: [
        quad('urn:test:rfc64:conflict', P_VALUE, largeLiteral, PROJECTION_GRAPH),
      ],
    }))).resolves.toBe('conflict');
    expect(await readdir(preexistingDir)).toEqual(existingFiles);

    const concurrentDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-concurrent-blob-'));
    tempDirs.push(concurrentDir);
    let entered = 0;
    let releaseBoth!: () => void;
    const bothEntered = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const concurrentInner = overrideStore(new OxigraphStore(), {
      rfc64AuthorCommitCasV1: async () => {
        const writer = entered++;
        if (entered === 2) releaseBoth();
        await bothEntered;
        return writer === 0 ? 'committed' : 'conflict';
      },
    });
    const concurrent = new SharedMemoryLiteralBlobStore(
      concurrentInner,
      { blobDir: concurrentDir, thresholdBytes: 20 },
    );
    const manifest = authorCommitInput({
      sharedProjectionQuads: [
        quad('urn:test:rfc64:concurrent', P_VALUE, largeLiteral, PROJECTION_GRAPH),
      ],
    });
    await expect(Promise.all([
      concurrent.rfc64AuthorCommitCasV1(manifest),
      concurrent.rfc64AuthorCommitCasV1(manifest),
    ])).resolves.toEqual(['committed', 'conflict']);
    expect(await readdir(concurrentDir)).toHaveLength(1);
  });
});
