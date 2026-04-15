import { afterEach, describe, expect, it } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { NoChainAdapter, MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { SYSTEM_PARANETS } from '@origintrail-official/dkg-core';

async function createAgent(chainAdapter: MockChainAdapter | NoChainAdapter) {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'AckProviderTestAgent',
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter,
  });
  await agent.start();
  return { agent, store, chain: chainAdapter };
}

describe('v10 ACK provider wiring', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('uses V10 publish path when chain supports V10 (MockChainAdapter)', async () => {
    const chain = new MockChainAdapter('mock:31337');
    ({ agent } = await createAgent(chain));

    const result = await agent.publish(SYSTEM_PARANETS.ONTOLOGY, [
      { subject: 'urn:test:ack-provider', predicate: 'http://schema.org/name', object: '"ACK"', graph: '' },
    ]);

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(typeof result.onChainResult!.batchId).toBe('bigint');
  });

  it('publishes tentatively when chain does not support V10 (NoChainAdapter)', async () => {
    ({ agent } = await createAgent(new NoChainAdapter()));

    const result = await agent.publish(SYSTEM_PARANETS.ONTOLOGY, [
      { subject: 'urn:test:no-ack-provider', predicate: 'http://schema.org/name', object: '"No ACK"', graph: '' },
    ]);

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
  });
});
