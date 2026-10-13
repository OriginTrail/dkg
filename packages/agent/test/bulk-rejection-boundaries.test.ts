import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BULK_GRAPH_KIND as K, BulkGraphSession, encodeBulkGraphFrame, createOperationContext,
  type ProtocolRouter } from '@origintrail-official/dkg-core';
import { registerPublicBulkGraph } from '../src/sync/responder/bulk-graph-stream.js';
import { consumeBulkGraph } from '../src/sync/requester/bulk-graph-stream.js';
import { BulkStagingQueue } from '../src/sync/requester/bulk-staging-queue.js';
import { bulkJson, BULK_STAGING_BYTES, BULK_STAGING_ASSETS } from '../src/sync/bulk-graph-contract.js';
import type { PublicAssetResponderOptions } from '../src/sync/responder/public-asset-responder.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const uals = Array.from({ length: 33 }, (_, i) => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${i + 1}`);
const request = { version: 1 as const, contextGraphId: 'deny-fixture', snapshotDigest: 'a'.repeat(64), assetUals: uals };

describe('bulk mandatory authorization boundary', () => {
  it.each(['authorization', 'private', 'withheld'] as const)('rejects %s before exporting or disclosing payload', async denied => {
    let prepare!: Function, respond!: Function;
    const router = { registerDuplexStream: (_protocol: string, p: Function, r: Function) => { prepare = p; respond = r; } } as unknown as ProtocolRouter;
    const acquireEncoded = vi.fn(), send = vi.fn(() => true), abort = vi.fn();
    const options = {
      admission: { withPreAuthorizationAdmission: async (_peer: string, _signal: AbortSignal, run: () => unknown) => run(),
        withAuthorizedResponseAdmission: async (_peer: string, _cg: string, _signal: AbortSignal, run: () => unknown) => run() },
      authorizeSyncRequest: async () => denied !== 'authorization', isPublicContextGraph: async () => denied !== 'private',
      servingWithheld: () => denied === 'withheld', exportCache: { acquireEncoded },
    } as unknown as PublicAssetResponderOptions;
    registerPublicBulkGraph(router, options);
    const signal = new AbortController().signal;
    const stream = { async *[Symbol.asyncIterator]() { yield encodeBulkGraphFrame({ kind: K.REQUEST, index: 0, sequence: 0, payload: bulkJson(request) }); }, send, abort };
    const prepared = await prepare(stream, signal);
    try {
      await expect(respond({ ...prepared, peerId: 'requesting-peer', signal })).rejects.toThrow('authorization denied');
      expect(acquireEncoded).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    } finally { await prepared.dispose(); }
  });
});

describe('bulk receiver reservations against excess data', () => {
  it.each(['bytes', 'assets'] as const)('accepts exactly the %s limit and refuses the next reservation', kind => {
    const queue = new BulkStagingQueue(new AbortController().signal);
    const count = kind === 'bytes' ? 4 : BULK_STAGING_ASSETS, size = kind === 'bytes' ? 4 * 1024 * 1024 : 1;
    for (let i = 0; i < count; i++) queue.reserve(size);
    expect(queue.peakBytes).toBe(count * size);
    expect(() => queue.reserve(1)).toThrow('staging credit exceeded');
    queue.consumed(size); expect(() => queue.reserve(size)).not.toThrow();
    expect(() => queue.reserve(1)).toThrow('staging credit exceeded');
  });
  it.each(['bytes', 'assets'] as const)('terminates an uncooperative peer at the %s limit while verification is blocked', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'bulk-excess-')); roots.push(root);
    const count = kind === 'bytes' ? 4 : BULK_STAGING_ASSETS, size = kind === 'bytes' ? 4 * 1024 * 1024 : 1;
    const body = Buffer.alloc(size, 'x'), digest = createHash('sha256').update(body).digest('hex');
    const cancellation = new AbortController(), send = vi.fn(() => true), abort = vi.fn((error: Error) => cancellation.abort(error));
    let release!: () => void, received = 0;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const stream = { send, abort, async *[Symbol.asyncIterator]() {
      for (let index = 0; index <= count; index++) {
        yield encodeBulkGraphFrame({ kind: K.META, index, sequence: 0, payload: bulkJson({
          encodedBytes: size, plainBytes: size, offset: index * size, digest, metadata: Buffer.from('metadata').toString('base64'),
        }) });
        if (index === count) throw new Error('receiver read past rejected reservation');
        let sequence = 0;
        for (let offset = 0; offset < size; offset += 65536) yield encodeBulkGraphFrame({ kind: K.DATA, index, sequence: sequence++, payload: body.subarray(offset, offset + 65536) });
        yield encodeBulkGraphFrame({ kind: K.ASSET_END, index, sequence, payload: new Uint8Array() });
      }
    } };
    const session = new BulkGraphSession(stream as never, cancellation.signal), commit = vi.fn();
    const result = consumeBulkGraph(session, request, { stagingRoot: root, commit,
      verification: { contextGraphId: request.contextGraphId, assetUals: uals, ctx: createOperationContext('sync'),
        parseAndFilter: async () => { await blocked; return { quads: [], totalQuads: 0 }; },
        processDurableBatchInWorker: vi.fn(),
      }, onMetrics: metrics => { received = metrics.receivedAssets; },
    }).then(value => ({ value }), error => ({ error }));
    try {
      await vi.waitFor(() => expect(received).toBe(count));
      const [dir] = await readdir(root); const files = await readdir(join(root, dir!));
      expect(files).toHaveLength(count);
      expect((await Promise.all(files.map(file => stat(join(root, dir!, file))))).reduce((n, s) => n + s.size, 0)).toBe(count * size);
      release(); const settled = await result;
      expect('error' in settled && settled.error.message).toContain('staging credit exceeded');
      expect('error' in settled && settled.error.metrics.peakStagedBytes).toBeLessThanOrEqual(BULK_STAGING_BYTES);
      expect(send).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(abort).toHaveBeenCalledTimes(1);
    } finally { release(); session.abort(new Error('fixture complete')); await result; await session.dispose(); }
  }, 10_000);
});
