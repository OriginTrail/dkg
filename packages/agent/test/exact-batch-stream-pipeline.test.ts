import { afterEach, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { createExactBatchResponderBinding } from '../src/sync/responder/exact-batch-stream.js';
import { ExactBatchAssetMissingError } from '../src/sync/responder/exact-asset-export-cache.js';
import { EXACT_BATCH_FRAME_KIND as K, type ExactBatchFrame } from '../src/sync/exact-batch-stream-contract.js';

afterEach(() => vi.restoreAllMocks());

async function fixture(failure?: 'missing' | 'resource') {
  const uals = [1, 2, 3].map(n => `did:dkg:hardhat:31337/0x${'ab'.repeat(20)}/${n}`);
  const controller = new AbortController();
  const releases = uals.map(() => vi.fn());
  const fences = uals.map(() => vi.fn(async () => {}));
  const acquired: string[] = [], sent: ExactBatchFrame[] = [];
  let ack!: () => void;
  const held = new Promise<void>(resolve => { ack = resolve; });
  let acknowledged = 0;
  const authority = vi.fn(async (): Promise<'public' | 'non-public'> => 'public');
  const binding = createExactBatchResponderBinding({
    localPeerId: 'source', store: {} as TripleStore,
    authorizeSyncRequest: async () => true, resolvePublicContextGraphAuthority: authority,
    parseSyncRequest: () => ({ contextGraphId: 'pipeline', offset: 0, limit: 10,
      includeSharedMemory: false, phase: 'data', assetUals: uals }),
    admission: { withPreAuthorizationAdmission: async (_peer, _signal, run) => run(),
      withAuthorizedResponseAdmission: async (_peer, _cg, _signal, run) => run() },
    exportCache: { acquireEncoded: async request => {
      acquired.push(request.assetUal);
      const i = uals.indexOf(request.assetUal);
      if (i === 2 && failure === 'missing') throw new ExactBatchAssetMissingError();
      if (i === 2 && failure === 'resource') return null;
      return { metadata: new Uint8Array([1]), body: new Uint8Array([2]), plainBytes: 1,
        identity: String(i), encodingDurationMs: 0, wholePayloadExports: 0,
        assertCurrent: fences[i]!, release: releases[i]! };
    } },
  });
  const authorized = await binding.authorizeRequest(new Uint8Array([1]), 'client', controller.signal);
  const run = binding.respond(authorized.context, {
    assetUals: uals, windowSize: 2, signal: controller.signal,
    send: async frame => { sent.push(frame); },
    next: async () => {
      await held; controller.signal.throwIfAborted();
      return { kind: K.ACK, assetIndex: acknowledged++, sequence: 1, payload: new Uint8Array() };
    },
  }, 'client').then(() => ({ passed: true }), error => ({ error }));
  return { acquired, sent, ack, run, authority, controller, releases, fences };
}

it('prepares one bounded export during commit wait without spending wire credit', async () => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.acquired).toHaveLength(3), { timeout: 500 });
    expect(f.sent.filter(frame => frame.kind === K.META).map(frame => frame.assetIndex)).toEqual([0, 1]);
    expect(f.releases[2]).not.toHaveBeenCalled();
    expect(f.fences[2]).not.toHaveBeenCalled();
  } finally { f.ack(); await f.run; }
  expect(await f.run).toEqual({ passed: true });
  for (const release of f.releases) expect(release).toHaveBeenCalledTimes(1);
  f.fences.forEach((fence, index) => expect(fence).toHaveBeenCalledTimes(index === 2 ? 2 : 1));
});

it.each(['missing', 'resource'] as const)('waits for existing commit credit before reporting %s preparation failure', async failure => {
  const f = await fixture(failure);
  let settled = false;
  void f.run.then(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(f.acquired).toHaveLength(3), { timeout: 500 });
    expect(settled).toBe(false);
    expect(f.sent.filter(frame => frame.kind === K.ASSET_END)).toHaveLength(2);
  } finally { f.ack(); await f.run; }
  expect(await f.run).toHaveProperty('error');
  expect(await f.run).toMatchObject({ error: { refusal: failure === 'missing' ? 'ASSET_MISSING' : 'RESOURCE_LIMIT' } });
  expect(f.releases[0]).toHaveBeenCalledTimes(1);
  expect(f.releases[1]).toHaveBeenCalledTimes(1);
  expect(f.releases[2]).not.toHaveBeenCalled();
});

it.each(['private', 'cancelled'] as const)('does not send prepared bytes after %s while awaiting credit', async reason => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.acquired).toHaveLength(3), { timeout: 500 });
    if (reason === 'private') f.authority.mockResolvedValue('non-public');
    else f.controller.abort(new Error('cancelled'));
  } finally { f.ack(); await f.run; }
  expect(await f.run).toHaveProperty('error');
  expect(f.sent.some(frame => frame.kind === K.META && frame.assetIndex === 2)).toBe(false);
  for (const release of f.releases) expect(release).toHaveBeenCalledTimes(1);
});

it('rechecks prepared asset access after credit while its graph remains public', async () => {
  const f = await fixture();
  try {
    await vi.waitFor(() => expect(f.acquired).toHaveLength(3));
    f.fences[2]!.mockRejectedValue(new Error('asset became private'));
  } finally { f.ack(); await f.run; }
  expect(await f.run).toMatchObject({ error: { message: 'asset became private' } });
  await expect(f.authority()).resolves.toBe('public');
  expect(f.sent.filter(frame => frame.assetIndex === 2 && (frame.kind === K.META || frame.kind === K.DATA))).toEqual([]);
  for (const release of f.releases) expect(release).toHaveBeenCalledOnce();
});
