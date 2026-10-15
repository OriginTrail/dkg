// SPDX-License-Identifier: Apache-2.0
/**
 * RFC-64 control objects issued by an author key that the external signer
 * holds: the replica authority seed of the author's wallet-namespaced public
 * context graph, and the author's catalog and inventory signatures, are
 * signed there (EIP-191 over the object digest, the signer shown the object
 * with `dkg_signControlObject`), recover to the author, and are never signed
 * by a payer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { NoChainAdapter, connectRemoteSigners, type OperationalSigning } from '@origintrail-official/dkg-chain';
import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  SYSTEM_CONTEXT_GRAPHS,
  computeControlObjectDigest,
  contextGraphDataGraphUri,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../src/index.js';
import { heldAuthorSigner } from '../src/author-signer.js';
import { rfc64AuthorDigestSignerV1 } from '../src/rfc64/control-envelope-signer-v1.js';
import {
  RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1,
  signingRfc64ControlObjectV1,
} from '../src/rfc64/external-author-control-signing-v1.js';
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

/** The chain adapter of a node whose operational wallets sign through an external signer. */
class ExternallySignedNoChain extends NoChainAdapter {
  operationalSigning(): OperationalSigning {
    return { external: true, payerAddresses: [] };
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
      authorSigners: remote.authors,
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
    const signedBefore = fake.requests.length;

    await agent.createContextGraph({ id: contextGraphId, name: 'Notes', accessPolicy: 0 });

    const authority = await authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1(
      Buffer.from(await seedEvidence(agent, contextGraphId), 'base64url'),
      { networkId: NETWORK_ID, contextGraphId },
    );
    expect(authority.ownerAddress).toBe(OWNER);
    // The signer was shown the seed, the graph's policy object, and recomputed its digest.
    const signing = fake.requests.slice(signedBefore).filter((request) => /sign/i.test(request.method));
    expect(signing.map((request) => request.method)).toEqual([RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1]);
    expect(signing[0]!.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(ethers.getAddress(String(signing[0]!.params[0]))).toBe(author.address);
    const envelope = JSON.parse((signing[0]!.params[1] as { envelope: string }).envelope) as { objectType: string; issuer: string };
    expect(envelope).toMatchObject({ objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1, issuer: OWNER });
    expect(payerSigningRequests(fake)).toEqual([]);
  });

  it('signs the author\'s catalog and inventory through the external signer, and never as a payer', async () => {
    const { agent, fake } = await externalAuthorNode('external-author-catalog');
    const unsigned = {
      issuer: OWNER,
      objectType: 'AuthorCatalogIssuerDelegationV1',
      payload: { authorAddress: OWNER, contextGraphId: 'catalog-graph', effectiveAt: '1', expiresAt: '2' },
      signatureEvidence: { kind: 'none' },
      signatureSuite: 'eip191-personal-sign-digest-v1',
    } as UnsignedControlEnvelopeV1;
    const digest = computeControlObjectDigest(unsigned);
    const authorSigner = agent.createRfc64CatalogAuthorSignerV1(OWNER);
    const before = fake.requests.length;

    // The producers mark the object they sign, which the signer is shown.
    const signature = await signingRfc64ControlObjectV1(unsigned, () => authorSigner.signMessage(digest));
    expect(ethers.verifyMessage(digest, signature)).toBe(author.address);
    expect(fake.calls(RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1).at(-1)!.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    // A digest alone is never sent.
    await expect(authorSigner.signMessage(digest)).rejects.toThrow('signs only a control object it is shown');
    expect(fake.requests.slice(before).map((request) => request.method)).toEqual([RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1]);

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
    const authors = {
      addresses: [author.address],
      signerFor: async () => misrouted,
      firstSignerOf: async () => ({ address: author.address, signer: misrouted }),
    };
    // An agent the node holds no key for: the external author key is looked up, then checked.
    const agents = { getLocalAgentMode: () => 'self-sovereign' as const, getCustodialAgentPrivateKey: () => undefined };
    const held = await heldAuthorSigner(agents, authors, author.address);
    expect(held).toBe(misrouted);
    await expect(rfc64AuthorDigestSignerV1(OWNER, held!)(ethers.getBytes(ethers.id('author inventory head'))))
      .rejects.toThrow(/does not recover to author/);
    expect(await heldAuthorSigner(agents, undefined, author.address)).toBeUndefined();
  });
});
