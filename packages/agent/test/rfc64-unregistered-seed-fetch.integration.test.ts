// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-level acceptance for the RFC-64 unregistered-authority seed fetch:
 * a replica that holds NO ontology copy of the owner-signed seed obtains it from
 * a connected peer during subscription bootstrap, persists it through the keyed
 * seed store, and its bootstrap authority becomes allowed through the existing
 * finalized-absence reconcile. Twins pin the closed outcomes: no peer holds the
 * seed, and a peer serves a forged seed.
 *
 * The two F2 contract methods (`readRfc64UnregisteredAuthoritySeedV1`,
 * `persistVerifiedRfc64UnregisteredAuthoritySeedV1`) are stubbed per agent with
 * an in-memory map. INTEGRATOR: once F2's keyed-store-first loader lands, drop
 * the `bridgeToOntology` stand-in below (see installSeedStoreStub).
 */
import { multiaddr } from '@multiformats/multiaddr';
import {
  contextGraphDataGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
  type ContextGraphIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import {
  NoChainAdapter,
  verifyControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import { encodeRfc64FoundStatusResponseV1 } from
  '../src/rfc64/catalog-transport-wire-v1-internal.js';
import {
  RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
  authenticateRfc64UnregisteredAuthorityEnvelopeV1,
} from '../src/rfc64/unregistered-authority-transport-v1.js';
import {
  RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
  mintRfc64UnregisteredReplicaAuthorityEvidenceV1,
} from '../src/rfc64/unregistered-replica-authority-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
} from './_helpers/rfc64-rollout-agent-harness.js';

const DEFAULT_NODE_WALLET = new ethers.Wallet(`0x${'70'.repeat(32)}`);
const VICTIM_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const VICTIM = VICTIM_WALLET.address.toLowerCase() as EvmAddressV1;
const ATTACKER_WALLET = new ethers.Wallet(`0x${'72'.repeat(32)}`);
const ATTACKER = ATTACKER_WALLET.address.toLowerCase() as EvmAddressV1;
const VICTIM_CONTEXT_GRAPH_ID = `${VICTIM}/seed-fetch` as ContextGraphIdV1;
const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const HUB = '0x3333333333333333333333333333333333333333';

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 unregistered authority seed fetch (agent)', () => {
  it('bootstraps a connected replica from a peer-served seed with no ontology copy', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const publisher = await startPublisher('seed-fetch-publisher');
    const receiver = await startAgent({
      name: 'seed-fetch-receiver',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
      },
    });
    const publisherSeeds = installSeedStoreStub(publisher);
    const receiverSeeds = installSeedStoreStub(receiver, { bridgeToOntology: true });
    allowAllNetworkAdmissionForTest(publisher);
    allowAllNetworkAdmissionForTest(receiver);
    await connectBothWays(receiver, publisher);

    const nestedAgent = await publisher.registerAgent('nested-author');
    const nestedOwner = nestedAgent.agentAddress.toLowerCase() as EvmAddressV1;
    const contextGraphId = `${nestedOwner}/seed-fetch` as ContextGraphIdV1;
    await publisher.createContextGraph({
      id: contextGraphId,
      name: 'Seed fetch',
      accessPolicy: 0,
      callerAgentAddress: nestedOwner,
    });
    const expectedSeed = await readOntologySeed(publisher, contextGraphId);
    // The replica starts with no ontology copy and no keyed seed at all.
    await expect(readOntologySeed(receiver, contextGraphId).catch(() => null)).resolves.toBeNull();
    expect(receiverSeeds.seeds.size).toBe(0);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      contextGraphId,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-public',
    });

    // Replica: exactly one verified seed persisted through the F2 contract.
    expect(receiverSeeds.persist).toHaveBeenCalledOnce();
    const persisted = receiverSeeds.persist.mock.calls[0]![0];
    expect(persisted.networkId).toBe(NETWORK_ID);
    expect(persisted.contextGraphId).toBe(contextGraphId);
    expect(Buffer.from(persisted.canonicalEnvelopeBytes).equals(Buffer.from(expectedSeed))).toBe(true);
    expect(receiverSeeds.seeds.size).toBe(1);
    expect((receiver as any).hasAcceptedRfc64UnregisteredAuthorityV1(contextGraphId)).toBe(true);
    expect(resolveFinalized).toHaveBeenCalledTimes(2);
    expect(receiver.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);

    // Provider: keyed store missed, so the deprecated ontology copy of a
    // locally created graph was served once and written through.
    expect(publisherSeeds.read).toHaveBeenCalled();
    expect(publisherSeeds.read.mock.calls[0]![0]).toMatchObject({
      networkId: NETWORK_ID,
      contextGraphId,
    });
    expect(publisherSeeds.persist).toHaveBeenCalledOnce();
    expect(publisherSeeds.seeds.size).toBe(1);
  }, 60_000);

  it('keeps the initial denial when no connected peer holds the seed and never scans a stranger graph', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const bystander = await startAgent({
      name: 'seed-fetch-bystander',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const receiver = await startAgent({
      name: 'seed-fetch-receiver-no-seed',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
      },
    });
    const bystanderSeeds = installSeedStoreStub(bystander);
    const receiverSeeds = installSeedStoreStub(receiver, { bridgeToOntology: true });
    allowAllNetworkAdmissionForTest(bystander);
    allowAllNetworkAdmissionForTest(receiver);
    await connectBothWays(receiver, bystander);
    const bystanderQuery = vi.spyOn(storeOf(bystander), 'query');
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
        VICTIM_CONTEXT_GRAPH_ID,
        { allowSubscriptionFallback: false },
      )).resolves.toMatchObject({
        outcome: 'unavailable',
        source: 'registered-chain',
        reason: 'finalized-name-absence-unaccepted',
      });
    }

    expect(resolveFinalized).toHaveBeenCalledTimes(3);
    expect(receiverSeeds.persist).not.toHaveBeenCalled();
    expect(receiverSeeds.seeds.size).toBe(0);
    // The peer was asked (keyed point lookup) but a graph it neither created
    // nor subscribes to never triggers the deprecated ontology read.
    expect(bystanderSeeds.read).toHaveBeenCalledTimes(3);
    expect(bystanderSeeds.persist).not.toHaveBeenCalled();
    expect(bystanderQuery.mock.calls.some(([sparql]) =>
      sparql.includes(RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1))).toBe(false);
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      VICTIM_CONTEXT_GRAPH_ID,
    )).toBeNull();
    expect(receiver.getSubscribedContextGraphs().has(VICTIM_CONTEXT_GRAPH_ID)).toBe(false);
  }, 60_000);

  it('refuses a wrong-owner seed served by a connected peer and persists nothing', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const attacker = await startAgent({
      name: 'seed-fetch-attacker',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const receiver = await startAgent({
      name: 'seed-fetch-receiver-forged',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
      },
    });
    const receiverSeeds = installSeedStoreStub(receiver, { bridgeToOntology: true });
    allowAllNetworkAdmissionForTest(attacker);
    allowAllNetworkAdmissionForTest(receiver);
    await connectBothWays(receiver, attacker);
    // Raw responder: the attacker bypasses its own provider-side checks and
    // serves a seed it signed itself for the victim's namespace.
    const forged = await mintRfc64UnregisteredReplicaAuthorityEvidenceV1({
      networkId: NETWORK_ID,
      contextGraphId: VICTIM_CONTEXT_GRAPH_ID,
      ownerAddress: ATTACKER,
      accessPolicy: 0,
      publishPolicy: 1,
      publishAuthorityAccountId: '0',
      memberAddresses: [],
      rosterVersion: '0',
      signer: {
        issuer: ATTACKER,
        signDigest: (digest) => ATTACKER_WALLET.signMessage(digest),
      },
    });
    const served = vi.fn(async () => encodeRfc64FoundStatusResponseV1(
      Uint8Array.from(Buffer.from(forged, 'base64url')),
    ));
    attacker.router.unregister(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1);
    attacker.router.register(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1, served);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      VICTIM_CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });

    expect(served).toHaveBeenCalledOnce();
    expect(receiverSeeds.persist).not.toHaveBeenCalled();
    expect(receiverSeeds.seeds.size).toBe(0);
    expect((receiver as any).rfc64PublicCatalogServiceV1.acceptedPolicySnapshot(
      NETWORK_ID,
      VICTIM_CONTEXT_GRAPH_ID,
    )).toBeNull();
    expect(receiver.getSubscribedContextGraphs().has(VICTIM_CONTEXT_GRAPH_ID)).toBe(false);
  }, 60_000);
});

async function startPublisher(name: string): Promise<DKGAgent> {
  return startAgent({
    name,
    config: {
      rfc64CatalogDeploymentProfile: DEPLOYMENT,
      chainAdapter: new NoChainAdapter(),
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:1',
        hubAddress: HUB,
        operationalKeys: [DEFAULT_NODE_WALLET.privateKey],
      },
    },
  });
}

/** Finalized index proves absence; every legacy or point read is a test failure. */
function coldReplicaChainAdapter(resolveFinalized: () => Promise<Map<never, never>>) {
  return Object.assign(new NoChainAdapter(), {
    getContextGraphAuthoritySnapshot: vi.fn(async () => { throw new Error('must not point-read'); }),
    resolveContextGraphIdByNameHash: vi.fn(async () => { throw new Error('must not legacy scalar-read'); }),
    resolveContextGraphIdsByNameHashes: vi.fn(async () => { throw new Error('must not legacy batch-read'); }),
    contextGraphAuthorityIndexRevisionReader: {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
      readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
      whenIdle: vi.fn(async () => undefined),
    },
  });
}

/**
 * In-memory stand-in for the F2 keyed seed store, honouring the F1/F2 contract:
 * `persist` re-verifies the envelope against the wallet prefix and exact scope
 * before writing and throws otherwise; `read` is a point lookup.
 *
 * `bridgeToOntology` is an F1-standalone stand-in only: until F2's
 * keyed-store-first loader lands, reconcile still reads the ontology carrier,
 * so a persisted seed is mirrored where the current loader looks.
 * INTEGRATOR: remove the bridge once F2 is merged.
 */
function installSeedStoreStub(
  agent: DKGAgent,
  options: { readonly bridgeToOntology?: boolean } = {},
) {
  const seeds = new Map<string, Uint8Array>();
  const keyOf = (networkId: string, contextGraphId: string) => `${networkId}\u0000${contextGraphId}`;
  const read = vi.fn(async (input: { networkId: string; contextGraphId: string }) =>
    seeds.get(keyOf(input.networkId, input.contextGraphId)) ?? null);
  const persist = vi.fn(async (input: {
    networkId: string;
    contextGraphId: string;
    canonicalEnvelopeBytes: Uint8Array;
    signal?: AbortSignal;
  }) => {
    await authenticateRfc64UnregisteredAuthorityEnvelopeV1(
      input.canonicalEnvelopeBytes,
      { networkId: input.networkId, contextGraphId: input.contextGraphId } as never,
      verifyControlEnvelopeIssuerSignatureV1,
      input.signal,
    );
    seeds.set(
      keyOf(input.networkId, input.contextGraphId),
      Uint8Array.from(input.canonicalEnvelopeBytes),
    );
    if (options.bridgeToOntology === true) {
      await storeOf(agent).insert([{
        subject: contextGraphDataGraphUri(input.contextGraphId),
        predicate: RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
        object: `"${Buffer.from(input.canonicalEnvelopeBytes).toString('base64url')}"`,
        graph: ONTOLOGY_GRAPH,
      }]);
    }
  });
  Reflect.set(agent, 'readRfc64UnregisteredAuthoritySeedV1', read);
  Reflect.set(agent, 'persistVerifiedRfc64UnregisteredAuthoritySeedV1', persist);
  return { seeds, read, persist };
}

function storeOf(agent: DKGAgent): TripleStore {
  return (agent as unknown as { store: TripleStore }).store;
}

/** The author's ontology literal decoded to canonical bytes; throws when absent. */
async function readOntologySeed(
  agent: DKGAgent,
  contextGraphId: ContextGraphIdV1,
): Promise<Uint8Array> {
  const result = await storeOf(agent).query(
    `SELECT ?evidence WHERE { GRAPH <${ONTOLOGY_GRAPH}> { ` +
    `<${contextGraphDataGraphUri(contextGraphId)}> ` +
    `<${RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1}> ?evidence . } }`,
  );
  if (result.type !== 'bindings' || result.bindings.length !== 1) {
    throw new Error(`expected exactly one ontology seed literal for ${contextGraphId}`);
  }
  const lexical = result.bindings[0]!['evidence']!.match(/^"([A-Za-z0-9_-]+)"/u)?.[1];
  if (lexical === undefined) throw new Error('ontology seed literal is not base64url');
  return Uint8Array.from(Buffer.from(lexical, 'base64url'));
}

function tcpMultiaddr(agent: DKGAgent): string {
  const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return address;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  await a.node.libp2p.dial(multiaddr(tcpMultiaddr(b)));
  await b.node.libp2p.dial(multiaddr(tcpMultiaddr(a)));
}

function allowAllNetworkAdmissionForTest(agent: DKGAgent): void {
  const coordinator = (agent as any).networkAdmissionCoordinator;
  coordinator.isAcceptedPeer = () => true;
  coordinator.isRejectedPeer = () => false;
  coordinator.ensureAdmitted = async () => true;
}
