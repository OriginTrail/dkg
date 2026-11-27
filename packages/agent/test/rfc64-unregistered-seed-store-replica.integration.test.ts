// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

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
import {
  RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
  mintRfc64UnregisteredReplicaAuthoritySeedV1,
} from '../src/rfc64/unregistered-replica-authority-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_DEPLOYMENT as DEPLOYMENT,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
} from './_helpers/rfc64-rollout-agent-harness.js';

const OWNER_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
const DEFAULT_NODE_WALLET = new ethers.Wallet(`0x${'70'.repeat(32)}`);
const CONTEXT_GRAPH_ID = `${OWNER}/seed-store-replica` as ContextGraphIdV1;
const CONTEXT_GRAPH_SUBJECT = contextGraphDataGraphUri(CONTEXT_GRAPH_ID);
const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const ONTOLOGY_SOURCE = 'agent.rfc64.unregisteredReplicaAuthority';
const HUB = '0x3333333333333333333333333333333333333333';

const {
  createDataDir,
  startAgent,
  restartAgent,
  cleanup,
} = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 unregistered authority keyed seed store (agents)', () => {
  it('persists the author-minted seed at create alongside the deprecated ontology literal', async () => {
    const publisher = await startAgent({
      name: 'seed-store-author',
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
    const nestedAgent = await publisher.registerAgent('nested-author');
    const nestedOwner = nestedAgent.agentAddress.toLowerCase() as EvmAddressV1;
    const nestedContextGraphId = `${nestedOwner}/seed-store-create` as ContextGraphIdV1;
    await publisher.createContextGraph({
      id: nestedContextGraphId,
      name: 'Seed store create',
      accessPolicy: 0,
      callerAgentAddress: nestedOwner,
    });

    const result = await storeOf(publisher).query(
      `SELECT ?evidence WHERE { GRAPH <${ONTOLOGY_GRAPH}> { ` +
      `<${contextGraphDataGraphUri(nestedContextGraphId)}> ` +
      `<${RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1}> ?evidence . } }`,
    );
    if (result.type !== 'bindings') throw new Error('expected ontology bindings');
    expect(result.bindings).toHaveLength(1);
    const literal = result.bindings[0]?.['evidence']?.replace(/^"|"$/gu, '');
    expect(literal).toBeDefined();

    const stored = await publisher.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: nestedContextGraphId,
    });
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!).equals(Buffer.from(literal!, 'base64url'))).toBe(true);
    // Non-wallet-namespaced graphs never get a seed row.
    await publisher.createContextGraph({ id: 'seed-store-plain', name: 'Plain', accessPolicy: 0 });
    await expect(publisher.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: 'seed-store-plain',
    })).resolves.toBeNull();
  });

  it('keeps the create durable and warns when the keyed seed row cannot be stored', async () => {
    const publisher = await startAgent({
      name: 'seed-store-author-store-fault',
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
    const nestedAgent = await publisher.registerAgent('nested-author');
    const nestedOwner = nestedAgent.agentAddress.toLowerCase() as EvmAddressV1;
    const nestedContextGraphId = `${nestedOwner}/seed-store-fault` as ContextGraphIdV1;
    const persist = vi.spyOn(publisher, 'persistVerifiedRfc64UnregisteredAuthoritySeedV1')
      .mockRejectedValue(new Error('inventory is closed'));
    const warn = vi.spyOn((publisher as unknown as { log: { warn: (...args: unknown[]) => void } }).log, 'warn');

    await publisher.createContextGraph({
      id: nestedContextGraphId,
      name: 'Seed store fault',
      accessPolicy: 0,
      callerAgentAddress: nestedOwner,
    });

    expect(persist).toHaveBeenCalledOnce();
    expect(warn.mock.calls.some(([, message]) =>
      typeof message === 'string'
      && message.includes(nestedContextGraphId)
      && /not stored in the keyed seed store.*inventory is closed/u.test(message))).toBe(true);
    // The graph exists and its deprecated ontology literal was still written.
    expect(publisher.getSubscribedContextGraphs().has(nestedContextGraphId)).toBe(true);
    const result = await storeOf(publisher).query(
      `SELECT ?evidence WHERE { GRAPH <${ONTOLOGY_GRAPH}> { ` +
      `<${contextGraphDataGraphUri(nestedContextGraphId)}> ` +
      `<${RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1}> ?evidence . } }`,
    );
    expect(result.type === 'bindings' && result.bindings.length).toBe(1);
    persist.mockRestore();
    await expect(publisher.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: nestedContextGraphId,
    })).resolves.toBeNull();
  });

  it('bootstraps replica authority from the keyed store without any ontology copy or scan', async () => {
    const resolveFinalized = vi.fn(async () => new Map());
    const pointRead = vi.fn(async () => { throw new Error('must not point-read'); });
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      getContextGraphAuthoritySnapshot: pointRead,
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveFinalized,
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'seed-store-replica',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const query = vi.spyOn(storeOf(receiver), 'query');
    const seed = await mintSeed();

    // No seed anywhere: the finalized-absence lane stays closed.
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'unavailable',
      source: 'registered-chain',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(ontologyScans(query)).toHaveLength(1);

    // The seed arrives through the keyed store (the F1 peer fetch lands here).
    await receiver.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
    });
    await expect(receiver.resolveContextGraphSubscriptionBootstrapAuthority(
      CONTEXT_GRAPH_ID,
      { allowSubscriptionFallback: false },
    )).resolves.toMatchObject({
      outcome: 'allowed',
      source: 'rfc64-public',
    });
    expect((receiver as any).hasAcceptedRfc64UnregisteredAuthorityV1(CONTEXT_GRAPH_ID)).toBe(true);
    // The store hit made the ontology scan unnecessary.
    expect(ontologyScans(query)).toHaveLength(1);
    expect(pointRead).not.toHaveBeenCalled();
    expect(receiver.getSubscribedContextGraphs().has(CONTEXT_GRAPH_ID)).toBe(false);
  });

  it('re-authenticates the keyed seed after a restart with an empty ontology graph', async () => {
    const dataDir = await createDataDir('seed-store-restart');
    const persistentStorePath = join(dataDir, 'store');
    const chainAdapter = () => Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: vi.fn(async () => new Map()),
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const first = await startAgent({
      name: 'seed-store-restart',
      dataDir,
      persistentStorePath,
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter: chainAdapter() },
    });
    const seed = await mintSeed();
    await first.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
    });

    const restarted = await restartAgent(first, {
      name: 'seed-store-restart',
      dataDir,
      persistentStorePath,
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter: chainAdapter() },
    });
    vi.spyOn(restarted, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const query = vi.spyOn(storeOf(restarted), 'query');
    await expect(restarted.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.not.toBeNull();
    await expect(restarted.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).resolves.toMatchObject({
      source: 'owner-signed-unregistered',
      policyDigest: seed.policyDigest,
      policy: { contextGraphId: CONTEXT_GRAPH_ID, source: { ownerAddress: OWNER } },
    });
    expect(ontologyScans(query)).toHaveLength(0);
  });

  it('writes an ontology-carried seed through to the keyed store on first acceptance', async () => {
    const chainAdapter = Object.assign(new NoChainAdapter(), {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: vi.fn(async () => new Map()),
        readContextGraphAuthorityIndexRevisions: vi.fn(async () => new Map()),
        whenIdle: vi.fn(async () => undefined),
      },
    });
    const receiver = await startAgent({
      name: 'seed-store-write-through',
      config: { rfc64CatalogDeploymentProfile: DEPLOYMENT, chainAdapter },
    });
    vi.spyOn(receiver, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    const seed = await mintSeed();
    // DEPRECATED carrier only: the legacy ontology literal.
    await storeOf(receiver).insert([{
      subject: CONTEXT_GRAPH_SUBJECT,
      predicate: RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
      object: `"${seed.evidence}"`,
      graph: ONTOLOGY_GRAPH,
    }]);
    await expect(receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();

    const query = vi.spyOn(storeOf(receiver), 'query');
    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).resolves.toMatchObject({ source: 'owner-signed-unregistered', policyDigest: seed.policyDigest });
    expect(ontologyScans(query)).toHaveLength(1);
    const stored = await receiver.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    expect(Buffer.from(stored!).equals(Buffer.from(seed.canonicalEnvelopeBytes))).toBe(true);

    // Subsequent reconciles are point lookups.
    await expect(receiver.reconcileRfc64CatalogAccessAuthorityV1(
      CONTEXT_GRAPH_ID,
      undefined,
      { kind: 'finalized-absence' },
    )).resolves.toMatchObject({ source: 'owner-signed-unregistered' });
    expect(ontologyScans(query)).toHaveLength(1);
  });
});

function storeOf(agent: DKGAgent): TripleStore {
  return (agent as unknown as { store: TripleStore }).store;
}

function ontologyScans(query: ReturnType<typeof vi.spyOn>): unknown[] {
  return query.mock.calls.filter(
    (call) => (call[1] as { source?: string } | undefined)?.source === ONTOLOGY_SOURCE,
  );
}

async function mintSeed() {
  return mintRfc64UnregisteredReplicaAuthoritySeedV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: OWNER,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: OWNER,
      signDigest: (digest) => OWNER_WALLET.signMessage(digest),
    },
  });
}
