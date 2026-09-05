import { expect } from 'vitest';
import { contextGraphSharedMemoryTopic } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../../src/index.js';

export async function waitForSharedMemorySubscriber(
  node: DKGAgent,
  contextGraphId: string,
  subscriber: Pick<DKGAgent, 'peerId'>,
): Promise<void> {
  const topic = contextGraphSharedMemoryTopic(node.gossipWireIdFor(contextGraphId));
  await expect.poll(() => node.gossip.getSubscribers(topic), { timeout: 10_000 }).toContain(subscriber.peerId);
}
