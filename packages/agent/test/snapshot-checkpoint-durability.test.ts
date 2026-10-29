import { afterEach, expect, it, vi } from 'vitest';
import { open, statfs } from 'node:fs/promises';
import { PUBLIC_CHECKPOINT_KIND as K, type BulkGraphFrame } from '@origintrail-official/dkg-core';
import { receiveSnapshotCheckpointChunk } from '../src/snapshot-checkpoint-receive.js';
import { bulkChunkHash, bulkJson, type BulkGraphRequest } from '../src/sync/bulk-graph-contract.js';
import { checkpointSha256 } from '../src/snapshot-checkpoint-files.js';

vi.mock('node:fs/promises', () => ({ open: vi.fn(), statfs: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each(['body', 'metadata', 'directory'] as const)('does not acknowledge while %s sync is pending, or after it fails', async blocked => {
  const body = Buffer.from('verified transport body'), metadata = Buffer.from('metadata');
  const request: BulkGraphRequest = { version: 1, contextGraphId: 'graph', snapshotDigest: 'a'.repeat(64),
    assetUals: ['did:dkg:base:8453/0x0000000000000000000000000000000000000001/1'] };
  const header = bulkJson({ encodedBytes: body.length, plainBytes: body.length, offset: 0,
    digest: checkpointSha256(body), metadata: metadata.toString('base64') });
  const digest = bulkChunkHash(request).update(header).update(body).digest('hex');
  const frames: BulkGraphFrame[] = [
    { kind: K.META, index: 0, sequence: 0, payload: header },
    { kind: K.DATA, index: 0, sequence: 0, payload: body },
    { kind: K.ASSET_END, index: 0, sequence: 1, payload: new Uint8Array() },
    { kind: K.CHUNK_END, index: 1, sequence: body.length, payload: bulkJson({ digest, assets: 1, encodedBytes: body.length }) },
  ];
  // Exercise the production file writers and receiver; control only OS persistence completion.
  for (const reject of [false, true]) {
    let release!: () => void, fail!: (error: Error) => void, entered!: () => void;
    const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const events: string[] = [], handles: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    vi.mocked(statfs).mockResolvedValue({ bavail: 20 * 2 ** 30, bsize: 1 } as never);
    vi.mocked(open).mockImplementation(async path => {
      const kind = String(path).endsWith('.body') ? 'body' : String(path).endsWith('.meta') ? 'metadata' : 'directory';
      const handle = { writeFile: vi.fn(async () => {}), close: vi.fn(async () => {}), sync: vi.fn(async () => {
        if (kind === blocked) { entered(); await gate; }
        events.push(kind);
      }) }; handles.push(handle); return handle as never;
    });
    let index = 0;
    const send = vi.fn(async (frame: BulkGraphFrame) => {
      if (frame.kind === K.PERSISTED) expect(events).toEqual(['body', 'metadata', 'directory']);
    });
    const pending = receiveSnapshotCheckpointChunk({ signal: new AbortController().signal,
      next: async () => frames[index++]!, send }, request, { directory: '/fixture', startIndex: 0,
      budget: { encodedBytes: 0, plainBytes: 0, maxEncodedBytes: 2 ** 30, maxPlainBytes: 8 * 2 ** 30, minFreeBytes: 7 * 2 ** 30 },
      assertCurrent() {} });
    const settled = pending.then(value => ({ value }), error => ({ error }));
    await Promise.race([reached, settled.then(() => { throw new Error('receiver settled before required persistence'); })]);
    expect(send).not.toHaveBeenCalled();
    if (reject) fail(new Error(`${blocked} fsync failed`)); else release();
    const result = await settled;
    if (reject) {
      expect(result).toMatchObject({ error: { message: `${blocked} fsync failed` } });
      expect(send).not.toHaveBeenCalled();
    } else {
      expect(result).toHaveProperty('value');
      expect(send.mock.calls.map(([frame]) => frame.kind)).toEqual([K.CREDIT, K.PERSISTED]);
    }
    expect(handles.every(handle => handle.close.mock.calls.length === 1)).toBe(true);
  }
});
