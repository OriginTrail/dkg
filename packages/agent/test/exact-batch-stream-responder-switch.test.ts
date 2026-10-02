import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { EXACT_BATCH_STREAM_PROTOCOL } from '../src/sync/exact-batch-stream-contract.js';

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
