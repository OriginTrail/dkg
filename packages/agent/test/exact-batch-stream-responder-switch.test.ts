import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { PROTOCOL_SYNC, exchangeExperimentalExactBatch } from '@origintrail-official/dkg-core';
import { OxigraphStore, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_STREAM_PROTOCOL, type ExactBatchFrame } from '../src/sync/exact-batch-stream-contract.js';
import { exactBatchStartFrame, exactBatchTransportOptions } from '../src/sync/requester/exact-batch-stream.js';

const CURRENT = 'DKG_EXACT_BATCH_STREAM_ENABLED';
const FIRST_DEPLOYED = 'DKG_EXPERIMENTAL_EXACT_BATCH_STREAM';
const agents: DKGAgent[] = [];
const assetUals = ['did:dkg:mock:31337/0x0000000000000000000000000000000000000001/1'];

async function createNode(name: string, nodeRole: 'core' | 'edge'): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name, nodeRole, listenHost: '127.0.0.1', listenPort: 0,
    chainAdapter: new MockChainAdapter('mock:31337'),
    store: Object.assign(new OxigraphStore(), { queryResponseLimitMode: 'pre-materialization' as const }),
    randomSamplingUseWorkerThread: false,
  });
  agents.push(agent);
  return agent;
}

async function connectedNodes(label: string, configureCore: (core: DKGAgent) => void): Promise<{ core: DKGAgent; edge: DKGAgent }> {
  vi.stubEnv(CURRENT, '1'); vi.stubEnv(FIRST_DEPLOYED, undefined);
  const core = await createNode(`ExactBatch${label}Core`, 'core');
  configureCore(core);
  await core.start();
  const edge = await createNode(`ExactBatch${label}Edge`, 'edge');
  await edge.start();
  await edge.connectTo(core.multiaddrs.find(address => address.includes('/tcp/') && !address.includes('/p2p-circuit'))!);
  return { core, edge };
}

async function exchangeFrames(core: DKGAgent, edge: DKGAgent, contextGraphId: string, timeoutMs = 30_000): Promise<ExactBatchFrame[]> {
  const unused = async () => { throw new Error('A public START needs no identity or signature'); };
  const request = await buildSyncRequestEnvelope({ contextGraphId, offset: 0, limit: 500,
    includeSharedMemory: false, targetPeerId: core.peerId, requesterPeerId: edge.peerId, phase: 'data',
    assetUals, needsAuth: false, getIdentityId: unused, computeSyncDigest: () => { throw new Error('unused'); }, signMessage: unused });
  return exchangeExperimentalExactBatch(edge.router, core.peerId, exactBatchStartFrame(request),
    { ...exactBatchTransportOptions(timeoutMs), assetUals }, async session => {
      const frames: ExactBatchFrame[] = [];
      for (let item = await session.next(); item; item = await session.next()) frames.push(item);
      return frames;
    });
}

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
  const agent = await createNode(`ExactBatchStreamSwitch-${nodeRole}`, nodeRole);
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
    // Every stream request that is admitted stays in authorization until released.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const authorize = vi.fn(async () => { await held; return false; });
    const infoMessages: string[] = [];
    const { core, edge } = await connectedNodes('Busy', core => {
      vi.spyOn(core, 'authorizeSyncRequest').mockImplementation(authorize);
      vi.spyOn((core as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info')
        .mockImplementation((_context, message) => { infoMessages.push(String(message)); });
    });
    const open = () => exchangeFrames(core, edge, 'busy-core-public', 60_000)
      .then(frames => frames, (error: unknown) => error);

    // One request of a peer runs and four may wait. Of ten, at least five are
    // therefore refused at once, and only a refused one can settle while the
    // admitted one is held.
    const opened = Array.from({ length: 10 }, open);
    try {
      const first = await Promise.race(opened);
      expect(first).toEqual([{ kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('BUSY') }]);
      const busyLine = `Exact batch responder busy stage=pre-authorization peer=${edge.peerId.slice(-8)} `
        + 'reason="sync responder peer queue full" running=1 queued=4';
      const busyLines = () => infoMessages.filter(line => line.startsWith('Exact batch responder busy'));
      await vi.waitFor(() => expect(busyLines()).toContain(busyLine), { timeout: 10_000 });
      expect(authorize).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.all(opened);
    }
  }, 30_000);
});

describe('a core whose exact-stream public authority cannot be read', () => {
  it.each(['authority-unavailable', 'store-busy'] as const)('answers %s with a BUSY frame before export', async failure => {
    const authorized = vi.fn(async () => {
      if (failure === 'store-busy') throw new StoreSchedulerBusyError('queue_full', 'normal', 'blazegraph.query', { storeOperation: 'query' });
      return true;
    });
    let authorityReads = 0;
    const { core, edge } = await connectedNodes(`Refusal-${failure}`, core => {
      vi.spyOn(core, 'authorizeSyncRequest').mockImplementation(authorized);
      vi.spyOn(core, 'resolveRegisteredContextGraphAuthority').mockImplementation(async () => {
        authorityReads++;
        return { kind: 'unavailable', reason: 'chain-access-policy-unavailable' };
      });
    });
    const frames = await exchangeFrames(core, edge, 'public-authority-unavailable');
    expect(frames).toEqual([{ kind: K.REFUSE, assetIndex: 255, sequence: 0, payload: new TextEncoder().encode('BUSY') }]);
    expect(authorized).toHaveBeenCalledOnce();
    expect(authorityReads).toBe(failure === 'store-busy' ? 0 : 1);
  }, 30_000);
});

describe('a core with no confirmed exact export envelope', () => {
  it('sends ASSET_MISSING over the real stream instead of resetting it', async () => {
    const { core, edge } = await connectedNodes('Missing', core => {
      vi.spyOn(core, 'authorizeSyncRequest').mockResolvedValue(true);
      vi.spyOn(core, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({ kind: 'public', onChainId: 1n });
    });
    const frames = await exchangeFrames(core, edge, 'public-missing-exact-asset');
    expect(frames).toEqual([{ kind: K.REFUSE, assetIndex: 255, sequence: 0,
      payload: new TextEncoder().encode('ASSET_MISSING') }]);
  }, 30_000);
});
