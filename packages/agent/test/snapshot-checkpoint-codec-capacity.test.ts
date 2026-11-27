import { beforeEach, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { verifySnapshotCheckpoint } from '../src/snapshot-checkpoint-verify.js';
import type { PublicSnapshotEvidence } from '../src/public-snapshot-evidence.js';
import type { SnapshotCheckpointEntry } from '../src/snapshot-checkpoint-files.js';
import { buildKnowledgeAssetUalFromOnChainIdV1 } from '@origintrail-official/dkg-core';

const state = vi.hoisted(() => ({ closed: [] as ReturnType<typeof vi.fn>[],
  writes: new Map<string, Uint8Array | string>() }));
vi.mock('node:os', () => ({ availableParallelism: () => 8, freemem: () => 8 * 2 ** 30 }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => {}) }));
vi.mock('../src/snapshot-checkpoint-files.js', async original => ({
  ...await original<typeof import('../src/snapshot-checkpoint-files.js')>(),
  readPinnedCheckpointFile: async () => Buffer.from('x'),
  writeCheckpointFile: async (path: string, bytes: Uint8Array | string) => { state.writes.set(path, bytes); },
  syncCheckpointDirectory: async () => {},
}));
vi.mock('../src/sync/wire-compression.js', () => ({
  decodeNegotiatedExactSyncResponse: async (bytes: Uint8Array) => ({ bytes }),
}));
vi.mock('../src/sync-verify-worker.js', () => ({ SyncVerifyWorker: class {
  close = vi.fn(async () => {});
  constructor() { state.closed.push(this.close); }
  async parseAndFilter() {} async processDurableBatch() {}
} }));
vi.mock('../src/sync/requester/asset-payload-verifier.js', () => ({
  createAssetPayloadVerifier: () => async ({ assetUal }: { assetUal: string }) => ({
    ual: assetUal, assertionGraph: 'urn:g', metaGraph: 'urn:meta', merkleRootHex: 'a'.repeat(64),
    assertionVersion: 1n, metadataQuads: [],
    dataQuads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"verified"', graph: 'urn:g' }],
  }),
}));
beforeEach(() => { state.closed.length = 0; state.writes.clear(); });

function fixture() {
  const chainId = 'gnosis:100', assetStorage = `0x${'1'.repeat(40)}`;
  const assets = [1, 2, 3, 4].map(id => ({ id: String(id) }));
  const entries: SnapshotCheckpointEntry[] = assets.map(({ id }, index) => ({
    index, ual: buildKnowledgeAssetUalFromOnChainIdV1(chainId, assetStorage, BigInt(id)),
    encodedBytes: 1, plainBytes: 1, bodySha256: 'a'.repeat(64), metadataSha256: 'b'.repeat(64),
  }));
  const evidence = { mode: 'rpc-only', snapshot: { chainId, assetStorage, contextGraphId: 'urn:cg', assets },
    authenticate: (asset: unknown) => ({ asset }) } as unknown as PublicSnapshotEvidence;
  return { directory: '/checkpoint', entries, evidence, signal: new AbortController().signal, assertCurrent() {} };
}

// Keep the real pool and native gzip: all fixture I/O/verifier promises resolve
// immediately, so lanes reach gzip before any native stream can close. On the
// old four-lane implementation the third reservation exceeds the 96 MiB budget.
it.each([undefined, 4, 3, 2, 1])('verifies all assets without self-exhausting codec capacity (requested workers %s)', async maxWorkers => {
  const f = fixture();
  const result = await verifySnapshotCheckpoint({ ...f, maxWorkers });
  expect(result.map(asset => asset.ual)).toEqual(f.entries.map(entry => entry.ual));
  for (let i = 0; i < 4; i++) {
    const data = state.writes.get(`/checkpoint/load/${String(i).padStart(6, '0')}.verified.nq.gz`);
    expect(gunzipSync(data as Uint8Array).toString()).toBe('<urn:s> <urn:p> "verified" <urn:g> .\n');
  }
  expect(state.closed).toHaveLength(maxWorkers === 1 ? 1 : 2);
  expect(state.closed.every(close => close.mock.calls.length > 0)).toBe(true);
});
it.each([0, 5, 1.5, NaN])('still rejects invalid requested worker count %s', async maxWorkers => {
  await expect(verifySnapshotCheckpoint({ ...fixture(), maxWorkers })).rejects.toThrow('Invalid snapshot verifier count');
  expect(state.closed).toHaveLength(0); expect(state.writes.size).toBe(0);
});
it('does not dispatch codecs or writes for a cancelled checkpoint', async () => {
  const f = fixture(), abort = new AbortController(), reason = new Error('retired'); abort.abort(reason);
  await expect(verifySnapshotCheckpoint({ ...f, signal: abort.signal })).rejects.toBe(reason);
  expect(state.closed).toHaveLength(0); expect(state.writes.size).toBe(0);
});
