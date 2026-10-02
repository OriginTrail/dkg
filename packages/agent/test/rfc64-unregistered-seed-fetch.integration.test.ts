// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-level acceptance for the RFC-64 unregistered-authority seed fetch,
 * end to end through the REAL keyed seed store on both agents: a replica that
 * holds NO copy of the owner-signed seed obtains it from a connected peer
 * during subscription bootstrap, persists it through the keyed store, and its
 * bootstrap authority becomes allowed through the existing finalized-absence
 * reconcile. Twins pin the closed outcomes (no peer holds the seed; a peer
 * serves a forged seed) and the ordering fences: local state reconciles FIRST,
 * so a replica that already holds the seed (keyed row or deprecated ontology
 * copy) never fans out, even with a restart-sized budget and a hanging peer.
 */
import { multiaddr } from '@multiformats/multiaddr';
import {
  contextGraphDataGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
  type ContextGraphIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import { CHAIN_POLICY_READ_TIMEOUT_MS } from '../src/dkg-agent-constants.js';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';
import { Rfc64SeedFetchMethods } from '../src/dkg-agent-rfc64-seed-fetch.js';
import { encodeRfc64FoundStatusResponseV1 } from
  '../src/rfc64/catalog-transport-wire-v1-internal.js';
import { RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1 } from
  '../src/rfc64/unregistered-authority-transport-v1.js';
import {
  RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
  mintRfc64UnregisteredReplicaAuthorityEvidenceV1,
  mintRfc64UnregisteredReplicaAuthoritySeedV1,
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
const SERVE_SOURCE = 'agent.rfc64.unregisteredAuthoritySeedServe';
const HUB = '0x3333333333333333333333333333333333333333';

const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 unregistered authority seed fetch (agent)', () => {
  it('bootstraps a connected replica from a peer-served seed with no local copy, through the real keyed store', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const publisher = await startPublisher('seed-fetch-publisher');
    const receiver = await startAgent({
      name: 'seed-fetch-receiver',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
      },
    });
    const publisherSeeds = spySeedStore(publisher);
    const receiverSeeds = spySeedStore(receiver);
    const publisherQuery = vi.spyOn(storeOf(publisher), 'query');
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
    // The author's seed sits in its REAL keyed store (written at create) and,
    // for older peers, as the deprecated ontology literal; both agree.
    const expectedSeed = await publisher.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId,
    });
    expect(expectedSeed).not.toBeNull();
    expect(Buffer.from(expectedSeed!).equals(Buffer.from(await readOntologySeed(publisher, contextGraphId)))).toBe(true);
    // The replica starts with no ontology copy and no keyed seed at all.
    await expect(readOntologySeed(receiver, contextGraphId).catch(() => null)).resolves.toBeNull();
    await expect(receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId,
    })).resolves.toBeNull();
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);

    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      contextGraphId,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-public',
    });

    // Replica: exactly one verified seed persisted through the real keyed
    // store, and the store now returns the author's exact canonical bytes.
    expect(receiverSeeds.persist).toHaveBeenCalledOnce();
    const persisted = receiverSeeds.persist.mock.calls[0]![0];
    expect(persisted.networkId).toBe(NETWORK_ID);
    expect(persisted.contextGraphId).toBe(contextGraphId);
    expect(Buffer.from(persisted.canonicalEnvelopeBytes).equals(Buffer.from(expectedSeed!))).toBe(true);
    const stored = await receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId,
    });
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!).equals(Buffer.from(expectedSeed!))).toBe(true);
    expect((receiver as any).hasAcceptedRfc64UnregisteredAuthorityV1(contextGraphId)).toBe(true);
    // Initial denial, then the post-acceptance re-resolve: no extra chain read
    // is spent deciding whether to fan out.
    expect(resolveFinalized).toHaveBeenCalledTimes(2);
    expect(receiver.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);

    // Provider: the keyed store was hit for the exact scope, so the deprecated
    // ontology fallback was never consulted and nothing was written through.
    expect(publisherSeeds.read).toHaveBeenCalled();
    expect(publisherSeeds.read.mock.calls[0]![0]).toMatchObject({
      networkId: NETWORK_ID,
      contextGraphId,
    });
    expect(publisherQuery.mock.calls.some(
      ([, options]) => (options as { source?: string } | undefined)?.source === SERVE_SOURCE,
    )).toBe(false);
    // The author's own persist happened once, at create, before any peer asked.
    expect(publisherSeeds.persist).toHaveBeenCalledOnce();
  }, 60_000);

  it('never fans out when the seed is already held locally, even under a restart budget with a hanging peer', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const hangingPeer = await startAgent({
      name: 'seed-fetch-hanging-peer',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT },
    });
    const receiver = await startAgent({
      name: 'seed-fetch-receiver-local-copy',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
      },
    });
    allowAllNetworkAdmissionForTest(hangingPeer);
    allowAllNetworkAdmissionForTest(receiver);
    await connectBothWays(receiver, hangingPeer);
    // Raw responder that never answers: if the replica ever asked, the 2.5 s
    // budget below would be consumed on the network.
    const served = vi.fn((_data: Uint8Array, _peer: unknown, options?: { signal?: AbortSignal }) =>
      new Promise<Uint8Array>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      }));
    hangingPeer.router.unregister(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1);
    hangingPeer.router.register(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1, served);
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const fanOut = vi.spyOn(receiver, 'fetchRfc64UnregisteredAuthoritySeedFromPeersV1');
    const seed = await mintVictimSeed();

    // Deprecated ontology copy only (a replica that received the seed through
    // legacy ontology sync): reconciles locally, writes through, never asks.
    await storeOf(receiver).insert([{
      subject: contextGraphDataGraphUri(VICTIM_CONTEXT_GRAPH_ID),
      predicate: RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
      object: `"${seed.evidence}"`,
      graph: ONTOLOGY_GRAPH,
    }]);
    await expect(receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: VICTIM_CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
    const startedAt = Date.now();
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      VICTIM_CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false, signal: AbortSignal.timeout(CHAIN_POLICY_READ_TIMEOUT_MS) },
    )).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-public',
    });
    expect(Date.now() - startedAt).toBeLessThan(CHAIN_POLICY_READ_TIMEOUT_MS);
    expect(fanOut).not.toHaveBeenCalled();
    expect(served).not.toHaveBeenCalled();
    const stored = await receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: VICTIM_CONTEXT_GRAPH_ID,
    });
    expect(Buffer.from(stored!).equals(Buffer.from(seed.canonicalEnvelopeBytes))).toBe(true);

    // Keyed row only (a fresh graph on a peer that already fetched once):
    // the same admission is a point lookup and again never asks.
    const keyedContextGraphId = `${VICTIM}/seed-fetch-keyed` as ContextGraphIdV1;
    const other = await mintVictimSeed(keyedContextGraphId);
    await receiver.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: keyedContextGraphId,
      canonicalEnvelopeBytes: other.canonicalEnvelopeBytes,
    });
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      keyedContextGraphId,
      { allowSubscriptionFallback: false, signal: AbortSignal.timeout(CHAIN_POLICY_READ_TIMEOUT_MS) },
    )).resolves.toMatchObject({ outcome: 'allowed', source: 'rfc64-public' });
    expect(fanOut).not.toHaveBeenCalled();
    expect(served).not.toHaveBeenCalled();
    expect(receiver.getSubscribedContextGraphs().has(VICTIM_CONTEXT_GRAPH_ID)).toBe(false);
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
    const bystanderSeeds = spySeedStore(bystander);
    const receiverSeeds = spySeedStore(receiver);
    allowAllNetworkAdmissionForTest(bystander);
    allowAllNetworkAdmissionForTest(receiver);
    await connectBothWays(receiver, bystander);
    const bystanderQuery = vi.spyOn(storeOf(bystander), 'query');
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const fanOut = vi.spyOn(receiver, 'fetchRfc64UnregisteredAuthoritySeedFromPeersV1');

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

    // Local reconcile failed for lack of a seed, so every attempt fanned out
    // once; a miss keeps the initial denial without a further chain read.
    expect(fanOut).toHaveBeenCalledTimes(3);
    for (const call of fanOut.mock.results) await expect(call.value).resolves.toBe('not-found');
    expect(resolveFinalized).toHaveBeenCalledTimes(3);
    expect(receiverSeeds.persist).not.toHaveBeenCalled();
    await expect(receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: VICTIM_CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
    // The peer was asked (keyed point lookup) but a graph it neither created,
    // subscribes to nor hosts never triggers the deprecated ontology read.
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

  it('keeps the initial denial when a fetched seed cannot be persisted, and never reconciles on an exhausted budget', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const publisher = await startPublisher('seed-fetch-publisher-store-fault');
    const receiver = await startAgent({
      name: 'seed-fetch-receiver-store-fault',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
      },
    });
    allowAllNetworkAdmissionForTest(publisher);
    allowAllNetworkAdmissionForTest(receiver);
    await connectBothWays(receiver, publisher);
    const nestedAgent = await publisher.registerAgent('nested-author');
    const nestedOwner = nestedAgent.agentAddress.toLowerCase() as EvmAddressV1;
    const contextGraphId = `${nestedOwner}/seed-fetch-store-fault` as ContextGraphIdV1;
    await publisher.createContextGraph({
      id: contextGraphId,
      name: 'Seed fetch store fault',
      accessPolicy: 0,
      callerAgentAddress: nestedOwner,
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const reconcile = vi.spyOn(receiver, 'reconcileRfc64CatalogAccessAuthorityV1');
    const fanOut = vi.spyOn(receiver, 'fetchRfc64UnregisteredAuthoritySeedFromPeersV1');

    // The peer serves a valid seed but the replica's keyed store refuses the
    // write: the fetch fails, nothing is accepted, the initial denial stands.
    const persist = vi.spyOn(receiver, 'persistVerifiedRfc64UnregisteredAuthoritySeedV1')
      .mockRejectedValue(new Error('inventory is closed'));
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      contextGraphId,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(fanOut).toHaveBeenCalledOnce();
    await expect(fanOut.mock.results[0]!.value).rejects.toThrow(/inventory is closed/u);
    expect(persist).toHaveBeenCalledOnce();
    // Local reconcile ran once (no seed); the failed fetch never triggered a second.
    expect(reconcile).toHaveBeenCalledOnce();
    expect(resolveFinalized).toHaveBeenCalledTimes(1);
    expect((receiver as any).hasAcceptedRfc64UnregisteredAuthorityV1(contextGraphId)).toBe(false);
    persist.mockRestore();
    reconcile.mockClear();
    fanOut.mockClear();

    // The caller's budget expires during the fan-out: even though a seed was
    // obtained, no reconcile runs on the aborted signal and the caller sees
    // the bounded-operation failure, never an admission.
    const controller = new AbortController();
    fanOut.mockImplementation(async (id: string, signal?: AbortSignal) => {
      const outcome = await Rfc64SeedFetchMethods.prototype.fetchRfc64UnregisteredAuthoritySeedFromPeersV1
        .call(receiver, id, signal);
      controller.abort(new Error('bootstrap budget exhausted'));
      return outcome;
    });
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      contextGraphId,
      { allowSubscriptionFallback: false, signal: controller.signal },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'chain-name-binding-unavailable',
    });
    expect(fanOut).toHaveBeenCalledOnce();
    await expect(fanOut.mock.results[0]!.value).resolves.toBe('fetched');
    // Let any (wrong) continuation past the abort guard surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reconcile).toHaveBeenCalledOnce();
    // The seed itself was persisted (it is authenticated data, not authority)
    // but acceptance never happened on the exhausted budget.
    await expect(receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId,
    })).resolves.not.toBeNull();
    expect((receiver as any).hasAcceptedRfc64UnregisteredAuthorityV1(contextGraphId)).toBe(false);
    expect(receiver.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
  }, 60_000);

  it('keeps the initial denial when the reconcile fences refuse a fetched seed: fetching is never acceptance', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const publisher = await startPublisher('seed-fetch-publisher-fence');
    const receiver = await startAgent({
      name: 'seed-fetch-receiver-fence',
      config: {
        rfc64CatalogDeploymentProfile: DEPLOYMENT,
        chainAdapter: coldReplicaChainAdapter(resolveFinalized),
      },
    });
    allowAllNetworkAdmissionForTest(publisher);
    allowAllNetworkAdmissionForTest(receiver);
    await connectBothWays(receiver, publisher);
    const nestedAgent = await publisher.registerAgent('nested-author');
    const nestedOwner = nestedAgent.agentAddress.toLowerCase() as EvmAddressV1;
    const contextGraphId = `${nestedOwner}/seed-fetch-fence` as ContextGraphIdV1;
    await publisher.createContextGraph({
      id: contextGraphId,
      name: 'Seed fetch fence',
      accessPolicy: 0,
      callerAgentAddress: nestedOwner,
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const fanOut = vi.spyOn(receiver, 'fetchRfc64UnregisteredAuthoritySeedFromPeersV1');
    // First reconcile is the real one (no seed yet); the post-fetch reconcile
    // stands in for any acceptance fence refusing the just-fetched seed (a
    // revision moved, a late chain binding, an exact-shape mismatch).
    const reconcile = vi.spyOn(receiver, 'reconcileRfc64CatalogAccessAuthorityV1')
      .mockImplementationOnce((...args) =>
        Rfc64CatalogMethods.prototype.reconcileRfc64CatalogAccessAuthorityV1.apply(receiver, args))
      .mockImplementationOnce(async () => {
        throw new Error('acceptance fence refused the fetched seed');
      });

    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      contextGraphId,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });

    expect(fanOut).toHaveBeenCalledOnce();
    await expect(fanOut.mock.results[0]!.value).resolves.toBe('fetched');
    expect(reconcile).toHaveBeenCalledTimes(2);
    // Denied without a further chain read; the seed is stored data, not authority.
    expect(resolveFinalized).toHaveBeenCalledTimes(1);
    await expect(receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId,
    })).resolves.not.toBeNull();
    expect((receiver as any).hasAcceptedRfc64UnregisteredAuthorityV1(contextGraphId)).toBe(false);
    expect(receiver.getSubscribedContextGraphs().has(contextGraphId)).toBe(false);
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
    const receiverSeeds = spySeedStore(receiver);
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
    await expect(receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: VICTIM_CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
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

/** Call-through spies on the REAL keyed seed store methods of one agent. */
function spySeedStore(agent: DKGAgent) {
  return {
    read: vi.spyOn(agent, 'readRfc64UnregisteredAuthoritySeedV1'),
    persist: vi.spyOn(agent, 'persistVerifiedRfc64UnregisteredAuthoritySeedV1'),
  };
}

async function mintVictimSeed(contextGraphId: ContextGraphIdV1 = VICTIM_CONTEXT_GRAPH_ID) {
  return mintRfc64UnregisteredReplicaAuthoritySeedV1({
    networkId: NETWORK_ID,
    contextGraphId,
    ownerAddress: VICTIM,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: VICTIM,
      signDigest: (digest) => VICTIM_WALLET.signMessage(digest),
    },
  });
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
