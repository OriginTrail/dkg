import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import { buildAuthorAttestationTypedData } from '@origintrail-official/dkg-core';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

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
const stores: OxigraphStore[] = [];

async function createAgent(name: string) {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name,
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    store,
    nodeRole: 'core',
  });
  agents.push(agent);
  stores.push(store);
  await agent.start();
  return { agent, store };
}

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch { /* teardown best-effort */ }
  }
  agents.length = 0;
  stores.length = 0;
});

describe('publishJsonLd', () => {
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

    const publicResult = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:bare-priv> { ?s ?p ?o } }`,
    );
    expect(publicResult.type).toBe('boolean');
    if (publicResult.type === 'boolean') {
      expect(publicResult.value).toBe(true);
    }
  }, 15000);

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

    const askResult = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:pub-env> { <http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Person> } }`,
    );
    expect(askResult.type).toBe('boolean');
    if (askResult.type === 'boolean') {
      expect(askResult.value).toBe(true);
    }
  }, 15000);

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
      `ASK { GRAPH <did:dkg:context-graph:split-test> { <http://example.org/Carol> <http://schema.org/name> ?name } }`,
    );
    expect(publicName.type).toBe('boolean');
    if (publicName.type === 'boolean') expect(publicName.value).toBe(true);

    const privateGraph = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:split-test/_private> { ?s ?p ?o } }`,
    );
    if (privateGraph.type === 'boolean') {
      expect(privateGraph.value).toBe(true);
    }
  }, 15000);

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

    const anchorResult = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:priv-only> { ?s ?p ?o } }`,
    );
    expect(anchorResult.type).toBe('boolean');
    if (anchorResult.type === 'boolean') expect(anchorResult.value).toBe(true);
  }, 15000);

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
  }, 15000);

  it('throws on JSON-LD that produces no quads', async () => {
    const { agent } = await createAgent('ErrorBot');
    await agent.createContextGraph({ id: 'error-test', name: 'Err', description: '' });

    await expect(agent.publish('error-test', {})).rejects.toThrow(
      'JSON-LD document produced no RDF quads',
    );
  }, 15000);

  it('existing Quad[] publish still works unchanged', async () => {
    const { agent } = await createAgent('QuadBot');
    await agent.createContextGraph({ id: 'quad-test', name: 'QT', description: '' });
    await agent.registerContextGraph('quad-test');

    const result = await agent.publish('quad-test', [
      { subject: 'did:dkg:test:X', predicate: 'http://schema.org/name', object: '"X"', graph: '' },
    ]);
    expect(result.status).toBe('confirmed');
  }, 15000);

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
    expect(job?.request.roots).toEqual([root]);
    expect(job?.request.accessPolicy).toBe('allowList');
    expect(job?.request.allowedPeers).toEqual(['peer-a']);
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
  }, 15000);

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
    expect(job?.request.roots).toEqual([root]);
    expect(job?.request.accessPolicy).toBe('ownerOnly');

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
  }, 15000);

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
        getLatestMerkleRootAuthor: (kcId: bigint) => Promise<string>;
      };
    }).chain;
    const kcId = (finalized as any)?.broadcast?.batchId
      ?? (finalized as any)?.inclusion?.batchId
      ?? (finalized as any)?.finalization?.batchId;
    expect(kcId).toBeDefined();
    const onChainAuthor = await chainAdapter.getLatestMerkleRootAuthor(BigInt(kcId));
    expect(onChainAuthor.toLowerCase()).toBe(tenant.agentAddress.toLowerCase());
    expect(onChainAuthor.toLowerCase()).not.toBe(publisherAddress.toLowerCase());
  }, 60_000);

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
    const seal = job?.request.seal;
    expect(seal).toBeDefined();
    expect(seal?.authorAddress.toLowerCase()).toBe(tenant.agentAddress.toLowerCase());
    expect(seal?.authorAddress.toLowerCase()).not.toBe(
      new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address.toLowerCase(),
    );

    // The signature must recover to the registered agent's address —
    // confirms the daemon's custodial key for THIS agent was the one
    // that signed, not the publisher fallback path.
    const onChainId = (await agent.getContextGraphOnChainId('async-seal-distinct')) as string;
    const kav10Address = await (agent as unknown as {
      chain: { getKnowledgeAssetsV10Address(): Promise<string> };
    }).chain.getKnowledgeAssetsV10Address();
    const chainId = await (agent as unknown as {
      chain: { getEvmChainId(): Promise<bigint> };
    }).chain.getEvmChainId();
    const merkleRootBytes = ethers.getBytes(seal!.merkleRoot);
    const typed = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: BigInt(onChainId),
      merkleRoot: merkleRootBytes,
      authorAddress: seal!.authorAddress,
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
  }, 30_000);

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
  }, 30_000);

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
    const seal = job?.request.seal;
    expect(seal).toBeDefined();
    expect(seal?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.authorAddress).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(seal?.signature.r).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.signature.vs).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.schemeVersion).toBe(1);
  }, 30_000);

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
    expect(job?.request.seal).toBeUndefined();
  }, 30_000);

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
    expect(job?.request.seal).toBeDefined();
    expect(job?.request.seal?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 30_000);

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
    expect(job?.request.seal).toBeDefined();
  }, 30_000);

  it('async publish accepts preSignedAuthorAttestation and threads it byte-for-byte into LiftRequest.seal', async () => {
    // Sync parity: caller pre-signs off-node, agent threads bytes verbatim. Publisher preflight validates at processNext.
    const { agent, store } = await createAgent('AsyncSealPreSignedBot');
    await agent.createContextGraph({ id: 'async-seal-presigned', name: 'AsyncSealPreSigned', description: '' });
    await agent.registerContextGraph('async-seal-presigned');

    // Arbitrary bytes — this test is passthrough wiring, not seal validity.
    const expectedMerkleRoot = new Uint8Array(32).fill(0xab);
    const customAuthor = '0xAaaAAaaaAaaaaaAAAaAaaaaaAAAaaaaAaAaAAaaA';
    const sigR = new Uint8Array(32).fill(0xbb);
    const sigVs = new Uint8Array(32).fill(0xcc);

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
        },
      },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const seal = job?.request.seal;
    expect(seal).toBeDefined();
    expect(seal?.merkleRoot).toBe('0x' + 'ab'.repeat(32));
    expect(seal?.authorAddress.toLowerCase()).toBe(customAuthor.toLowerCase());
    expect(seal?.signature.r).toBe('0x' + 'bb'.repeat(32));
    expect(seal?.signature.vs).toBe('0x' + 'cc'.repeat(32));
    expect(seal?.schemeVersion).toBe(1);
  }, 30_000);

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
  }, 15_000);

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

    let typedDataReceived: { domain: unknown; types: unknown; message: { authorAddress: string; merkleRoot: string } } | null = null;
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
    const seal = job?.request.seal;
    expect(seal).toBeDefined();
    expect(seal?.authorAddress.toLowerCase()).toBe(selfSov.agentAddress.toLowerCase());

    // Recovered signer must match the self-sovereign EOA, not the publisher.
    const onChainId = (await agent.getContextGraphOnChainId('async-seal-callback')) as string;
    const kav10Address = await (agent as unknown as {
      chain: { getKnowledgeAssetsV10Address(): Promise<string> };
    }).chain.getKnowledgeAssetsV10Address();
    const chainId = await (agent as unknown as {
      chain: { getEvmChainId(): Promise<bigint> };
    }).chain.getEvmChainId();
    const typed = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: BigInt(onChainId),
      merkleRoot: ethers.getBytes(seal!.merkleRoot),
      authorAddress: seal!.authorAddress,
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
  }, 30_000);

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
  }, 15_000);

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
      chain: { getLatestMerkleRootAuthor: (kcId: bigint) => Promise<string> };
    }).chain;
    const kcId = (finalized as any)?.broadcast?.batchId
      ?? (finalized as any)?.inclusion?.batchId
      ?? (finalized as any)?.finalization?.batchId;
    expect(kcId).toBeDefined();
    const onChainAuthor = await chainAdapter.getLatestMerkleRootAuthor(BigInt(kcId));
    expect(onChainAuthor.toLowerCase()).toBe(selfSov.agentAddress.toLowerCase());
    expect(onChainAuthor.toLowerCase()).not.toBe(publisherAddress.toLowerCase());
  }, 60_000);

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
    expect(job?.request.priorVersion).toBe('did:dkg:mock:31337/0xabc/7');
    expect(job?.request.transitionType).toBe('MUTATE');
  }, 15_000);

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
    expect(job?.request.entityProofs).toBe(true);
  }, 15_000);

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
    expect(job?.request.publisherNodeIdentityIdOverride).toBe('42');
  }, 15_000);

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
    expect(job?.request.publisherNodeIdentityIdOverride).toBe('0');
  }, 15_000);

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
      expect(job?.request.seal).toBeUndefined();
    } finally {
      publisher.publisherFallbackAuthorAddress = original;
    }
  }, 15_000);

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
  }, 30_000);

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
    expect(job?.request.seal).toBeUndefined();
  }, 15_000);

  it('async publish seal reflects subtracted set when canonical root already confirmed (codex PR #455 #3)', async () => {
    // Agent must mirror publisher's `subtractFinalizedExactQuads` so both compute the same merkle.
    // Pre-populate confirmed state matching the canonical root; publishAsync same root → full overlap → seal undefined.
    const { agent, store } = await createAgent('AsyncSubtractObserve');
    await agent.createContextGraph({ id: 'async-subtract-observe', name: 'AsyncSubtractObs', description: '' });
    await agent.registerContextGraph('async-subtract-observe');

    const root = 'http://example.org/AlreadyPublished';
    const namespace = 'async-publish';
    const scope = 'context-graph';
    // Mirror `canonicalRootIri` in async-lift-validation.ts: slugged
    // (cgId:ns:scope) + rootTail + first-6-byte sha256 hex digest.
    const { sha256 } = await import('@origintrail-official/dkg-core');
    const slug = (v: string) =>
      v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
    const rootTail = (() => {
      const i = Math.max(root.lastIndexOf('/'), root.lastIndexOf(':'));
      return i >= 0 ? root.slice(i + 1) : root;
    })();
    const rootHash = Array.from(sha256(new TextEncoder().encode(root)))
      .slice(0, 6)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const canonical = `dkg:${slug('async-subtract-observe')}:${slug(namespace)}:${slug(scope)}/${slug(rootTail)}-${rootHash}`;
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
    expect(job?.request.seal).toBeUndefined();
  }, 20_000);

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
    expect(job?.request.subGraphName).toBe('research');
    expect(job?.request.roots).toContain(root);
  }, 15000);
});
