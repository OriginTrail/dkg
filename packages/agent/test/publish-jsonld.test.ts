import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent, type DKGAgentConfig } from '../src/index.js';
import {
  GraphManager,
  OxigraphStore,
  PrivateContentStore,
  SharedMemoryLiteralBlobStore,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type KnowledgeAssetVmPublishRequest,
  type LiftJob,
} from '@origintrail-official/dkg-publisher';
import {
  DKG_ONTOLOGY,
  MemoryLayer,
  SYSTEM_CONTEXT_GRAPHS,
  buildAuthorAttestationTypedData,
  contextGraphDataGraphUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

const agents: DKGAgent[] = [];
const stores: TripleStore[] = [];
const tempDataDirs: string[] = [];
const CHAIN_JSONLD_TIMEOUT_MS = 120_000;

async function createTempDataDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDataDirs.push(dir);
  return dir;
}

async function createAgent(name: string, overrides: Partial<DKGAgentConfig> = {}) {
  const store = overrides.store ?? new OxigraphStore();
  const agent = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
    name,
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
    ...overrides,
    store,
  });
  agents.push(agent);
  stores.push(store);
  await agent.start();
  await installHardhatACKProvider(agent);
  return { agent, store };
}

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch { /* teardown best-effort */ }
  }
  agents.length = 0;
  stores.length = 0;
  for (const dir of tempDataDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function expectQueuedKaRequest(job: LiftJob | null): KnowledgeAssetVmPublishRequest {
  expect(job?.request.jobType).toBe('knowledge-asset-vm-publish');
  if (!job || job.request.jobType !== 'knowledge-asset-vm-publish') {
    throw new Error('Expected a graph-scoped Knowledge Asset VM publish job');
  }
  return job.request.knowledgeAssetVmPublish;
}

describe('publishJsonLd', () => {
  it('uses the override store for agent writes and helper bookkeeping', async () => {
    const overrideStore = new SharedMemoryLiteralBlobStore(new OxigraphStore(), {
      blobDir: await createTempDataDir('dkg-agent-override-store-blobs-'),
      thresholdBytes: 65_536,
    });

    const { agent, store } = await createAgent('OverrideStoreBot', { store: overrideStore });

    expect(store).toBe(overrideStore);
    await agent.createContextGraph({ id: 'override-store-observable', name: 'OverrideStoreObservable', description: '' });

    const result = await store.query(`
      ASK {
        GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> {
          <${contextGraphDataGraphUri('override-store-observable')}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}>
        }
      }
    `);
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(true);
    }
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('bare JSON-LD doc defaults to private quads (with synthetic public anchor)', async () => {
    const { agent, store } = await createAgent('BarePrivateBot');
    await agent.createContextGraph({ id: 'bare-priv', name: 'BP', description: '' });
    await agent.registerContextGraph('bare-priv');

    const result = await agent.publish('bare-priv', {
      '@context': 'http://schema.org/',
      '@id': 'http://example.org/Alice',
      '@type': 'Person',
      'name': 'Alice',
    });
    expect(result.status).toBe('confirmed');

    // rc.17 uniform layout: a confirmed publish lands the public payload in the
    // per-KA …/_verifiable_memory/{author}/{number} graph, not the legacy root
    // data graph. Read-both (root OR the _verifiable_memory/ prefix, excluding the
    // transient staging graphs) mirrors the production verifiable-memory read path.
    const publicResult = await store.query(
      `ASK { GRAPH ?g { ?s ?p ?o }
        FILTER((STRSTARTS(STR(?g), "did:dkg:context-graph:bare-priv/_verifiable_memory/") && !CONTAINS(STR(?g), "/staging/")) || STR(?g) = "did:dkg:context-graph:bare-priv") }`,
    );
    expect(publicResult.type).toBe('boolean');
    if (publicResult.type === 'boolean') {
      expect(publicResult.value).toBe(true);
    }
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('envelope { public } puts quads in public set', async () => {
    const { agent, store } = await createAgent('PubEnvBot');
    await agent.createContextGraph({ id: 'pub-env', name: 'PE', description: '' });
    await agent.registerContextGraph('pub-env');

    const result = await agent.publish('pub-env', {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Bob',
        '@type': 'Person',
        'name': 'Bob',
      },
    });
    expect(result.status).toBe('confirmed');

    // rc.17 uniform layout: confirmed public quads land in the per-KA
    // …/_verifiable_memory/{author}/{number} graph. Read-both (root OR the
    // _verifiable_memory/ prefix, minus staging) matches the production read path.
    const askResult = await store.query(
      `ASK { GRAPH ?g { <http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Person> }
        FILTER((STRSTARTS(STR(?g), "did:dkg:context-graph:pub-env/_verifiable_memory/") && !CONTAINS(STR(?g), "/staging/")) || STR(?g) = "did:dkg:context-graph:pub-env") }`,
    );
    expect(askResult.type).toBe('boolean');
    if (askResult.type === 'boolean') {
      expect(askResult.value).toBe(true);
    }
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('envelope { public, private } splits quads correctly', async () => {
    const { agent, store } = await createAgent('SplitBot');
    await agent.createContextGraph({ id: 'split-test', name: 'Split', description: '' });
    await agent.registerContextGraph('split-test');

    const result = await agent.publish('split-test', {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Carol',
        '@type': 'Person',
        'name': 'Carol',
      },
      private: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Carol',
        'email': 'carol@example.org',
      },
    });
    expect(result.status).toBe('confirmed');

    const publicName = await store.query(
      `ASK { GRAPH ?g { <http://example.org/Carol> <http://schema.org/name> ?name }
        FILTER((STRSTARTS(STR(?g), "did:dkg:context-graph:split-test/_verifiable_memory/") && !CONTAINS(STR(?g), "/staging/")) || STR(?g) = "did:dkg:context-graph:split-test") }`,
    );
    expect(publicName.type).toBe('boolean');
    if (publicName.type === 'boolean') expect(publicName.value).toBe(true);

    expect(result.contentScopeVersion).toBe(2);
    expect(result.assertionVersion).toBeDefined();
    const privatePayload = await new PrivateContentStore(
      store,
      new GraphManager(store),
    ).getKnowledgeAssetPrivateTriples(
      'split-test',
      createGraphKnowledgeAssetScope(result.ual, result.assertionVersion!),
    );
    expect(privatePayload.some(
      (quad) => quad.subject === 'http://example.org/Carol'
        && quad.predicate === 'http://schema.org/email'
        && quad.object === '"carol@example.org"',
    )).toBe(true);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('private-only envelope generates synthetic public anchor', async () => {
    const { agent, store } = await createAgent('PrivOnlyBot');
    await agent.createContextGraph({ id: 'priv-only', name: 'PO', description: '' });
    await agent.registerContextGraph('priv-only');

    const result = await agent.publish('priv-only', {
      private: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Secret',
        '@type': 'Thing',
        'name': 'Top Secret',
      },
    });
    expect(result.status).toBe('confirmed');

    // rc.17 uniform layout: the synthetic public anchor is published into the
    // per-KA …/_verifiable_memory/{author}/{number} graph. Read-both (root OR the
    // _verifiable_memory/ prefix, minus staging) matches the production read path.
    const anchorResult = await store.query(
      `ASK { GRAPH ?g { ?s ?p ?o }
        FILTER((STRSTARTS(STR(?g), "did:dkg:context-graph:priv-only/_verifiable_memory/") && !CONTAINS(STR(?g), "/staging/")) || STR(?g) = "did:dkg:context-graph:priv-only") }`,
    );
    expect(anchorResult.type).toBe('boolean');
    if (anchorResult.type === 'boolean') expect(anchorResult.value).toBe(true);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('preserves typed literals in quad objects', async () => {
    const { agent, store } = await createAgent('LiteralBot');
    await agent.createContextGraph({ id: 'literal-test', name: 'Lit', description: '' });

    await agent.publish('literal-test', {
      public: {
        '@context': {
          'schema': 'http://schema.org/',
          'xsd': 'http://www.w3.org/2001/XMLSchema#',
        },
        '@id': 'http://example.org/Event1',
        '@type': 'schema:Event',
        'schema:startDate': {
          '@value': '2024-01-01T00:00:00Z',
          '@type': 'xsd:dateTime',
        },
      },
    });

    const dateResult = await store.query(
      `SELECT ?d WHERE { GRAPH <did:dkg:context-graph:literal-test> { <http://example.org/Event1> <http://schema.org/startDate> ?d } }`,
    );
    expect(dateResult.type).toBe('bindings');
    if (dateResult.type === 'bindings') {
      expect(dateResult.bindings.length).toBeGreaterThan(0);
      expect(dateResult.bindings[0].d).toContain('2024-01-01T00:00:00Z');
    }
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('throws on JSON-LD that produces no quads', async () => {
    const { agent } = await createAgent('ErrorBot');
    await agent.createContextGraph({ id: 'error-test', name: 'Err', description: '' });

    await expect(agent.publish('error-test', {})).rejects.toThrow(
      'JSON-LD document produced no RDF quads',
    );
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('existing Quad[] publish still works unchanged', async () => {
    const { agent } = await createAgent('QuadBot');
    await agent.createContextGraph({ id: 'quad-test', name: 'QT', description: '' });
    await agent.registerContextGraph('quad-test');

    const result = await agent.publish('quad-test', [
      { subject: 'did:dkg:test:X', predicate: 'http://schema.org/name', object: '"X"', graph: '' },
    ]);
    expect(result.status).toBe('confirmed');
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('stamps configured publisher.maxRetries onto agent publishAsync jobs (EPCIS/Kafka path, #1836)', async () => {
    // #1836 — the agent's own publishAsync (used by the EPCIS/Kafka plugins) must
    // stamp the operator-configured retry budget onto the queued job, not fall
    // back to the publisher default. Reverting publishAsync to construct
    // TripleStoreAsyncLiftPublisher without maxRetries makes this assert 10.
    const { agent, store } = await createAgent('AsyncMaxRetriesBot', { publisherMaxRetries: 0 });
    await agent.createContextGraph({ id: 'async-maxretries', name: 'AsyncMaxRetries', description: '' });
    await agent.registerContextGraph('async-maxretries');
    let releaseShadow!: () => void;
    const deferredShadow = new Promise<void>((resolve) => { releaseShadow = resolve; });
    const shadow = vi
      .spyOn(agent, 'recordRfc64SwmAuthorInventoryShadowV1')
      .mockImplementation(async () => {
        await deferredShadow;
        return {
          status: 'dormant',
          action: 'upsert',
          attempts: 0,
          headObjectDigest: null,
          error: null,
        };
      });

    const { captureID } = await Promise.race([
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-maxretries',
        {
          private: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/AsyncMaxRetries',
            '@type': 'Thing',
            'name': 'Async MaxRetries',
          },
        },
        { localOnly: true },
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('publishAsync waited for shadow observer')), 2_000);
      }),
    ]);

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(job?.retries.maxRetries).toBe(0);
    expect(shadow).toHaveBeenCalledOnce();
    expect(shadow).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: 'async-maxretries',
      assertionCoordinate: expect.any(String),
      lifecycleAgentAddress: expect.any(String),
      shareOperationId: expect.any(String),
    }));
    expect(agent.inFlightRfc64SwmInventoryObserverCountV1()).toBe(1);
    releaseShadow();
    await agent.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(agent.inFlightRfc64SwmInventoryObserverCountV1()).toBe(0);
    shadow.mockRestore();
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('gives every publishAsync job an admission OWNER, and never the author (3825162149)', async () => {
    // 3825162149 — ownership is the sole authorization for the by-id force-clear that releases a
    // `retry_recovery` job automatic recovery cannot settle. This path (EPCIS / Kafka plugins) did
    // not stamp one, so its jobs had no manual exit and would occupy their lifecycle subject
    // permanently. Only the daemon's knowledge-assets route stamped an owner.
    const { agent, store } = await createAgent('AsyncAdmissionOwnerBot');
    await agent.createContextGraph({ id: 'async-admission', name: 'AsyncAdmission', description: '' });
    await agent.registerContextGraph('async-admission');
    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const content = (name: string) => ({
      private: {
        '@context': 'http://schema.org/',
        '@id': `http://example.org/${name}`,
        '@type': 'Thing',
        'name': name,
      },
    });

    // An INTERNAL producer supplies no principal: the node's own default agent owns the job, the
    // same identity a node-level token resolves to in the daemon, so the operator keeps the exit.
    // 3829782408 — the CANONICAL node identity, which is what the daemon resolves a node-level
    // token to, so the recorded owner is the one that token can present. It always yields a
    // string (default agent, else this node's peer id), which is what makes an unowned job
    // unrepresentable rather than merely unlikely.
    const nodeOwner = agent.resolveAgentAddress(undefined);
    expect(typeof nodeOwner).toBe('string');
    expect(nodeOwner.length).toBeGreaterThan(0);
    const internal = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-admission',
      content('AsyncAdmissionInternal'),
      { localOnly: true },
    );
    const internalJob = await asyncPublisher.getStatus(internal.captureID);
    expect(internalJob?.admission?.byAgentAddress).toBe(nodeOwner);

    // 3829948739 — the row above cannot fail for the branch this change actually ADDED. On this
    // fixture a default agent always exists, so `resolveAgentAddress(undefined)` and the old
    // `getDefaultAgentAddress()` return the same value: reverting to the optional owner would
    // leave it green. Removing the default agent is what separates them, and a node-admitted job
    // must STILL be owned — by this node's peer id — rather than enqueued unowned.
    // The field, not the accessor: `resolveAgentAddress` reads `defaultAgentAddress` directly,
    // so spying on `getDefaultAgentAddress` would not reach the branch under test.
    const withDefault = (agent as unknown as { defaultAgentAddress?: string });
    const savedDefault = withDefault.defaultAgentAddress;
    withDefault.defaultAgentAddress = undefined;
    try {
      expect(agent.resolveAgentAddress(undefined)).toBe(agent.peerId);
      const peerFallback = await agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-admission',
        content('AsyncAdmissionPeerFallback'),
        { localOnly: true },
      );
      const peerJob = await asyncPublisher.getStatus(peerFallback.captureID);
      expect(peerJob?.admission?.byAgentAddress).toBe(agent.peerId);
      expect(peerJob?.admission?.byAgentAddress).toBeTruthy();
    } finally {
      withDefault.defaultAgentAddress = savedDefault;
    }

    // A host that AUTHENTICATED a caller supplies it, and that principal wins.
    const EPCIS_CALLER = '0x00000000000000000000000000000000000000e1';
    const authenticated = await agent.publishAsync(
      { kind: 'agent', agentAddress: EPCIS_CALLER },
      'did:dkg:context-graph:async-admission',
      content('AsyncAdmissionAuthenticated'),
      { localOnly: true },
    );
    const authenticatedJob = await asyncPublisher.getStatus(authenticated.captureID);
    expect(authenticatedJob?.admission?.byAgentAddress).toBe(EPCIS_CALLER);

    // 3829496422 — a blank agent identity now REJECTS rather than falling back to the node.
    // Silently substituting the node owner for a caller that claimed to have an authenticated
    // identity hands the destructive force-clear to an agent that did not submit the job; a host
    // with no principal is expected to say `{ kind: 'node' }` instead.
    for (const blank of ['', '   ']) {
      await expect(agent.publishAsync(
        { kind: 'agent', agentAddress: blank },
        'did:dkg:context-graph:async-admission',
        content(`AsyncAdmissionBlank${blank.length}`),
        { localOnly: true },
      )).rejects.toThrow(/non-blank agentAddress/);
    }

    // 3829656449 — the admission object belongs to the CALLER, and publishing suspends on many
    // awaits. Re-reading it at enqueue let a caller pass validation as one identity and have a
    // different one persisted. The owner is captured before the first await, so mutating the
    // object mid-flight changes nothing.
    const mutable = { kind: 'agent' as const, agentAddress: EPCIS_CALLER };
    const pending = agent.publishAsync(
      mutable,
      'did:dkg:context-graph:async-admission',
      content('AsyncAdmissionMutated'),
      { localOnly: true },
    );
    mutable.agentAddress = '   ';          // would have blanked the owner
    const mutatedJob = await asyncPublisher.getStatus((await pending).captureID);
    expect(mutatedJob?.admission?.byAgentAddress).toBe(EPCIS_CALLER);

    // 3829656707 — the forged-owner path, against the REAL publish method rather than a mock. A
    // legacy `admittedByAgentAddress` in the options bag must lose to the declared admission; the
    // Kafka unit test could not prove this, because the decision lives here.
    const ATTACKER = '0x00000000000000000000000000000000000000ff';
    const forged = await agent.publishAsync(
      { kind: 'agent', agentAddress: EPCIS_CALLER },
      'did:dkg:context-graph:async-admission',
      content('AsyncAdmissionForged'),
      { localOnly: true, admittedByAgentAddress: ATTACKER } as never,
    );
    const forgedJob = await asyncPublisher.getStatus(forged.captureID);
    expect(forgedJob?.admission?.byAgentAddress).toBe(EPCIS_CALLER);
    expect(JSON.stringify(forgedJob)).not.toContain(ATTACKER);

    // The discriminating half: the owner is NOT the author. Under curated publishing the signer
    // may be a third party who enqueued nothing, and handing them a destructive clear would give
    // the double-publish decision to someone who never asked for the publish.
    const request = authenticatedJob?.request as { knowledgeAssetVmPublish?: { agentAddress?: string } };
    const author = request?.knowledgeAssetVmPublish?.agentAddress;
    expect(author).toBeTruthy();
    expect(author?.toLowerCase()).not.toBe(EPCIS_CALLER.toLowerCase());
    // ...and the principal did not leak into the operation payload either.
    expect(request?.knowledgeAssetVmPublish).not.toHaveProperty('admittedByAgentAddress');
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async private-only JSON-LD enqueues one rootless KA with one non-root challenge anchor', async () => {
    const { agent, store } = await createAgent('AsyncPrivateOnlyBot');
    await agent.createContextGraph({ id: 'async-priv-only', name: 'AsyncPrivateOnly', description: '' });
    await agent.registerContextGraph('async-priv-only');
    const root = 'http://example.org/AsyncSecret';

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-priv-only',
      {
        private: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Private Async',
        },
      },
      {
        localOnly: true,
        accessPolicy: 'allowList',
        allowedPeers: [' peer-b ', 'peer-a', 'peer-b'],
      },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectQueuedKaRequest(job);
    expect(request.roots).toEqual([]);
    expect(request.contentScopeVersion).toBe(2);
    expect(request.kaUal).toMatch(/^did:dkg:[^/]+\/0x[0-9a-f]{40}\/\d+$/);
    expect(request.accessPolicy).toBe('allowList');
    expect(request.allowedPeers).toEqual(['peer-a', 'peer-b']);
    // #1836 — with publisherMaxRetries unset the agent path keeps the publisher default.
    expect(job?.retries.maxRetries).toBe(10);
    // With a positive public challenge leaf the local queue may complete and
    // clean its mutable assertion lifecycle immediately. The immutable queued
    // request above is the durable contract; do not race cleanup by resolving
    // the already-promoted lifecycle a second time.
    // Keep this resilient to control-plane tuning (defaults changed in main).
    expect(job?.retries.maxRetries).toBeGreaterThan(0);

    const scope = createGraphKnowledgeAssetScope(request.kaUal!, request.assertionVersion!);
    const swmGraph = knowledgeAssetLayerGraphUri(
      'async-priv-only',
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const publicAnchor = await store.query(
      `ASK { GRAPH <${swmGraph}> { <${root}> <http://dkg.io/ontology/privateDataAnchor> "true" } }`,
    );
    expect(publicAnchor.type).toBe('boolean');
    if (publicAnchor.type === 'boolean') expect(publicAnchor.value).toBe(false);

    const challengeAnchor = await store.query(
      `ASK { GRAPH <${swmGraph}> { ?anchor <http://dkg.io/ontology/privateDataAnchor> "true" } }`,
    );
    expect(challengeAnchor.type).toBe('boolean');
    if (challengeAnchor.type === 'boolean') expect(challengeAnchor.value).toBe(true);

    const publicPayload = await store.query(
      `ASK { GRAPH <${swmGraph}> { <${root}> <http://schema.org/name> "Private Async" } }`,
    );
    expect(publicPayload.type).toBe('boolean');
    if (publicPayload.type === 'boolean') expect(publicPayload.value).toBe(false);

    const privatePayload = await new PrivateContentStore(
      store,
      new GraphManager(store),
    ).getKnowledgeAssetPrivateTriples('async-priv-only', scope);
    expect(privatePayload.some(
      (quad) => quad.subject === root
        && quad.predicate === 'http://schema.org/name'
        && quad.object === '"Private Async"',
    )).toBe(true);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async bare JSON-LD keeps private data in the exact KA private graph', async () => {
    const { agent, store } = await createAgent('AsyncBarePrivateBot');
    await agent.createContextGraph({ id: 'async-bare-private', name: 'AsyncBarePrivate', description: '' });
    await agent.registerContextGraph('async-bare-private');
    const root = 'http://example.org/AsyncBareSecret';

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-bare-private',
      {
        '@context': 'http://schema.org/',
        '@id': root,
        '@type': 'Thing',
        'name': 'Bare Async Private',
      },
      { localOnly: true, accessPolicy: 'ownerOnly' },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectQueuedKaRequest(job);
    expect(request.roots).toEqual([]);
    expect(request.contentScopeVersion).toBe(2);
    expect(request.accessPolicy).toBe('ownerOnly');

    const scope = createGraphKnowledgeAssetScope(request.kaUal!, request.assertionVersion!);
    const swmGraph = knowledgeAssetLayerGraphUri(
      'async-bare-private',
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const publicAnchor = await store.query(
      `ASK { GRAPH <${swmGraph}> { <${root}> <http://dkg.io/ontology/privateDataAnchor> "true" } }`,
    );
    expect(publicAnchor.type).toBe('boolean');
    if (publicAnchor.type === 'boolean') expect(publicAnchor.value).toBe(false);

    const publicPayload = await store.query(
      `ASK { GRAPH <${swmGraph}> { <${root}> <http://schema.org/name> "Bare Async Private" } }`,
    );
    expect(publicPayload.type).toBe('boolean');
    if (publicPayload.type === 'boolean') expect(publicPayload.value).toBe(false);

    const privatePayload = await new PrivateContentStore(
      store,
      new GraphManager(store),
    ).getKnowledgeAssetPrivateTriples('async-bare-private', scope);
    expect(privatePayload.some(
      (quad) => quad.subject === root
        && quad.predicate === 'http://schema.org/name'
        && quad.object === '"Bare Async Private"',
    )).toBe(true);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // The graph-scoped async queue seal allocates + binds the per-author
  // reservedKaId, so the on-chain mint accepts it (no KaIdNamespaceMismatch) and
  // KC.author resolves to the custodial agent rather than the publisher EOA.
  it('E2E: async publish with custodial authorAgentAddress lands on-chain with KC.author == that agent', async () => {
    // Caller-attested authorship: daemon-custodial agent signs at enqueue → publisher consumes verbatim → KC.author == agent (NOT publisher).
    const { agent, store } = await createAgent('AsyncSealE2EBot');
    await agent.createContextGraph({ id: 'async-seal-e2e', name: 'AsyncSealE2E', description: '' });
    await agent.registerContextGraph('async-seal-e2e');
    const root = 'http://example.org/AsyncSealE2EEntity';

    const tenant = await agent.registerAgent('AcmeBikesTenant');
    const publisherAddress = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    expect(tenant.agentAddress.toLowerCase()).not.toBe(publisherAddress.toLowerCase());

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-seal-e2e',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'E2E Author Attestation',
        },
      },
      {
        localOnly: true,
        authorAgentAddress: tenant.agentAddress,
      },
    );

    // Manually drive the same named-KA queue handler used by the daemon.
    const runner = new TripleStoreAsyncLiftPublisher(store, {
      knowledgeAssetVmPublishHandler: {
        preflight: ({ request }) => agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
        execute: ({ request, publishOptions }) =>
          agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
      },
    });
    const finalized = await runner.processNext(publisherAddress);
    expect(finalized).not.toBeNull();
    expect(finalized?.jobId).toBe(captureID);
    expect(finalized?.status === 'broadcast' || finalized?.status === 'included' || finalized?.status === 'finalized').toBe(true);

    // Read author straight from the chain adapter.
    const chainAdapter = (agent as unknown as {
      chain: {
        getLatestMerkleRootAuthor: (kaId: bigint) => Promise<string>;
      };
    }).chain;
    const kaId = (finalized as any)?.broadcast?.batchId
      ?? (finalized as any)?.inclusion?.batchId
      ?? (finalized as any)?.finalization?.batchId;
    expect(kaId).toBeDefined();
    const onChainAuthor = await chainAdapter.getLatestMerkleRootAuthor(BigInt(kaId));
    expect(onChainAuthor.toLowerCase()).toBe(tenant.agentAddress.toLowerCase());
    expect(onChainAuthor.toLowerCase()).not.toBe(publisherAddress.toLowerCase());
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // The graph-scoped async queue seal binds a per-author reservedKaId; recovery
  // rebuilds the digest with that 5th field (read off the persisted seal).
  it('async publish with authorAgentAddress binds the seal to that agent (NOT the publisher\'s wallet)', async () => {
    // Architectural payoff: KC.author is the registered agent, not the publisher's EOA. No private key in the API call.
    const { agent, store } = await createAgent('AsyncSealDistinctAuthorBot');
    await agent.createContextGraph({ id: 'async-seal-distinct', name: 'AsyncSealDistinct', description: '' });
    await agent.registerContextGraph('async-seal-distinct');
    const root = 'http://example.org/AsyncSealDistinctEntity';

    const tenant = await agent.registerAgent('TenantA');
    expect(tenant.agentAddress.toLowerCase()).not.toBe(
      new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address.toLowerCase(),
    );

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-seal-distinct',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Async Seal Distinct',
        },
      },
      {
        localOnly: true,
        authorAgentAddress: tenant.agentAddress,
      },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const seal = expectQueuedKaRequest(job).seal;
    expect(seal).toBeDefined();
    expect(seal?.authorAddress.toLowerCase()).toBe(tenant.agentAddress.toLowerCase());
    expect(seal?.authorAddress.toLowerCase()).not.toBe(
      new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address.toLowerCase(),
    );
    // §F2 — the packed reservedKaId must live in the attested author's namespace.
    expect(seal?.reservedKaId).toBeDefined();
    const reservedKaId = BigInt(seal!.reservedKaId!);
    expect(reservedKaId >> 96n).toBe(BigInt(ethers.getAddress(tenant.agentAddress)));

    // The signature must recover to the registered agent's address —
    // confirms the daemon's custodial key for THIS agent was the one
    // that signed, not the publisher fallback path.
    const onChainId = (await agent.getContextGraphOnChainId('async-seal-distinct')) as string;
    const kav10Address = await (agent as unknown as {
      chain: { getKnowledgeAssetsLifecycleAddress(): Promise<string> };
    }).chain.getKnowledgeAssetsLifecycleAddress();
    const chainId = await (agent as unknown as {
      chain: { getEvmChainId(): Promise<bigint> };
    }).chain.getEvmChainId();
    const merkleRootBytes = ethers.getBytes(seal!.merkleRoot);
    const typed = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      merkleRoot: merkleRootBytes,
      authorAddress: seal!.authorAddress,
      reservedKaId,
      schemeVersion: seal!.schemeVersion,
    });
    const recoveredFromSeal = ethers.recoverAddress(
      ethers.TypedDataEncoder.hash(typed.domain, typed.types, typed.message),
      ethers.Signature.from({
        r: seal!.signature.r,
        yParityAndS: seal!.signature.vs,
      }).serialized,
    );
    expect(recoveredFromSeal.toLowerCase()).toBe(tenant.agentAddress.toLowerCase());
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish rejects authorAgentAddress for unknown / self-sovereign agents', async () => {
    // Mirrors the sync `assertionFinalize` error semantics: the daemon
    // refuses to sign for an agent it doesn't custodially hold the key
    // for. Caller must register the agent first (custodial mode).
    const { agent } = await createAgent('AsyncSealRejectBot');
    await agent.createContextGraph({ id: 'async-seal-reject', name: 'AsyncSealReject', description: '' });
    await agent.registerContextGraph('async-seal-reject');

    // Random EOA — not registered on this node.
    const stranger = ethers.Wallet.createRandom().address;
    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-seal-reject',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/RejectEntity',
            '@type': 'Thing',
            'name': 'Reject',
          },
        },
        { localOnly: true, authorAgentAddress: stranger },
      ),
    ).rejects.toThrow(/is not a registered local agent/);

    // Self-sovereign agent — daemon never had the key.
    const externallyHeld = ethers.Wallet.createRandom();
    const publicKeyCompressed = ethers.SigningKey.computePublicKey(externallyHeld.signingKey.publicKey, true);
    const selfSovereign = await agent.registerAgent('SelfSovereign', { publicKey: publicKeyCompressed });
    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-seal-reject',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/RejectEntity2',
            '@type': 'Thing',
            'name': 'Reject2',
          },
        },
        { localOnly: true, authorAgentAddress: selfSovereign.agentAddress },
      ),
    ).rejects.toThrow(/self-sovereign/);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // The graph-scoped queue seal is built at enqueue (agent canonicalizes +
  // signs over the resolved slice's merkle + the allocated reservedKaId).
  it('async publish attaches the canonical merkle root to the queued KA snapshot', async () => {
    // Agent canonicalizes + signs at enqueue → publisher verifies + consumes verbatim. Real provenance, not "publisher said so".
    const { agent, store } = await createAgent('AsyncSealParityBot');
    await agent.createContextGraph({ id: 'async-seal-parity', name: 'AsyncSealParity', description: '' });
    await agent.registerContextGraph('async-seal-parity');
    const root = 'http://example.org/AsyncSealParityEntity';

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-seal-parity',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Async Seal Parity',
        },
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const seal = expectQueuedKaRequest(job).seal;
    expect(seal).toBeDefined();
    expect(seal?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.authorAddress).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(seal?.signature.r).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.signature.vs).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.schemeVersion).toBe(1);
    // §F2 — the seal carries the packed reservedKaId (stringified bigint) in the
    // signing author's namespace; the publisher mints exactly this id.
    expect(seal?.reservedKaId).toMatch(/^\d+$/);
    expect(BigInt(seal!.reservedKaId!) >> 96n).toBe(
      BigInt(ethers.getAddress(seal!.authorAddress)),
    );
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish fails closed on a non-V10 chain before enqueuing', async () => {
    const { agent, store } = await createAgent('AsyncSealNonV10Bot');
    await agent.createContextGraph({ id: 'async-seal-non-v10', name: 'AsyncSealNonV10', description: '' });
    await agent.registerContextGraph('async-seal-non-v10');

    (agent as unknown as { chain: { isV10Ready: () => boolean } }).chain.isV10Ready = () => false;

    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-seal-non-v10',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/NonV10Entity',
            '@type': 'Thing',
            'name': 'Non-V10 Async',
          },
        },
        { localOnly: true },
      ),
    ).rejects.toThrow(/requires a V10-capable chain/);

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    expect(await asyncPublisher.list()).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish fails closed without enqueuing when finalization throws', async () => {
    const { agent, store } = await createAgent('AsyncSealThrowBot');
    await agent.createContextGraph({ id: 'async-seal-throw', name: 'AsyncSealThrow', description: '' });
    await agent.registerContextGraph('async-seal-throw');

    (agent as unknown as { assertionFinalize: (...args: unknown[]) => Promise<never> }).assertionFinalize =
      async () => {
        throw new Error('simulated finalization failure');
      };

    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-seal-throw',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/ThrowEntity',
            '@type': 'Thing',
            'name': 'Throw',
          },
        },
        { localOnly: true },
      ),
    ).rejects.toThrow(/simulated finalization failure/);

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    expect(await asyncPublisher.list()).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish does not enqueue when an explicit-author finalization fails', async () => {
    const { agent, store } = await createAgent('AsyncSealExplicitThrowBot');
    await agent.createContextGraph({ id: 'async-seal-explicit-throw', name: 'AsyncSealExplicitThrow', description: '' });
    await agent.registerContextGraph('async-seal-explicit-throw');
    const tenant = await agent.registerAgent('ExplicitTenant');

    (agent as unknown as { assertionFinalize: (...args: unknown[]) => Promise<never> }).assertionFinalize =
      async () => {
        throw new Error('simulated signer failure');
      };

    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-seal-explicit-throw',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/ExplicitThrow',
            '@type': 'Thing',
            'name': 'ExplicitThrow',
          },
        },
        { localOnly: true, authorAgentAddress: tenant.agentAddress },
      ),
    ).rejects.toThrow(/simulated signer failure/);

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    expect(await asyncPublisher.list()).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — V10-ready + on-chain CG ⇒ the agent signs the canonical merkle
  // (with the allocated reservedKaId) at enqueue; the publisher consumes it verbatim.
  it('async publish on V10 chain attaches a seal (no fallback needed)', async () => {
    // V10-ready + CG registered → agent signs canonical merkle at enqueue, publisher consumes verbatim.
    const { agent, store } = await createAgent('AsyncSealBot');
    await agent.createContextGraph({ id: 'async-seal', name: 'AsyncSeal', description: '' });
    await agent.registerContextGraph('async-seal');
    const root = 'http://example.org/AsyncSealEntity';

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-seal',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Async Seal Public',
        },
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectQueuedKaRequest(job);
    expect(request.seal).toBeDefined();
    expect(request.seal?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — the EPCIS/Kafka capture shape (private-only) earns a seal too:
  // the merkle covers the private root, and a reservedKaId is allocated + bound.
  it('async publish for private-only content on V10 chain attaches a seal (mirrors EPCIS capture path)', async () => {
    const { agent, store } = await createAgent('AsyncSealPrivBot');
    await agent.createContextGraph({ id: 'async-seal-priv', name: 'AsyncSealPriv', description: '' });
    await agent.registerContextGraph('async-seal-priv');
    const root = 'http://example.org/AsyncSealPrivEntity';

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-seal-priv',
      {
        '@context': 'http://schema.org/',
        '@id': root,
        '@type': 'Thing',
        'name': 'Private-only Async',
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(expectQueuedKaRequest(job).seal).toBeDefined();
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — disk-externalized public snapshots still resolve into the seal's
  // merkle at enqueue, so the seal (with its reservedKaId) is built as usual.
  it('async publish builds the seal when public snapshots are externalized to disk', async () => {
    const dataDir = await createTempDataDir('dkg-agent-public-snapshots-');
    const { agent, store } = await createAgent('AsyncSealDiskSnapshotBot', { dataDir });
    await agent.createContextGraph({ id: 'async-seal-disk-snapshot', name: 'AsyncSealDiskSnapshot', description: '' });
    await agent.registerContextGraph('async-seal-disk-snapshot');
    const root = 'http://example.org/AsyncSealDiskSnapshotEntity';

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-seal-disk-snapshot',
      {
        '@context': 'http://schema.org/',
        '@id': root,
        '@type': 'Thing',
        'name': 'Private async with disk-backed public snapshot',
      },
      { localOnly: true },
    );

    // RFC ka-metadata-trim Phase 2: `dkg:publicSnapshotRef` is no longer
    // written — the disk-store ref IS `dkg:publicQuadsDigest` (a store-backed
    // row is "digest + no `dkg:publicSnapshotGraph`").
    const metadata = await store.query(
      `SELECT ?snapshotRef ?digest ?snapshotGraph WHERE {
        GRAPH <did:dkg:context-graph:async-seal-disk-snapshot/_shared_memory_meta> {
          ?s <http://dkg.io/ontology/publicQuadsDigest> ?digest .
          OPTIONAL { ?s <http://dkg.io/ontology/publicSnapshotRef> ?snapshotRef }
          OPTIONAL { ?s <http://dkg.io/ontology/publicSnapshotGraph> ?snapshotGraph }
        }
      }`,
    );
    expect(metadata.type).toBe('bindings');
    if (metadata.type === 'bindings') {
      expect(metadata.bindings.some((row) => row['digest']?.includes('sha256:'))).toBe(true);
      expect(metadata.bindings.every((row) => row['snapshotRef'] === undefined)).toBe(true);
      expect(metadata.bindings.every((row) => row['snapshotGraph'] === undefined)).toBe(true);
    }

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectQueuedKaRequest(job);
    expect(request.seal).toBeDefined();
    expect(request.seal?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish rejects a pre-signed attestation for a different canonical payload', async () => {
    const { agent, store } = await createAgent('AsyncSealPreSignedBot');
    await agent.createContextGraph({ id: 'async-seal-presigned', name: 'AsyncSealPreSigned', description: '' });
    await agent.registerContextGraph('async-seal-presigned');

    // A caller cannot enqueue arbitrary signature bytes against an unrelated
    // merkle root: finalization binds the attestation to the canonical KA graph.
    const expectedMerkleRoot = new Uint8Array(32).fill(0xab);
    // Valid EIP-55 address (publishAsync getAddress-validates the attested author).
    const customAuthor = ethers.getAddress('0x' + 'ab'.repeat(20));
    const sigR = new Uint8Array(32).fill(0xbb);
    const sigVs = new Uint8Array(32).fill(0xcc);
    // §F2 — the pre-signed packed id MUST live in `customAuthor`'s namespace
    // (high 160 bits == author); publishAsync rejects it otherwise.
    const presignedReservedKaId = (BigInt(customAuthor) << 96n) | 7n;

    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-seal-presigned',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/PreSignedEntity',
            '@type': 'Thing',
            'name': 'PreSigned',
          },
        },
        {
          localOnly: true,
          preSignedAuthorAttestation: {
            expectedMerkleRoot,
            authorAddress: customAuthor,
            signature: { r: sigR, vs: sigVs },
            schemeVersion: 1,
            reservedKaId: presignedReservedKaId,
          },
        },
      ),
    ).rejects.toThrow(/expectedMerkleRoot mismatch/);

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    expect(await asyncPublisher.list()).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish accepts a valid off-node pre-signed author attestation unchanged', async () => {
    const externalAuthor = ethers.Wallet.createRandom();
    const content = {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/ValidPreSignedEntity',
        '@type': 'Thing',
        'name': 'Valid PreSigned',
      },
    };

    // Produce the canonical seal through the callback signing path. Each test
    // agent has a fresh deterministic KA allocator, so the second agent derives
    // the same author-scoped UAL and can exercise the pre-signed input path.
    const source = await createAgent('AsyncValidPreSignedSourceBot');
    await source.agent.createContextGraph({
      id: 'async-valid-presigned-source',
      name: 'AsyncValidPreSignedSource',
      description: '',
    });
    await source.agent.registerContextGraph('async-valid-presigned-source');
    const sourceCapture = await source.agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-valid-presigned-source',
      content,
      {
        localOnly: true,
        authorAgentAddress: externalAuthor.address,
        authorSignTypedData: async (typedData) => {
          const signature = ethers.Signature.from(await externalAuthor.signTypedData(
            typedData.domain,
            typedData.types,
            typedData.message,
          ));
          return {
            r: ethers.getBytes(signature.r),
            vs: ethers.getBytes(signature.yParityAndS),
          };
        },
      },
    );
    const sourceQueue = new TripleStoreAsyncLiftPublisher(source.store);
    const sourceRequest = expectQueuedKaRequest(
      await sourceQueue.getStatus(sourceCapture.captureID),
    );

    const target = await createAgent('AsyncValidPreSignedTargetBot');
    await target.agent.createContextGraph({
      id: 'async-valid-presigned-target',
      name: 'AsyncValidPreSignedTarget',
      description: '',
    });
    await target.agent.registerContextGraph('async-valid-presigned-target');
    const targetCapture = await target.agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-valid-presigned-target',
      content,
      {
        localOnly: true,
        preSignedAuthorAttestation: {
          expectedMerkleRoot: ethers.getBytes(sourceRequest.seal.merkleRoot),
          authorAddress: sourceRequest.seal.authorAddress,
          signature: {
            r: ethers.getBytes(sourceRequest.seal.signature.r),
            vs: ethers.getBytes(sourceRequest.seal.signature.vs),
          },
          schemeVersion: sourceRequest.seal.schemeVersion,
          reservedKaId: BigInt(sourceRequest.seal.reservedKaId!),
        },
      },
    );
    const targetQueue = new TripleStoreAsyncLiftPublisher(target.store);
    const targetRequest = expectQueuedKaRequest(
      await targetQueue.getStatus(targetCapture.captureID),
    );

    expect(targetRequest.seal).toEqual(sourceRequest.seal);
    expect(targetRequest.seal.authorAddress).toBe(externalAuthor.address);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish rejects preSignedAuthorAttestation + authorAgentAddress as mutually exclusive', async () => {
    // Sync parity: pick one signing path (caller-provided seal OR daemon custodial).
    const { agent } = await createAgent('AsyncSealMutexBot');
    await agent.createContextGraph({ id: 'async-seal-mutex', name: 'AsyncSealMutex', description: '' });
    await agent.registerContextGraph('async-seal-mutex');

    const tenant = await agent.registerAgent('TenantMutex');

    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-seal-mutex',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/MutexEntity',
            '@type': 'Thing',
            'name': 'Mutex',
          },
        },
        {
          localOnly: true,
          authorAgentAddress: tenant.agentAddress,
          preSignedAuthorAttestation: {
            expectedMerkleRoot: new Uint8Array(32).fill(0xab),
            authorAddress: tenant.agentAddress,
            signature: {
              r: new Uint8Array(32).fill(0xbb),
              vs: new Uint8Array(32).fill(0xcc),
            },
            schemeVersion: 1,
          },
        },
      ),
    ).rejects.toThrow(/mutually exclusive/);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — the callback receives typed data that already binds the
  // allocated reservedKaId; recovery rebuilds the digest with that 5th field.
  it('async publish supports authorSignTypedData callback for self-sovereign signing (sync parity)', async () => {
    // Self-sovereign agents (caller holds key off-node) sign via callback. Daemon prepares typed data, caller signs.
    const { agent, store } = await createAgent('AsyncSealCallbackBot');
    await agent.createContextGraph({ id: 'async-seal-callback', name: 'AsyncSealCallback', description: '' });
    await agent.registerContextGraph('async-seal-callback');

    // Self-sovereign — daemon never sees the key, only the address.
    const externallyHeld = ethers.Wallet.createRandom();
    const publicKeyCompressed = ethers.SigningKey.computePublicKey(externallyHeld.signingKey.publicKey, true);
    const selfSov = await agent.registerAgent('SelfSovAuthor', { publicKey: publicKeyCompressed });
    expect(selfSov.agentAddress.toLowerCase()).toBe(externallyHeld.address.toLowerCase());

    let typedDataReceived: { domain: unknown; types: unknown; message: { authorAddress: string; merkleRoot: string; reservedKaId: bigint } } | null = null;
    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-seal-callback',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': 'http://example.org/SelfSovEntity',
          '@type': 'Thing',
          'name': 'SelfSov',
        },
      },
      {
        localOnly: true,
        authorAgentAddress: selfSov.agentAddress,
        authorSignTypedData: async (typedData) => {
          typedDataReceived = typedData;
          const sigHex = await externallyHeld.signTypedData(
            typedData.domain,
            typedData.types,
            typedData.message,
          );
          const sig = ethers.Signature.from(sigHex);
          return {
            r: ethers.getBytes(sig.r),
            vs: ethers.getBytes(sig.yParityAndS),
          };
        },
      },
    );

    // Typed data must name the self-sovereign agent as author for on-chain binding to match.
    expect(typedDataReceived).not.toBeNull();
    expect(typedDataReceived!.message.authorAddress.toLowerCase()).toBe(selfSov.agentAddress.toLowerCase());

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const seal = expectQueuedKaRequest(job).seal;
    expect(seal).toBeDefined();
    expect(seal?.authorAddress.toLowerCase()).toBe(selfSov.agentAddress.toLowerCase());
    // §F2 — reservedKaId is allocated in the self-sovereign author's namespace and
    // bound into the digest the callback signed.
    expect(seal?.reservedKaId).toBeDefined();
    const reservedKaId = BigInt(seal!.reservedKaId!);
    expect(reservedKaId >> 96n).toBe(BigInt(ethers.getAddress(selfSov.agentAddress)));
    expect(BigInt(typedDataReceived!.message.reservedKaId)).toBe(reservedKaId);

    // Recovered signer must match the self-sovereign EOA, not the publisher.
    const onChainId = (await agent.getContextGraphOnChainId('async-seal-callback')) as string;
    const kav10Address = await (agent as unknown as {
      chain: { getKnowledgeAssetsLifecycleAddress(): Promise<string> };
    }).chain.getKnowledgeAssetsLifecycleAddress();
    const chainId = await (agent as unknown as {
      chain: { getEvmChainId(): Promise<bigint> };
    }).chain.getEvmChainId();
    const typed = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      merkleRoot: ethers.getBytes(seal!.merkleRoot),
      authorAddress: seal!.authorAddress,
      reservedKaId,
      schemeVersion: seal!.schemeVersion,
    });
    const recovered = ethers.recoverAddress(
      ethers.TypedDataEncoder.hash(typed.domain, typed.types, typed.message),
      ethers.Signature.from({
        r: seal!.signature.r,
        yParityAndS: seal!.signature.vs,
      }).serialized,
    );
    expect(recovered.toLowerCase()).toBe(externallyHeld.address.toLowerCase());
    expect(recovered.toLowerCase()).not.toBe(
      new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address.toLowerCase(),
    );
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish rejects authorSignTypedData without authorAgentAddress', async () => {
    // Callback alone has no address to fill into seal.authorAddress — mutex fail-fast.
    const { agent } = await createAgent('AsyncSealCallbackNoAddrBot');
    await agent.createContextGraph({ id: 'async-seal-cb-noaddr', name: 'AsyncSealCBNoAddr', description: '' });
    await agent.registerContextGraph('async-seal-cb-noaddr');

    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-seal-cb-noaddr',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/CBNoAddr',
            '@type': 'Thing',
            'name': 'CBNoAddr',
          },
        },
        {
          localOnly: true,
          authorSignTypedData: async () => ({
            r: new Uint8Array(32),
            vs: new Uint8Array(32),
          }),
        },
      ),
    ).rejects.toThrow(/authorSignTypedData requires authorAgentAddress/);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — the self-sovereign callback signs over the bound reservedKaId,
  // so the publisher mints exactly that id and KC.author == the self-sovereign agent.
  it('E2E: async publish via authorSignTypedData callback lands on-chain with KC.author == self-sovereign agent', async () => {
    // Self-sovereign callback path E2E: caller signs off-node, publisher consumes verbatim, KC.author == self-sov agent.
    const { agent, store } = await createAgent('AsyncCallbackE2EBot');
    await agent.createContextGraph({ id: 'async-cb-e2e', name: 'AsyncCBE2E', description: '' });
    await agent.registerContextGraph('async-cb-e2e');

    // Self-sovereign: daemon only has the public key; `externallyHeld` simulates an off-node KMS.
    const externallyHeld = ethers.Wallet.createRandom();
    const publicKeyCompressed = ethers.SigningKey.computePublicKey(externallyHeld.signingKey.publicKey, true);
    const selfSov = await agent.registerAgent('SelfSovE2E', { publicKey: publicKeyCompressed });
    const publisherAddress = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    expect(selfSov.agentAddress.toLowerCase()).toBe(externallyHeld.address.toLowerCase());
    expect(selfSov.agentAddress.toLowerCase()).not.toBe(publisherAddress.toLowerCase());

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-cb-e2e',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': 'http://example.org/CBE2EEntity',
          '@type': 'Thing',
          'name': 'Callback E2E',
        },
      },
      {
        localOnly: true,
        authorAgentAddress: selfSov.agentAddress,
        authorSignTypedData: async (typedData) => {
          const sigHex = await externallyHeld.signTypedData(
            typedData.domain,
            typedData.types,
            typedData.message,
          );
          const sig = ethers.Signature.from(sigHex);
          return {
            r: ethers.getBytes(sig.r),
            vs: ethers.getBytes(sig.yParityAndS),
          };
        },
      },
    );

    // Drive processNext through the same named-KA handler as production.
    const runner = new TripleStoreAsyncLiftPublisher(store, {
      knowledgeAssetVmPublishHandler: {
        preflight: ({ request }) => agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
        execute: ({ request, publishOptions }) =>
          agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
      },
    });
    const finalized = await runner.processNext(publisherAddress);
    expect(finalized).not.toBeNull();
    expect(finalized?.jobId).toBe(captureID);
    expect(finalized?.status === 'broadcast' || finalized?.status === 'included' || finalized?.status === 'finalized').toBe(true);

    const chainAdapter = (agent as unknown as {
      chain: { getLatestMerkleRootAuthor: (kaId: bigint) => Promise<string> };
    }).chain;
    const kaId = (finalized as any)?.broadcast?.batchId
      ?? (finalized as any)?.inclusion?.batchId
      ?? (finalized as any)?.finalization?.batchId;
    expect(kaId).toBeDefined();
    const onChainAuthor = await chainAdapter.getLatestMerkleRootAuthor(BigInt(kaId));
    expect(onChainAuthor.toLowerCase()).toBe(selfSov.agentAddress.toLowerCase());
    expect(onChainAuthor.toLowerCase()).not.toBe(publisherAddress.toLowerCase());
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish rejects legacy transition metadata before enqueuing', async () => {
    const { agent, store } = await createAgent('AsyncPriorVerBot');
    await agent.createContextGraph({ id: 'async-priorver', name: 'AsyncPriorVer', description: '' });
    await agent.registerContextGraph('async-priorver');

    const content = {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/PriorVerEntity',
        '@type': 'Thing',
        'name': 'PriorVer',
      },
    };
    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-priorver',
        content,
        {
          localOnly: true,
          transitionType: 'MUTATE',
        },
      ),
    ).rejects.toThrow(/no longer accepts transitionType/);
    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-priorver',
        content,
        {
          localOnly: true,
          transitionType: 'CREATE',
        },
      ),
    ).rejects.toThrow(/no longer accepts transitionType/);
    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-priorver',
        content,
        {
          localOnly: true,
          priorVersion: 'did:dkg:mock:31337/0xabc/7',
        },
      ),
    ).rejects.toThrow(/priorVersion is only valid for the legacy root-lift path/);

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    expect(await asyncPublisher.list()).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish rejects invalid access envelopes before lifecycle mutation or enqueue', async () => {
    const { agent, store } = await createAgent('AsyncInvalidAccessEnvelopeBot');
    await agent.createContextGraph({
      id: 'async-invalid-access-envelope',
      name: 'AsyncInvalidAccessEnvelope',
      description: '',
    });
    await agent.registerContextGraph('async-invalid-access-envelope');
    const content = {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/InvalidAccessEnvelope',
        '@type': 'Thing',
        'name': 'Invalid access envelope',
      },
    };
    const metadataBefore = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <did:dkg:context-graph:async-invalid-access-envelope/_meta> { ?s ?p ?o } }',
    );

    await expect(agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-invalid-access-envelope',
      content,
      { localOnly: true, accessPolicy: 'allowList' },
    )).rejects.toThrow(/allowList policy requires allowedPeers/);
    await expect(agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-invalid-access-envelope',
      content,
      { localOnly: true, accessPolicy: 'public', allowedPeers: ['peer-a'] },
    )).rejects.toThrow(/allowedPeers requires allowList policy/);

    const metadataAfter = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <did:dkg:context-graph:async-invalid-access-envelope/_meta> { ?s ?p ?o } }',
    );
    expect(metadataAfter).toEqual(metadataBefore);
    expect(await new TripleStoreAsyncLiftPublisher(store).list()).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish rejects unsupported graph-scoped entity proofs before enqueue', async () => {
    const { agent, store } = await createAgent('AsyncEntityProofsBot');
    await agent.createContextGraph({ id: 'async-entity-proofs', name: 'AsyncEntityProofs', description: '' });
    await agent.registerContextGraph('async-entity-proofs');

    await expect(
      agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-entity-proofs',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/EntityProofsRoot',
            '@type': 'Thing',
            'name': 'EntityProofs',
          },
        },
        {
          localOnly: true,
          entityProofs: true,
        },
      ),
    ).rejects.toThrow(/does not support entityProofs/);

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    expect(await asyncPublisher.list()).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish snapshots publisherNodeIdentityIdOverride as a bigint string', async () => {
    // RFC-001 §4 attribution override. BigInt → string for JSON persistence; mapper parses back.
    const { agent, store } = await createAgent('AsyncNodeIdOverrideBot');
    await agent.createContextGraph({ id: 'async-node-id-override', name: 'AsyncNodeIdOverride', description: '' });
    await agent.registerContextGraph('async-node-id-override');

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-node-id-override',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': 'http://example.org/NodeIdOverrideRoot',
          '@type': 'Thing',
          'name': 'NodeIdOverride',
        },
      },
      {
        localOnly: true,
        publisherNodeIdentityIdOverride: 42n,
      },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(expectQueuedKaRequest(job).publisherNodeIdentityIdOverride).toBe('42');
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish preserves publisherNodeIdentityIdOverride === 0n (mode d "no attribution")', async () => {
    // RFC-001 §4 mode d: explicit `0n` survives (≠ undefined which means "use daemon identity").
    const { agent, store } = await createAgent('AsyncNodeIdZeroBot');
    await agent.createContextGraph({ id: 'async-node-id-zero', name: 'AsyncNodeIdZero', description: '' });
    await agent.registerContextGraph('async-node-id-zero');

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-node-id-zero',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': 'http://example.org/NodeIdZeroRoot',
          '@type': 'Thing',
          'name': 'NodeIdZero',
        },
      },
      {
        localOnly: true,
        publisherNodeIdentityIdOverride: 0n,
      },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(expectQueuedKaRequest(job).publisherNodeIdentityIdOverride).toBe('0');
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish fails closed without enqueuing when no signer is available', async () => {
    const { agent, store } = await createAgent('AsyncSealNoSigner');
    await agent.createContextGraph({ id: 'async-no-signer', name: 'AsyncNoSigner', description: '' });
    await agent.registerContextGraph('async-no-signer');

    const publisher = (agent as unknown as { publisher: { publisherFallbackAuthorAddress: (cgId?: bigint) => Promise<string | undefined> } }).publisher;
    const original = publisher.publisherFallbackAuthorAddress.bind(publisher);
    publisher.publisherFallbackAuthorAddress = async () => undefined;

    try {
      await expect(
        agent.publishAsync(
          { kind: 'node' },
          'did:dkg:context-graph:async-no-signer',
          {
            public: {
              '@context': 'http://schema.org/',
              '@id': 'http://example.org/NoSignerEntity',
              '@type': 'Thing',
              'name': 'NoSigner',
            },
          },
          { localOnly: true },
        ),
      ).rejects.toThrow(/no author signer is available/);

      const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
      expect(await asyncPublisher.list()).toEqual([]);
    } finally {
      publisher.publisherFallbackAuthorAddress = original;
    }
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // The graph-scoped queue seal's publisher-fallback signer path mirrors
  // sync `assertionFinalize`: both fallback + sign are called WITHOUT a cgId.
  it('async publish does NOT pass cgId to publisher fallback methods (matches sync assertionFinalize behavior)', async () => {
    // Pins sync `assertionFinalize` parity. Threading cgId surfaces a publisher-side
    // `signTypedData` fallback bug (recovers chain default, not the recorded author).
    // Fix lives in the publisher, not the agent — out of scope for this PR.
    const { agent } = await createAgent('AsyncSyncParityBot');
    await agent.createContextGraph({ id: 'async-sync-parity', name: 'AsyncSyncParity', description: '' });
    await agent.registerContextGraph('async-sync-parity');

    const publisher = (agent as unknown as {
      publisher: {
        publisherFallbackAuthorAddress: (cgId?: bigint) => Promise<string | undefined>;
        signAuthorAttestationAsPublisher: (typedData: unknown, cgId?: bigint) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
      };
    }).publisher;
    const originalFallback = publisher.publisherFallbackAuthorAddress.bind(publisher);
    const originalSign = publisher.signAuthorAttestationAsPublisher.bind(publisher);

    const fallbackCalls: Array<bigint | undefined> = [];
    const signCalls: Array<bigint | undefined> = [];
    publisher.publisherFallbackAuthorAddress = async (cgId?: bigint) => {
      fallbackCalls.push(cgId);
      return originalFallback(cgId);
    };
    publisher.signAuthorAttestationAsPublisher = async (typedData: unknown, cgId?: bigint) => {
      signCalls.push(cgId);
      return originalSign(typedData as any, cgId);
    };

    try {
      await agent.publishAsync(
        { kind: 'node' },
        'did:dkg:context-graph:async-sync-parity',
        {
          public: {
            '@context': 'http://schema.org/',
            '@id': 'http://example.org/SyncParityEntity',
            '@type': 'Thing',
            'name': 'SyncParity',
          },
        },
        { localOnly: true },
      );
      // Both methods called with undefined cgId — pinned until the publisher-side fallback fix lands.
      expect(fallbackCalls).toContain(undefined);
      expect(signCalls).toContain(undefined);
    } finally {
      publisher.publisherFallbackAuthorAddress = originalFallback;
      publisher.signAuthorAttestationAsPublisher = originalSign;
    }
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish seals a rootless KA even when its CG is not registered on-chain yet', async () => {
    const { agent, store } = await createAgent('AsyncNoOnChainBot');
    await agent.createContextGraph({ id: 'async-no-onchain', name: 'AsyncNoOnChain', description: '' });
    // Intentionally skip registerContextGraph so the CG has no on-chain id.

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'did:dkg:context-graph:async-no-onchain',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': 'http://example.org/NoOnChainEntity',
          '@type': 'Thing',
          'name': 'NoOnChain',
        },
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectQueuedKaRequest(job);
    expect(request.seal).toBeDefined();
    expect(request.contentScopeVersion).toBe(2);
    expect(request.roots).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish does not subtract a new atomic KA against legacy root metadata', async () => {
    const { agent, store } = await createAgent('AsyncSubtractObserve');
    await agent.createContextGraph({ id: 'async-subtract-observe', name: 'AsyncSubtractObs', description: '' });
    await agent.registerContextGraph('async-subtract-observe');

    const root = 'http://example.org/AlreadyPublished';
    // GH #1122 — the async lift preserves caller root IRIs (identity
    // canonicalization, parity with sync), so the authoritative confirmed
    // state lives at the CALLER root itself, not a dkg:<cg>:… rewrite.
    const canonical = root;
    const dataGraph = `did:dkg:context-graph:async-subtract-observe`;
    const metaGraph = `did:dkg:context-graph:async-subtract-observe/_meta`;
    const kcUal = 'urn:dkg:test:kc:async-subtract-observe';

    // Pre-populate confirmed KC + matching authoritative quad in store.
    await store.insert([
      { subject: kcUal, predicate: 'http://dkg.io/ontology/rootEntity', object: `"${canonical}"`, graph: metaGraph },
      { subject: kcUal, predicate: 'http://dkg.io/ontology/partOf', object: kcUal, graph: metaGraph },
      { subject: kcUal, predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: metaGraph },
      { subject: canonical, predicate: 'http://example.org/p', object: '"hello"', graph: dataGraph },
    ]);

    // The submitted graph is a new KA even if an older root-addressed asset
    // happens to contain an identical triple.
    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'async-subtract-observe',
      {
        publicQuads: [{ subject: root, predicate: 'http://example.org/p', object: '"hello"', graph: '' }],
        privateQuads: [],
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectQueuedKaRequest(job);
    expect(request.seal).toBeDefined();
    expect(request.contentScopeVersion).toBe(2);
    expect(request.roots).toEqual([]);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish records and resolves subGraphName for staged public and private data', async () => {
    const { agent, store } = await createAgent('AsyncSubGraphBot');
    await agent.createContextGraph({ id: 'async-subgraph', name: 'AsyncSubGraph', description: '' });
    await agent.registerContextGraph('async-subgraph');
    await agent.createSubGraph('async-subgraph', 'research');
    const root = 'http://example.org/AsyncSubGraphSecret';

    const { captureID } = await agent.publishAsync(
      { kind: 'node' },
      'async-subgraph',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'description': 'Public Subgraph Marker',
        },
        private: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Private Subgraph Async',
        },
      },
      { localOnly: true, accessPolicy: 'ownerOnly', subGraphName: 'research' },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectQueuedKaRequest(job);
    expect(request.subGraphName).toBe('research');
    expect(request.contentScopeVersion).toBe(2);
    expect(request.roots).toEqual([]);
    expect(request.accessPolicy).toBe('ownerOnly');
  }, CHAIN_JSONLD_TIMEOUT_MS);
});
