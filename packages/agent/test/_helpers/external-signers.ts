/**
 * Fixtures for nodes whose wallets and author keys live in an external signer:
 * a fake remote signer serving a payer credential and an author credential, the
 * mock chains reporting how their wallets sign, and an agent stub that signs
 * through the signer.
 */
import { ethers } from 'ethers';
import { MockChainAdapter, connectRemoteSigners, type OperationalSigning, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../../src/dkg-agent.js';
import { makeTestKaNumberAllocator } from './ka-allocator.js';
import { startFakeRemoteSigner, type FakeSigner, type FakeSignerOptions } from '../../../chain/test/helpers/fake-remote-signer.js';

export const PAYER_TOKEN = 'payer-credential-5e4d3c2b1a090807';
export const AUTHOR_TOKEN = 'author-credential-0706050403020100';
export const payer = ethers.Wallet.createRandom();
export const defaultAuthor = ethers.Wallet.createRandom();
export const agentKey = ethers.Wallet.createRandom();
export const CG = 'external-authors';
export const NAME = 'notes';
export const KAV_ADDRESS = '0x1111111111111111111111111111111111111111';

/** The fake signers a test started; {@link closeStartedSigners} closes them after it. */
export const startedSigners: FakeSigner[] = [];

export async function closeStartedSigners(): Promise<void> {
  while (startedSigners.length > 0) await startedSigners.pop()!.close();
}

/** A fake signer with `payer` behind the payer credential and the author keys behind the author credential, and its connection. */
export async function externalSigners(options: Partial<FakeSignerOptions> = {}): Promise<{ fake: FakeSigner; remote: RemoteSigners }> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [payer.privateKey] },
      { token: AUTHOR_TOKEN, keys: [defaultAuthor.privateKey, agentKey.privateKey] },
    ],
    ...options,
  });
  startedSigners.push(fake);
  const remote = await connectRemoteSigners({
    url: fake.url,
    authToken: PAYER_TOKEN,
    author: { authToken: AUTHOR_TOKEN, address: defaultAuthor.address },
  });
  return { fake, remote };
}

export function silentLog() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/** A mock chain whose operational wallets sign through an external signer, as it reports. */
export class ExternallySignedMockChain extends MockChainAdapter {
  operationalSigning(): OperationalSigning {
    return { external: true, payerAddresses: [this.signerAddress] };
  }
}

/** A mock chain whose operational wallet is a key the node holds, and signs with it. */
export class LocallySignedMockChain extends MockChainAdapter {
  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.setMockACKSigner(wallet);
  }

  getOperationalPrivateKey(): string {
    return this.wallet.privateKey;
  }
}

/** An agent, without a network, whose chain's wallets sign externally and whose author keys are `remote`'s. */
export async function stubAgent(remote: RemoteSigners, store = new OxigraphStore()) {
  const agent = Object.create(DKGAgent.prototype) as any;
  const chain = {
    chainId: 'mock:31337',
    getEvmChainId: async () => 31337n,
    getKnowledgeAssetsLifecycleAddress: async () => KAV_ADDRESS,
    hasContractCode: async () => false,
    operationalSigning: () => ({ external: true, payerAddresses: [payer.address] }),
  };
  agent.store = store;
  agent.log = silentLog();
  agent.chain = chain;
  agent.config = { authorSigners: remote.authors };
  agent.localAgents = new Map();
  agent.agentTokenIndex = new Map();
  agent.kaNumberAllocator = makeTestKaNumberAllocator();
  agent.reconciledKaAuthors = new Set<string>();
  agent.publisher = new DKGPublisher({
    store,
    chain: chain as never,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    writeLocks: new Map(),
    authorSigner: remote.authors!.defaultAuthor,
  });
  Object.defineProperty(agent, 'peerId', {
    value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
    configurable: true,
  });
  return agent;
}

export function q(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}
