import { afterEach, describe, expect, it, vi } from 'vitest';
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
  return { agent, store };
}

describe('v10 ACK provider wiring', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('passes v10ACKProvider to publisher when chain supports V10 publish', async () => {
    ({ agent } = await createAgent(new MockChainAdapter('mock:31337')));

    const publishSpy = vi.spyOn((agent as any).publisher, 'publish').mockResolvedValue({
      ual: 'did:dkg:test/ack-provider',
      merkleRoot: new Uint8Array(32),
      kcId: 1n,
      kaManifest: [],
      status: 'tentative',
    });
    const broadcastSpy = vi.spyOn(agent as any, 'broadcastPublish').mockResolvedValue(undefined);

    await agent.publish(SYSTEM_PARANETS.ONTOLOGY, [
      { subject: 'urn:test:ack-provider', predicate: 'http://schema.org/name', object: '"ACK"', graph: '' },
    ]);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]?.[0]?.v10ACKProvider).toEqual(expect.any(Function));

    publishSpy.mockRestore();
    broadcastSpy.mockRestore();
  });

  it('does not pass v10ACKProvider when chain does not support V10 publish', async () => {
    ({ agent } = await createAgent(new NoChainAdapter()));

    const publishSpy = vi.spyOn((agent as any).publisher, 'publish').mockResolvedValue({
      ual: 'did:dkg:test/no-ack-provider',
      merkleRoot: new Uint8Array(32),
      kcId: 1n,
      kaManifest: [],
      status: 'tentative',
    });
    const broadcastSpy = vi.spyOn(agent as any, 'broadcastPublish').mockResolvedValue(undefined);

    await agent.publish(SYSTEM_PARANETS.ONTOLOGY, [
      { subject: 'urn:test:no-ack-provider', predicate: 'http://schema.org/name', object: '"No ACK"', graph: '' },
    ]);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]?.[0]?.v10ACKProvider).toBeUndefined();

    publishSpy.mockRestore();
    broadcastSpy.mockRestore();
  });
});
