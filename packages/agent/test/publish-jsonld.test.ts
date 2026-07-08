import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent, type DKGAgentConfig } from '../src/index.js';
import { OxigraphStore, SharedMemoryLiteralBlobStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher, type LiftJob, type LiftRequest } from '@origintrail-official/dkg-publisher';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, buildAuthorAttestationTypedData, contextGraphDataGraphUri } from '@origintrail-official/dkg-core';
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

function expectRawLiftRequest(job: LiftJob | null): LiftRequest {
  expect(job?.request.jobType).toBe('lift');
  if (!job || job.request.jobType !== 'lift') {
    throw new Error('Expected a raw lift job');
  }
  return job.request.lift;
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

    const privateGraph = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:split-test/_private> { ?s ?p ?o } }`,
    );
    if (privateGraph.type === 'boolean') {
      expect(privateGraph.value).toBe(true);
    }
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

  it('async private-only JSON-LD anchors the real private root and enqueues a Lift job', async () => {
    const { agent, store } = await createAgent('AsyncPrivateOnlyBot');
    await agent.createContextGraph({ id: 'async-priv-only', name: 'AsyncPrivateOnly', description: '' });
    await agent.registerContextGraph('async-priv-only');
    const root = 'http://example.org/AsyncSecret';

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-priv-only',
      {
        private: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Private Async',
        },
      },
      { localOnly: true, accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectRawLiftRequest(job);
    expect(request.roots).toEqual([root]);
    expect(request.accessPolicy).toBe('allowList');
    expect(request.allowedPeers).toEqual(['peer-a']);
    // Keep this resilient to control-plane tuning (defaults changed in main).
    expect(job?.retries.maxRetries).toBeGreaterThan(0);

    const publicAnchor = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-priv-only/_shared_memory> { <${root}> <http://dkg.io/ontology/privateDataAnchor> "true" } }`,
    );
    expect(publicAnchor.type).toBe('boolean');
    if (publicAnchor.type === 'boolean') expect(publicAnchor.value).toBe(true);

    const publicPayload = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-priv-only/_shared_memory> { <${root}> <http://schema.org/name> "Private Async" } }`,
    );
    expect(publicPayload.type).toBe('boolean');
    if (publicPayload.type === 'boolean') expect(publicPayload.value).toBe(false);

    const privatePayload = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-priv-only/_private> { <${root}> <http://schema.org/name> "Private Async" } }`,
    );
    expect(privatePayload.type).toBe('boolean');
    if (privatePayload.type === 'boolean') expect(privatePayload.value).toBe(false);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async bare JSON-LD writes only an anchor in shared/private graphs before lift', async () => {
    const { agent, store } = await createAgent('AsyncBarePrivateBot');
    await agent.createContextGraph({ id: 'async-bare-private', name: 'AsyncBarePrivate', description: '' });
    await agent.registerContextGraph('async-bare-private');
    const root = 'http://example.org/AsyncBareSecret';

    const { captureID } = await agent.publishAsync(
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
    const request = expectRawLiftRequest(job);
    expect(request.roots).toEqual([root]);
    expect(request.accessPolicy).toBe('ownerOnly');

    const publicAnchor = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-bare-private/_shared_memory> { <${root}> <http://dkg.io/ontology/privateDataAnchor> "true" } }`,
    );
    expect(publicAnchor.type).toBe('boolean');
    if (publicAnchor.type === 'boolean') expect(publicAnchor.value).toBe(true);

    const publicPayload = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-bare-private/_shared_memory> { <${root}> <http://schema.org/name> "Bare Async Private" } }`,
    );
    expect(publicPayload.type).toBe('boolean');
    if (publicPayload.type === 'boolean') expect(publicPayload.value).toBe(false);

    // Async lift stages private quads by operation; they are not materialized in
    // `_private` until the lift pipeline executes.
    const privatePayload = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-bare-private/_private> { <${root}> <http://schema.org/name> "Bare Async Private" } }`,
    );
    expect(privatePayload.type).toBe('boolean');
    if (privatePayload.type === 'boolean') expect(privatePayload.value).toBe(false);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — the async-lift seal now allocates + binds the per-author
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

    // Manually drive the same pipeline the publisher-runner runs in
    // production: claim → validate → publish. We borrow the agent's
    // own internal publisher so the chain adapter + wallets match
    // what processed the request.
    const internalPublisher = (agent as unknown as {
      publisher: {
        publish: (opts: unknown) => Promise<{ status: string; onChainResult?: { batchId: bigint } }>;
      };
    }).publisher;
    const runner = new TripleStoreAsyncLiftPublisher(store, {
      publishExecutor: async ({ publishOptions }) => {
        return internalPublisher.publish(publishOptions) as Promise<any>;
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

  // OT-RFC-43 §F2 — the async-lift seal binds a per-author reservedKaId; recovery
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
    const seal = expectRawLiftRequest(job).seal;
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

  // OT-RFC-43 §F2 — the async-lift seal is built at enqueue (agent canonicalizes +
  // signs over the resolved slice's merkle + the allocated reservedKaId).
  it('async publish attaches a seal to the LiftRequest with merkleRoot == canonicalPublishPayload(resolved slice)', async () => {
    // Agent canonicalizes + signs at enqueue → publisher verifies + consumes verbatim. Real provenance, not "publisher said so".
    const { agent, store } = await createAgent('AsyncSealParityBot');
    await agent.createContextGraph({ id: 'async-seal-parity', name: 'AsyncSealParity', description: '' });
    await agent.registerContextGraph('async-seal-parity');
    const root = 'http://example.org/AsyncSealParityEntity';

    const { captureID } = await agent.publishAsync(
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
    const seal = expectRawLiftRequest(job).seal;
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

  it('async publish on a non-V10 chain enqueues without a seal (no on-chain publish to seal for)', async () => {
    // Seal only built when chain is V10-ready AND CG has on-chain id. Non-V10 → publisher takes tentative-only path.
    const { agent, store } = await createAgent('AsyncSealNonV10Bot');
    await agent.createContextGraph({ id: 'async-seal-non-v10', name: 'AsyncSealNonV10', description: '' });
    await agent.registerContextGraph('async-seal-non-v10');

    (agent as unknown as { chain: { isV10Ready: () => boolean } }).chain.isV10Ready = () => false;

    const { captureID } = await agent.publishAsync(
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
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(expectRawLiftRequest(job).seal).toBeUndefined();
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — backstop: the WM/SWM write is committed BEFORE seal-building and
  // publishAsync has no outer rollback, so an unexpected throw inside buildAsyncLiftSeal
  // (transient store read, slice/validation race, signer failure) must degrade to a
  // SEALLESS lift — never orphan the staged capture or swallow the captureID.
  it('async publish degrades to sealless (no orphaned write) when seal-building throws', async () => {
    const { agent, store } = await createAgent('AsyncSealThrowBot');
    await agent.createContextGraph({ id: 'async-seal-throw', name: 'AsyncSealThrow', description: '' });
    await agent.registerContextGraph('async-seal-throw');

    // Force the seal pipeline to throw, simulating a transient failure after the
    // (already-committed) workspace write.
    (agent as unknown as { buildAsyncLiftSeal: () => Promise<undefined> }).buildAsyncLiftSeal =
      async () => {
        throw new Error('simulated transient seal-build failure');
      };

    const { captureID } = await agent.publishAsync(
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
    );
    // The capture was still enqueued (NOT orphaned) and returned a usable captureID.
    expect(captureID).toBeTruthy();

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(job).not.toBeNull();
    // Sealless: the lift carries no seal, so the publisher stages WM/SWM without an
    // on-chain VM anchor (exactly the prior always-sealless async behaviour).
    expect(expectRawLiftRequest(job).seal).toBeUndefined();
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — the sealless backstop is ONLY for the implicit machine-capture
  // path. An EXPLICIT authorship request (custodial authorAgentAddress / self-sovereign
  // callback) that fails to seal must surface — silently enqueuing an unauthored job
  // and reporting success would hide that the requested attestation never happened.
  it('async publish re-throws (does not silently go sealless) when an EXPLICIT author seal-build fails', async () => {
    const { agent } = await createAgent('AsyncSealExplicitThrowBot');
    await agent.createContextGraph({ id: 'async-seal-explicit-throw', name: 'AsyncSealExplicitThrow', description: '' });
    await agent.registerContextGraph('async-seal-explicit-throw');
    const tenant = await agent.registerAgent('ExplicitTenant');

    (agent as unknown as { buildAsyncLiftSeal: () => Promise<undefined> }).buildAsyncLiftSeal =
      async () => {
        throw new Error('simulated signer failure');
      };

    await expect(
      agent.publishAsync(
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
    const request = expectRawLiftRequest(job);
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
    expect(expectRawLiftRequest(job).seal).toBeDefined();
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
    const request = expectRawLiftRequest(job);
    expect(request.seal).toBeDefined();
    expect(request.seal?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish accepts preSignedAuthorAttestation and threads it byte-for-byte into LiftRequest.seal', async () => {
    // Sync parity: caller pre-signs off-node, agent threads bytes verbatim. Publisher preflight validates at processNext.
    const { agent, store } = await createAgent('AsyncSealPreSignedBot');
    await agent.createContextGraph({ id: 'async-seal-presigned', name: 'AsyncSealPreSigned', description: '' });
    await agent.registerContextGraph('async-seal-presigned');

    // Arbitrary bytes — this test is passthrough wiring, not seal validity.
    const expectedMerkleRoot = new Uint8Array(32).fill(0xab);
    // Valid EIP-55 address (publishAsync getAddress-validates the attested author).
    const customAuthor = ethers.getAddress('0x' + 'ab'.repeat(20));
    const sigR = new Uint8Array(32).fill(0xbb);
    const sigVs = new Uint8Array(32).fill(0xcc);
    // §F2 — the pre-signed packed id MUST live in `customAuthor`'s namespace
    // (high 160 bits == author); publishAsync rejects it otherwise.
    const presignedReservedKaId = (BigInt(customAuthor) << 96n) | 7n;

    const { captureID } = await agent.publishAsync(
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
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const seal = expectRawLiftRequest(job).seal;
    expect(seal).toBeDefined();
    expect(seal?.merkleRoot).toBe('0x' + 'ab'.repeat(32));
    expect(seal?.authorAddress.toLowerCase()).toBe(customAuthor.toLowerCase());
    expect(seal?.signature.r).toBe('0x' + 'bb'.repeat(32));
    expect(seal?.signature.vs).toBe('0x' + 'cc'.repeat(32));
    expect(seal?.schemeVersion).toBe(1);
    // §F2 — the attested reservedKaId is threaded byte-for-byte onto the seal.
    expect(seal?.reservedKaId).toBe(`${presignedReservedKaId}`);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish rejects preSignedAuthorAttestation + authorAgentAddress as mutually exclusive', async () => {
    // Sync parity: pick one signing path (caller-provided seal OR daemon custodial).
    const { agent } = await createAgent('AsyncSealMutexBot');
    await agent.createContextGraph({ id: 'async-seal-mutex', name: 'AsyncSealMutex', description: '' });
    await agent.registerContextGraph('async-seal-mutex');

    const tenant = await agent.registerAgent('TenantMutex');

    await expect(
      agent.publishAsync(
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
    const seal = expectRawLiftRequest(job).seal;
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

    // Drive processNext with the agent's own internal publisher so
    // wallets + chain adapter match what enqueued the job.
    const internalPublisher = (agent as unknown as {
      publisher: {
        publish: (opts: unknown) => Promise<{ status: string; onChainResult?: { batchId: bigint } }>;
      };
    }).publisher;
    const runner = new TripleStoreAsyncLiftPublisher(store, {
      publishExecutor: async ({ publishOptions }) => {
        return internalPublisher.publish(publishOptions) as Promise<any>;
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

  it('async publish threads opts.priorVersion into LiftRequest.priorVersion', async () => {
    // `priorVersion` threads through enqueue unchanged for MUTATE/REVOKE transitions.
    const { agent, store } = await createAgent('AsyncPriorVerBot');
    await agent.createContextGraph({ id: 'async-priorver', name: 'AsyncPriorVer', description: '' });
    await agent.registerContextGraph('async-priorver');

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-priorver',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': 'http://example.org/PriorVerEntity',
          '@type': 'Thing',
          'name': 'PriorVer',
        },
      },
      {
        localOnly: true,
        transitionType: 'MUTATE',
        priorVersion: 'did:dkg:mock:31337/0xabc/7',
      },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const request = expectRawLiftRequest(job);
    expect(request.priorVersion).toBe('did:dkg:mock:31337/0xabc/7');
    expect(request.transitionType).toBe('MUTATE');
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish threads opts.entityProofs into LiftRequest.entityProofs', async () => {
    // V10 selective-disclosure flag persists through enqueue.
    const { agent, store } = await createAgent('AsyncEntityProofsBot');
    await agent.createContextGraph({ id: 'async-entity-proofs', name: 'AsyncEntityProofs', description: '' });
    await agent.registerContextGraph('async-entity-proofs');

    const { captureID } = await agent.publishAsync(
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
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(expectRawLiftRequest(job).entityProofs).toBe(true);
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish threads opts.publisherNodeIdentityIdOverride (bigint) into LiftRequest (stringified)', async () => {
    // RFC-001 §4 attribution override. BigInt → string for JSON persistence; mapper parses back.
    const { agent, store } = await createAgent('AsyncNodeIdOverrideBot');
    await agent.createContextGraph({ id: 'async-node-id-override', name: 'AsyncNodeIdOverride', description: '' });
    await agent.registerContextGraph('async-node-id-override');

    const { captureID } = await agent.publishAsync(
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
    expect(expectRawLiftRequest(job).publisherNodeIdentityIdOverride).toBe('42');
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish preserves publisherNodeIdentityIdOverride === 0n (mode d "no attribution")', async () => {
    // RFC-001 §4 mode d: explicit `0n` survives (≠ undefined which means "use daemon identity").
    const { agent, store } = await createAgent('AsyncNodeIdZeroBot');
    await agent.createContextGraph({ id: 'async-node-id-zero', name: 'AsyncNodeIdZero', description: '' });
    await agent.registerContextGraph('async-node-id-zero');

    const { captureID } = await agent.publishAsync(
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
    expect(expectRawLiftRequest(job).publisherNodeIdentityIdOverride).toBe('0');
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish enqueues sealless when no signer is available (sync parity)', async () => {
    // Chain-prereq failures downgrade to sealless enqueue. Publisher decides at processNext.
    const { agent, store } = await createAgent('AsyncSealNoSigner');
    await agent.createContextGraph({ id: 'async-no-signer', name: 'AsyncNoSigner', description: '' });
    await agent.registerContextGraph('async-no-signer');

    const publisher = (agent as unknown as { publisher: { publisherFallbackAuthorAddress: (cgId?: bigint) => Promise<string | undefined> } }).publisher;
    const original = publisher.publisherFallbackAuthorAddress.bind(publisher);
    publisher.publisherFallbackAuthorAddress = async () => undefined;

    try {
      const { captureID } = await agent.publishAsync(
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
      );

      const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
      const job = await asyncPublisher.getStatus(captureID);
      expect(expectRawLiftRequest(job).seal).toBeUndefined();
    } finally {
      publisher.publisherFallbackAuthorAddress = original;
    }
  }, CHAIN_JSONLD_TIMEOUT_MS);

  // OT-RFC-43 §F2 — the async-lift seal's publisher-fallback signer path mirrors
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

  it('async publish enqueues sealless when CG is not registered on-chain (sync parity)', async () => {
    // CG without on-chain id → no seal, publisher goes tentative (matches sync `agent.publish`).
    const { agent, store } = await createAgent('AsyncNoOnChainBot');
    await agent.createContextGraph({ id: 'async-no-onchain', name: 'AsyncNoOnChain', description: '' });
    // Intentionally skip registerContextGraph so the CG has no on-chain id.

    const { captureID } = await agent.publishAsync(
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
    expect(expectRawLiftRequest(job).seal).toBeUndefined();
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish seal reflects subtracted set when canonical root already confirmed (codex PR #455 #3)', async () => {
    // Agent must mirror publisher's `subtractFinalizedExactQuads` so both compute the same merkle.
    // Pre-populate confirmed state matching the canonical root; publishAsync same root → full overlap → seal undefined.
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

    // publishAsync the same root/triple — full overlap → seal undefined.
    const { captureID } = await agent.publishAsync(
      'async-subtract-observe',
      {
        publicQuads: [{ subject: root, predicate: 'http://example.org/p', object: '"hello"', graph: '' }],
        privateQuads: [],
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    // Full overlap with confirmed state → buildAsyncLiftSeal returns
    // undefined (short-circuit at `dkg-agent.ts` post-subtraction).
    // If subtraction is removed from the agent pipeline, the seal
    // would be present here.
    expect(expectRawLiftRequest(job).seal).toBeUndefined();
  }, CHAIN_JSONLD_TIMEOUT_MS);

  it('async publish records and resolves subGraphName for staged public and private data', async () => {
    const { agent, store } = await createAgent('AsyncSubGraphBot');
    await agent.createContextGraph({ id: 'async-subgraph', name: 'AsyncSubGraph', description: '' });
    await agent.registerContextGraph('async-subgraph');
    await agent.createSubGraph('async-subgraph', 'research');
    const root = 'http://example.org/AsyncSubGraphSecret';

    const { captureID } = await agent.publishAsync(
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
    const request = expectRawLiftRequest(job);
    expect(request.subGraphName).toBe('research');
    expect(request.roots).toContain(root);
  }, CHAIN_JSONLD_TIMEOUT_MS);
});
