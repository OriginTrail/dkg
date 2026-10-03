import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { PROTOCOL_SYNC, exchangeExperimentalExactBatch } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_STREAM_PROTOCOL, type ExactBatchFrame } from '../src/sync/exact-batch-stream-contract.js';
import { exactBatchStartFrame, exactBatchTransportOptions } from '../src/sync/requester/exact-batch-stream.js';

const CURRENT = 'DKG_EXACT_BATCH_STREAM_ENABLED';
const FIRST_DEPLOYED = 'DKG_EXPERIMENTAL_EXACT_BATCH_STREAM';
const agents: DKGAgent[] = [];

/**
 * The protocols a real started agent serves. The store only declares the
 * bounded-response capability the responder requires; nothing is exported here.
 */
async function servedProtocols(
  nodeRole: 'core' | 'edge',
  env: { readonly [CURRENT]?: string; readonly [FIRST_DEPLOYED]?: string },
): Promise<string[]> {
  // Both names are always stubbed, so the invoking shell cannot decide a case.
  vi.stubEnv(CURRENT, env[CURRENT]);
  vi.stubEnv(FIRST_DEPLOYED, env[FIRST_DEPLOYED]);
  const agent = await DKGAgent.create({
    name: `ExactBatchStreamSwitch-${nodeRole}`, nodeRole,
    listenHost: '127.0.0.1', listenPort: 0,
    chainAdapter: new MockChainAdapter('mock:31337'),
    store: Object.assign(new OxigraphStore(), { queryResponseLimitMode: 'pre-materialization' as const }),
    randomSamplingUseWorkerThread: false,
  });
  agents.push(agent);
  await agent.start();
  const protocols = agent.node.libp2p.getProtocols();
  // The stream responder is registered by the same call that registers ordinary
  // sync, so its absence below is a decision and not a registration still to come.
  expect(protocols).toContain(PROTOCOL_SYNC);
  return protocols;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
});

describe('exact-batch stream responder switch', () => {
  it.each([
    ['its current name', { [CURRENT]: '1' }],
    // A core configured before the rename must keep serving after an upgrade.
    ['the name it was first deployed under', { [FIRST_DEPLOYED]: '1' }],
  ])('a core serves the stream protocol when the switch is on under %s', async (_name, env) => {
    expect(await servedProtocols('core', env)).toContain(EXACT_BATCH_STREAM_PROTOCOL);
  });

  it.each([
    ['neither name is set', {}],
    ['its current name is off, whatever the first name says', { [CURRENT]: '0', [FIRST_DEPLOYED]: '1' }],
  ])('a core does not serve the stream protocol when %s', async (_case, env) => {
    expect(await servedProtocols('core', env)).not.toContain(EXACT_BATCH_STREAM_PROTOCOL);
  });

  it('an edge does not serve the stream protocol', async () => {
    expect(await servedProtocols('edge', { [CURRENT]: '1' })).not.toContain(EXACT_BATCH_STREAM_PROTOCOL);
  });
});

describe('a core whose sync responder has no room for a stream request', () => {
  it('answers a real request from another node with a BUSY frame and logs it', async () => {
    vi.stubEnv(CURRENT, '1'); vi.stubEnv(FIRST_DEPLOYED, undefined);
    const create = (name: string, nodeRole: 'core' | 'edge') => DKGAgent.create({
      name, nodeRole, listenHost: '127.0.0.1', listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      store: Object.assign(new OxigraphStore(), { queryResponseLimitMode: 'pre-materialization' as const }),
      randomSamplingUseWorkerThread: false,
    });
    const core = await create('ExactBatchBusyCore', 'core'); agents.push(core);
    // Every stream request that is admitted stays in authorization until released.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const authorize = vi.spyOn(core, 'authorizeSyncRequest').mockImplementation(async () => { await held; return false; });
    const info = vi.spyOn((core as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info');
    await core.start();
    const edge = await create('ExactBatchBusyEdge', 'edge'); agents.push(edge);
    await edge.start();
    await edge.connectTo(core.multiaddrs.find(address => address.includes('/tcp/') && !address.includes('/p2p-circuit'))!);

    const assetUals = ['did:dkg:mock:31337/0x0000000000000000000000000000000000000001/1'];
    const unused = async () => { throw new Error('A public START needs no identity or signature'); };
    const request = await buildSyncRequestEnvelope({ contextGraphId: 'busy-core-public', offset: 0, limit: 500,
      includeSharedMemory: false, targetPeerId: core.peerId, requesterPeerId: edge.peerId, phase: 'data',
      assetUals, needsAuth: false, getIdentityId: unused, computeSyncDigest: () => { throw new Error('unused'); }, signMessage: unused });
    const open = () => exchangeExperimentalExactBatch(edge.router, core.peerId, exactBatchStartFrame(request),
      { ...exactBatchTransportOptions(60_000), assetUals }, async session => {
        const frames: ExactBatchFrame[] = [];
        for (let item = await session.next(); item; item = await session.next()) frames.push(item);
        return frames;
      }).then(frames => frames, (error: unknown) => error);

    // One request of a peer runs and four may wait. Of ten, at least five are
    // therefore refused at once, and only a refused one can settle while the
    // admitted one is held.
    const opened = Array.from({ length: 10 }, open);
    try {
      const first = await Promise.race(opened);
      expect(first).toEqual([{ kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('BUSY') }]);
      const busyLine = `Exact batch responder busy stage=pre-authorization peer=${edge.peerId.slice(-8)} `
        + 'reason="sync responder peer queue full" running=1 queued=4';
      const busyLines = () => info.mock.calls.map(([, message]) => String(message))
        .filter(line => line.startsWith('Exact batch responder busy'));
      await vi.waitFor(() => expect(busyLines()).toContain(busyLine), { timeout: 10_000 });
      expect(authorize).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.all(opened);
    }
  }, 30_000);
});
