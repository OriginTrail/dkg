import { beforeEach, expect, it, vi } from 'vitest';
import { open, statfs } from 'node:fs/promises';
import { PUBLIC_CHECKPOINT_KIND as K, exchangePublicCheckpoint, type BulkGraphFrame } from '@origintrail-official/dkg-core';
import { receiveSnapshotCheckpointChunk, type SnapshotCheckpointBudget } from '../src/snapshot-checkpoint-receive.js';
import { preparePublicSnapshotCheckpoint } from '../src/public-snapshot-checkpoint.js';
import { verifySnapshotCheckpoint } from '../src/snapshot-checkpoint-verify.js';
import { bulkChunkHash, bulkJson, type BulkGraphRequest } from '../src/sync/bulk-graph-contract.js';
import { checkpointSha256 } from '../src/snapshot-checkpoint-files.js';
import { sealSnapshotOf, makeSnapshotAssets } from './helpers/public-snapshot-assets.js';

vi.mock('node:fs/promises', () => ({ open: vi.fn(), statfs: vi.fn(), readFile: vi.fn(async () => Buffer.from('trust')) }));
vi.mock('../src/snapshot-checkpoint-files.js', async original => ({
  ...await original<typeof import('../src/snapshot-checkpoint-files.js')>(), reserveSnapshotCheckpoint: async () => '/fixture',
}));
vi.mock('../src/snapshot-checkpoint-verify.js', () => ({ verifySnapshotCheckpoint: vi.fn(async () => []) }));
vi.mock('../src/snapshot-checkpoint-profile.js', () => ({ CHECKPOINT_PROFILE: {
  maxAssets: 100_000, maxEncodedBytes: 10, maxPlainBytes: 10, diskReserveBytes: 3,
} }));
vi.mock('@origintrail-official/dkg-core', async original => ({
  ...await original<typeof import('@origintrail-official/dkg-core')>(), BULK_GRAPH_MAX_ASSETS: 1, exchangePublicCheckpoint: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(statfs).mockResolvedValue({ bavail: 100, bsize: 1 } as never);
  vi.mocked(open).mockImplementation(async () => ({ writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() }) as never);
});
function transport(request: BulkGraphRequest, encoded: number, plain = encoded) {
  const body = Buffer.alloc(encoded, 1), header = bulkJson({ encodedBytes: encoded, plainBytes: plain,
    offset: 0, digest: checkpointSha256(body), metadata: Buffer.from('meta').toString('base64') });
  const digest = bulkChunkHash(request).update(header).update(body).digest('hex');
  const frames: BulkGraphFrame[] = [
    { kind: K.META, index: 0, sequence: 0, payload: header },
    { kind: K.DATA, index: 0, sequence: 0, payload: body },
    { kind: K.ASSET_END, index: 0, sequence: 1, payload: new Uint8Array() },
    { kind: K.CHUNK_END, index: 1, sequence: encoded, payload: bulkJson({ digest, assets: 1, encodedBytes: encoded }) },
  ];
  let index = 0;
  return { signal: new AbortController().signal, send: vi.fn<(frame: BulkGraphFrame) => Promise<void>>().mockResolvedValue(undefined), next: async () => frames[index++]! };
}
const request: BulkGraphRequest = { version: 1, contextGraphId: 'graph', snapshotDigest: 'a'.repeat(64),
  assetUals: ['did:dkg:base:8453/0x0000000000000000000000000000000000000001/1'] };
const budget = (): SnapshotCheckpointBudget => ({ encodedBytes: 0, plainBytes: 0, maxEncodedBytes: 10, maxPlainBytes: 10, minFreeBytes: 3 });
const receive = (session: ReturnType<typeof transport>, value: SnapshotCheckpointBudget, startIndex = 0) =>
  receiveSnapshotCheckpointChunk(session, request, { directory: '/fixture', startIndex, budget: value, assertCurrent() {} });

it.each(['encoded', 'expanded'] as const)('keeps cumulative %s allowances across chunks and refuses before writes or acknowledgement', async kind => {
  const value = budget(), encoded = kind === 'encoded' ? 6 : 2, plain = kind === 'encoded' ? 2 : 6;
  await receive(transport(request, encoded, plain), value);
  const opens = vi.mocked(open).mock.calls.length, second = transport(request, encoded, plain);
  await expect(receive(second, value, 1)).rejects.toThrow('allowance');
  expect(open).toHaveBeenCalledTimes(opens); expect(second.send).not.toHaveBeenCalled();
  expect(value).toMatchObject({ encodedBytes: encoded, plainBytes: plain });
});
it('accepts exact cumulative byte and disk boundaries, then refuses exhausted allowance', async () => {
  const value = budget(); vi.mocked(statfs).mockResolvedValue({ bavail: 13, bsize: 1 } as never);
  await receive(transport(request, 5), value); const second = transport(request, 5);
  await receive(second, value, 1); expect(value).toMatchObject({ encodedBytes: 10, plainBytes: 10 });
  expect(second.send.mock.calls.map(([frame]) => frame.kind)).toEqual([K.CREDIT, K.PERSISTED]);
  const third = transport(request, 1), opens = vi.mocked(open).mock.calls.length;
  await expect(receive(third, value, 2)).rejects.toThrow('allowance');
  expect(open).toHaveBeenCalledTimes(opens); expect(third.send).not.toHaveBeenCalled();
});
it.each([0, 1])('refuses insufficient disk after %s chunks before further writes, accounting or acknowledgement', async previous => {
  const value = budget();
  if (previous) await receive(transport(request, 5), value);
  const opens = vi.mocked(open).mock.calls.length;
  vi.mocked(statfs).mockResolvedValue({ bavail: 12, bsize: 1 } as never);
  const session = transport(request, 5);
  await expect(receive(session, value, previous)).rejects.toThrow('disk reserve');
  expect(open).toHaveBeenCalledTimes(opens); expect(session.send).not.toHaveBeenCalled();
  expect(value).toMatchObject({ encodedBytes: 5 * previous, plainBytes: 5 * previous });
});
it.each(['encoded', 'expanded'] as const)('preparation carries %s accounting between transport exchanges', async kind => {
  const sessions: ReturnType<typeof transport>[] = [];
  vi.mocked(exchangePublicCheckpoint).mockImplementation(async (_router, _peer, bytes, _options, consume) => {
    const session = transport(JSON.parse(Buffer.from(bytes).toString()), kind === 'encoded' ? 6 : 2, kind === 'encoded' ? 2 : 6);
    sessions.push(session); return consume(session as never);
  });
  const snapshot = sealSnapshotOf('graph', makeSnapshotAssets('graph', 2));
  const initial = { mode: 'rpc-only' as const, sourceCore: null, snapshot };
  await expect(preparePublicSnapshotCheckpoint({ router: { probeProtocol: async () => 'supported' } as never,
    ensurePeerConnected: async () => {} }, { initial, readFresh: async () => initial,
    peerBatches: async function* () { yield ['core']; }, dataDir: '/fixture', signal: new AbortController().signal,
    deadline: Date.now() + 30_000, assertCurrent() {} })).rejects.toThrow('allowance');
  expect(sessions).toHaveLength(2); expect(sessions[0]!.send).toHaveBeenCalledTimes(2);
  expect(sessions[1]!.send).not.toHaveBeenCalled();
  expect(verifySnapshotCheckpoint).toHaveBeenCalledOnce();
  expect(vi.mocked(verifySnapshotCheckpoint).mock.calls[0]![0].signal.aborted).toBe(true);
  expect(vi.mocked(open).mock.calls.filter(([path]) => String(path).endsWith('.body'))).toHaveLength(1);
});
