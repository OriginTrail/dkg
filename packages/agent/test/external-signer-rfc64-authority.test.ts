// SPDX-License-Identifier: Apache-2.0
/**
 * RFC-64 control objects issued by an author key that the external signer
 * holds: the replica authority seed of the author's wallet-namespaced public
 * context graph, and the author's catalog and inventory signatures, are
 * signed there (EIP-191 over the object digest), recover to the author, and
 * are never signed by a payer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { NoChainAdapter, connectRemoteSigners } from '@origintrail-official/dkg-chain';
import {
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  type ContextGraphIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../src/index.js';
import { externalAuthorControlDigestSigner } from '../src/external-author-signing.js';
import {
  RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
  authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1,
} from '../src/rfc64/unregistered-replica-authority-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
} from './_helpers/rfc64-rollout-agent-harness.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'rfc64-payer-credential-2b3c4d5e6f7a8b9c';
const AUTHOR_TOKEN = 'rfc64-author-credential-9c8b7a6f5e4d3c2b';
const payer = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER);
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const OWNER = author.address.toLowerCase() as EvmAddressV1;
const HUB = '0x3333333333333333333333333333333333333333';

/** The chain adapter of a node whose operational wallets sign through an external signer. */
class ExternallySignedNoChain extends NoChainAdapter {
  usesExternalSigner(): boolean {
    return true;
  }
}

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();
const fakes: FakeSigner[] = [];
afterEach(async () => {
  await cleanup();
  while (fakes.length > 0) await fakes.pop()!.close();
});

/** A node whose payer and default author both live in the external signer, with RFC-64 authority active. */
async function externalAuthorNode(name: string): Promise<{ agent: DKGAgent; fake: FakeSigner }> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [payer.privateKey] },
      { token: AUTHOR_TOKEN, keys: [author.privateKey] },
    ],
  });
  fakes.push(fake);
  const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
  const agent = await startAgent({
    name,
    config: {
      rfc64CatalogDeploymentProfile: DEPLOYMENT,
      chainAdapter: new ExternallySignedNoChain(),
      chainConfig: { rpcUrl: 'http://127.0.0.1:1', hubAddress: HUB, authors: remote.authors },
    },
  });
  return { agent, fake };
}

/** Requests the signer answered for the payer credential, other than listing its accounts. */
function payerSigningRequests(fake: FakeSigner) {
  return fake.requests.filter((request) => (
    request.authorization === `Bearer ${PAYER_TOKEN}` && request.method !== 'eth_accounts'
  ));
}

async function seedEvidence(agent: DKGAgent, contextGraphId: string): Promise<string> {
  const store = (agent as unknown as { store: TripleStore }).store;
  const result = await store.query(
    `SELECT ?evidence WHERE { GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> { ` +
    `<${contextGraphDataGraphUri(contextGraphId)}> <${RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1}> ?evidence } }`,
  );
  const rows = result.type === 'bindings' ? result.bindings : [];
  expect(rows).toHaveLength(1);
  return String(rows[0]!['evidence']).replace(/^"|"$/g, '');
}

describe('RFC-64 control objects of an author key held by the external signer', () => {
  it('signs the replica authority seed of the author\'s namespaced public graph through the external signer', async () => {
    const { agent, fake } = await externalAuthorNode('external-author-seed');
    expect(agent.getDefaultAgentAddress()?.toLowerCase()).toBe(OWNER);
    const contextGraphId = `${OWNER}/notes` as ContextGraphIdV1;
    const signedBefore = fake.calls('eth_sign').length;

    await agent.createContextGraph({ id: contextGraphId, name: 'Notes', accessPolicy: 0 });

    const authority = await authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1(
      Buffer.from(await seedEvidence(agent, contextGraphId), 'base64url'),
      { networkId: NETWORK_ID, contextGraphId },
    );
    expect(authority.ownerAddress).toBe(OWNER);
    const signed = fake.calls('eth_sign').slice(signedBefore);
    expect(signed).toHaveLength(1);
    expect(signed[0]!.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(ethers.getAddress(String(signed[0]!.params[0]))).toBe(author.address);
    expect(payerSigningRequests(fake)).toEqual([]);
  });

  it('signs the author\'s catalog and inventory through the external signer, and never as a payer', async () => {
    const { agent, fake } = await externalAuthorNode('external-author-catalog');
    const digest = ethers.getBytes(ethers.id('author catalog head'));

    const signature = await agent.createRfc64CatalogAuthorSignerV1(OWNER).signMessage(digest);
    expect(ethers.verifyMessage(digest, signature)).toBe(author.address);
    expect(fake.calls('eth_sign').at(-1)!.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);

    // A payer account is not an author key, and the payers are not asked to sign as one.
    const asPayer = agent.createRfc64CatalogAuthorSignerV1(payer.address.toLowerCase() as EvmAddressV1);
    await expect(asPayer.signMessage(digest)).rejects.toThrow(/no author key of its external signer/);
    expect(payerSigningRequests(fake)).toEqual([]);
  });

  it('refuses a control-object signature that does not recover to the author', async () => {
    const other = new ethers.Wallet(HARDHAT_KEYS.EXTRA3);
    const misrouted = {
      address: author.address,
      signTypedData: other.signTypedData.bind(other),
      signMessage: (message: string | Uint8Array) => other.signMessage(message),
    };
    const config = { chainConfig: { authors: {
      addresses: [author.address],
      signerFor: async () => misrouted,
      firstSignerOf: async () => ({ address: author.address, signer: misrouted }),
    } } };
    const sign = await externalAuthorControlDigestSigner(config, author.address);
    await expect(sign!(ethers.getBytes(ethers.id('author inventory head'))))
      .rejects.toThrow(/does not recover to author/);
    expect(await externalAuthorControlDigestSigner({}, author.address)).toBeUndefined();
  });
});
