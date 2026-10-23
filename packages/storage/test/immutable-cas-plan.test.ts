import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangelogStore, GraphSetIndexStore, OxigraphStore, SharedMemoryLiteralBlobStore,
  tryRfc64AuthorCommitCasV1, type TripleStore } from '../src/index.js';
import { authorCommitInput, legacyAuthorCommitInput, objectFor, P_VALUE, PROJECTION_GRAPH,
  quad, seedOldState } from './rfc64-author-commit-cas-harness.js';

const counts = vi.hoisted(() => ({ normalize: 0, publicInput: 0 }));
vi.mock('../src/rfc64-author-commit-cas.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/rfc64-author-commit-cas.js')>();
  return { ...actual,
    normalizeRfc64AuthorCommitCasV1: (...args: Parameters<typeof actual.normalizeRfc64AuthorCommitCasV1>) => {
      counts.normalize += 1; return actual.normalizeRfc64AuthorCommitCasV1(...args);
    },
    sourceFromNormalizedRfc64AuthorCommitCasV1: (...args: Parameters<typeof actual.sourceFromNormalizedRfc64AuthorCommitCasV1>) => {
      counts.publicInput += 1; return actual.sourceFromNormalizedRfc64AuthorCommitCasV1(...args);
    },
  };
});
const roots: string[] = [], stores: TripleStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([true, false].flatMap(enabled => [true, false].map(legacy => ({ enabled, legacy }))))
('normalizes one private CAS plan and reconstructs public input only at dispatch (log=$enabled, legacy=$legacy)', async ({ enabled, legacy }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-cas-plan-'))); roots.push(root);
  const raw = new OxigraphStore(), blobs = new SharedMemoryLiteralBlobStore(raw, { blobDir: root, thresholdBytes: 64 });
  const store = new ChangelogStore(new GraphSetIndexStore(blobs), { enabled }); stores.push(store);
  await seedOldState(store);
  const value = JSON.stringify('exact canonical CAS payload '.repeat(16));
  const input = { ...(legacy ? legacyAuthorCommitInput() : authorCommitInput()),
    sharedProjectionQuads: [quad('urn:canonical-plan', P_VALUE, value, PROJECTION_GRAPH)] };
  if ('kaStateDigest' in input) {
    const state = input.kaStateDigest;
    await store.insert([quad(state.subject, state.predicate, state.expectedObject!, state.graphUri)]);
  }
  counts.normalize = 0; counts.publicInput = 0;
  await expect(tryRfc64AuthorCommitCasV1(store, input)).resolves.toBe('committed');
  expect(await objectFor(store, PROJECTION_GRAPH, 'urn:canonical-plan', P_VALUE)).toBe(value);
  expect(counts).toEqual({ normalize: 1, publicInput: 1 });
  counts.normalize = 0; counts.publicInput = 0;
  await expect(tryRfc64AuthorCommitCasV1(store, input)).resolves.toBe('conflict');
  expect(counts).toEqual({ normalize: 1, publicInput: 1 });
});
