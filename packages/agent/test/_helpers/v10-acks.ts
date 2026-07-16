import { ethers } from 'ethers';
import type { DKGAgent } from '../../src/index.js';
import type { V10ACKProvider } from '@origintrail-official/dkg-publisher';
import {
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
} from '../../../chain/test/evm-test-context.js';
import { hardhatACKProvider, makeHardhatUpdateACKProvider } from '../../../publisher/test/_helpers/acks.js';
import { wrapPublisherForTest } from '../../../publisher/test/_helpers/seal.js';

type Kav10Chain = {
  getKnowledgeAssetsLifecycleAddress: () => Promise<string>;
};

type AgentWithInternals = {
  chain: Kav10Chain;
  publisher: DKGAgent['publisher'];
};

/**
 * Single-agent Hardhat tests have no connected storage-ACK peers, but still
 * exercise the on-chain V10 publish path. Install the same in-memory receiver
 * ACK provider used by publisher tests, and patch the internal publisher too
 * for tests that call it directly (for example async lift runners).
 */
export async function installHardhatACKProvider(
  agent: DKGAgent,
  chain?: Kav10Chain,
): Promise<V10ACKProvider> {
  const internals = agent as unknown as AgentWithInternals;
  const effectiveChain = chain ?? internals.chain;
  const kav10Address = await effectiveChain.getKnowledgeAssetsLifecycleAddress();
  const v10ACKProvider = hardhatACKProvider(kav10Address);
  const v10UpdateACKProvider = makeHardhatUpdateACKProvider(
    getSharedContext(),
    effectiveChain as any,
    [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP],
  );

  Object.defineProperty(agent, 'createV10ACKProvider', {
    value: () => v10ACKProvider,
    configurable: true,
  });
  Object.defineProperty(agent, 'createV10UpdateACKProvider', {
    value: () => v10UpdateACKProvider,
    configurable: true,
  });

  const wrappedPublisher = wrapPublisherForTest(internals.publisher, {
    author: new ethers.Wallet(HARDHAT_KEYS.CORE_OP),
    ctx: {
      provider: createProvider(),
      kav10Address,
    },
    v10ACKProvider,
  });
  Object.defineProperty(agent, 'publisher', {
    value: wrappedPublisher,
    writable: true,
    configurable: true,
  });

  return v10ACKProvider;
}
