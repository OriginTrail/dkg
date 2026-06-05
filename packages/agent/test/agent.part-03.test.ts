import { describe, it, expect, beforeAll, afterAll, vi, DKGAgentWallet, buildAgentProfile, collectPublishableMultiaddrs, CclEvaluator, DiscoveryClient, ProfileManager, encrypt, decrypt, ed25519ToX25519Private, ed25519ToX25519Public, x25519SharedSecret, DKGAgent, AGENT_REGISTRY_CONTEXT_GRAPH, parseCclPolicy, OxigraphStore, getGenesisQuads, computeNetworkId, PROTOCOL_SYNC, PROTOCOL_STORAGE_ACK, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphWorkspaceGraphUri, contextGraphMetaUri, sparqlString, DKGQueryEngine, sha256, EVMChainAdapter, MockChainAdapter, createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS, mintTokens, ethers, tmpdir, mkdtemp, readFile, readdir, rm, join, fileURLToPath, _wrapAgentPublisherForSeal, CapturingContextGraphChainAdapter, AsyncSignerAddressContextGraphChainAdapter, SignerListContextGraphChainAdapter, PcaCuratedRegistrationChainAdapter, NonRegisteringACKChainAdapter, FlakyRegistrationACKChainAdapter, TransientIdentityFailureChainAdapter, BrandNewCoreTransientChainAdapter, PermanentProfileFailureChainAdapter, RetryPathPermanentFailureChainAdapter, ContextAuthorizedPublisherChainAdapter, buildSnapshotFactQuads, ReferenceEvaluator, loadYaml, CCL_FACT_NS, OperationalKeyOnlyPublishChainAdapter, ExternalOperationalKeyPublishChainAdapter, AddressOnlyExternalOperationalKeyPublishChainAdapter, AsyncAddressSignMessageAsPublishChainAdapter, GenericSignMessageExternalOperationalKeyPublishChainAdapter, MultiSignerGenericSignMessagePublishChainAdapter, SingleAddressMismatchedGenericSignMessagePublishChainAdapter, SingleSignerAdapterPublishChainAdapter, ReservingAuthorityContextGraphChainAdapter, type Quad, type ChainAdapter, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type OnChainPublishResult, type V10PublishDirectParams } from './agent.shared';



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

describe('ProfileManager', () => {

    it('publishes a profile as a KC via the Publisher', async () => {
      const store = new OxigraphStore();
      const { DKGPublisher } = await import('@origintrail-official/dkg-publisher');
      const { TypedEventBus, generateEd25519Keypair } = await import('@origintrail-official/dkg-core');
      const eventBus = new TypedEventBus();
      const keypair = await generateEd25519Keypair();
      const publisher = new DKGPublisher({
        store,
        chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        eventBus,
        keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      });

      const manager = new ProfileManager(publisher, store);
      const result = await manager.publishProfile({
        peerId: 'QmManaged',
        name: 'ManagedBot',
        framework: 'LangChain',
        skills: [{ skillType: 'Translation', pricePerCall: 0.3, currency: 'TRAC' }],
      });

      expect(result.kaId).toBeDefined();
      expect(result.kaManifest.length).toBeGreaterThan(0);
      expect(manager.profileKcId).toBe(result.kaId);
    });


    it(
      'A-12 upgrade: republishing after the DID form change drops the legacy ' +
        'did:dkg:agent:<peerId> subject alongside the new address-form subject',
      async () => {
        // Codex review on PR #243: ProfileManager.publishProfile only
        // deleted triples under the NEW rootEntity before publish, so an
        // upgraded node that previously published
        // `did:dkg:agent:<peerId>` would keep the old profile alongside
        // the new `did:dkg:agent:0x...` profile. `findAgents` then
        // returned the same node twice and the local data graph no
        // longer matched the updated manifest. This test simulates the
        // upgrade by publishing in legacy form first, then
        // republishing in the new form, and asserting the legacy
        // subject is gone.
        const store = new OxigraphStore();
        const { DKGPublisher } = await import('@origintrail-official/dkg-publisher');
        const { TypedEventBus, generateEd25519Keypair } = await import('@origintrail-official/dkg-core');
        const eventBus = new TypedEventBus();
        const keypair = await generateEd25519Keypair();
        const publisher = new DKGPublisher({
          store,
          chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
          eventBus,
          keypair,
          publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        });
        const manager = new ProfileManager(publisher, store);

        const peerId = 'QmLegacyUpgrade';
        const addr = '0x' + 'ab'.repeat(20);

        // Legacy publish (no agentAddress) → DID = did:dkg:agent:<peerId>
        await manager.publishProfile({ peerId, name: 'Legacy', skills: [] });
        const graph = 'did:dkg:context-graph:agents';
        const legacyCount = await store.countQuads(graph);
        expect(legacyCount).toBeGreaterThan(0);

        const legacySubject = `did:dkg:agent:${peerId}`;
        const newSubject = `did:dkg:agent:${addr}`;

        // Sanity: legacy subject really was written.
        const legacyRows = await store.query(
          `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${legacySubject}> ?p ?o } }`,
        );
        expect(legacyRows.type).toBe('bindings');
        if (legacyRows.type === 'bindings') {
          expect(legacyRows.bindings.length).toBeGreaterThan(0);
        }

        // Upgrade publish — same peerId, now with an agentAddress.
        await manager.publishProfile({
          peerId,
          agentAddress: addr,
          name: 'Upgraded',
          skills: [],
        });

        // The legacy subject must no longer appear in the data graph.
        const stillLegacy = await store.query(
          `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${legacySubject}> ?p ?o } }`,
        );
        expect(stillLegacy.type).toBe('bindings');
        if (stillLegacy.type === 'bindings') {
          expect(
            stillLegacy.bindings.length,
            'legacy did:dkg:agent:<peerId> subject must be removed on A-12 upgrade',
          ).toBe(0);
        }

        // The new subject is the sole profile root in the data graph.
        const newRows = await store.query(
          `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${newSubject}> ?p ?o } }`,
        );
        expect(newRows.type).toBe('bindings');
        if (newRows.type === 'bindings') {
          expect(newRows.bindings.length).toBeGreaterThan(0);
          const nameTriples = newRows.bindings.filter((b) =>
            b['p']?.includes('schema.org/name'),
          );
          expect(nameTriples.some((b) => b['o'] === '"Upgraded"')).toBe(true);
        }
      },
    );


    it(
      'A-12 wallet rotation + restart: peerId-scan reaches profiles from a prior wallet even with a fresh ProfileManager',
      async () => {
        // Codex review on PR #243: `lastRootEntity` is only in memory.
        // If an operator publishes under wallet A, the daemon restarts,
        // they reconfigure to wallet B, and publish again, the in-memory
        // cleanup path sees only the new canonical address (B) and the
        // peerId fallback — wallet A's profile would be orphaned.
        //
        // The mitigation is the SPARQL scan in
        // `ProfileManager.publishProfile` that discovers every subject
        // in the registry graph that claims this peerId. This test
        // simulates the restart by constructing a fresh ProfileManager
        // for the second publish, proving the scan — not
        // `lastRootEntity` — is what cleans up wallet A.
        const store = new OxigraphStore();
        const { DKGPublisher } = await import('@origintrail-official/dkg-publisher');
        const { TypedEventBus, generateEd25519Keypair } = await import('@origintrail-official/dkg-core');
        const eventBus = new TypedEventBus();
        const keypair = await generateEd25519Keypair();

        const peerId = 'QmRotatedWallet';
        const walletA = '0x' + 'aa'.repeat(20);
        const walletB = '0x' + 'bb'.repeat(20);

        // Publish under wallet A.
        const publisher1 = new DKGPublisher({
          store,
          chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
          eventBus,
          keypair,
          publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        });
        const managerA = new ProfileManager(publisher1, store);
        await managerA.publishProfile({
          peerId,
          agentAddress: walletA,
          name: 'WalletA',
          skills: [],
        });

        const graph = 'did:dkg:context-graph:agents';
        const subjectA = `did:dkg:agent:${walletA}`;
        const subjectB = `did:dkg:agent:${walletB}`;

        // Sanity: wallet A's subject is present.
        const afterA = await store.query(
          `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${subjectA}> ?p ?o } }`,
        );
        expect(afterA.type).toBe('bindings');
        if (afterA.type === 'bindings') {
          expect(afterA.bindings.length).toBeGreaterThan(0);
        }

        // Simulate a daemon restart + wallet rotation — brand new
        // ProfileManager with NO lastRootEntity memory, but the same
        // store + peerId + a NEW wallet.
        const publisher2 = new DKGPublisher({
          store,
          chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
          eventBus,
          keypair,
          publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
        });
        const managerB = new ProfileManager(publisher2, store);
        await managerB.publishProfile({
          peerId,
          agentAddress: walletB,
          name: 'WalletB',
          skills: [],
        });

        // Wallet A's subject must be gone even though ProfileManager
        // had no in-memory record of it.
        const stillA = await store.query(
          `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${subjectA}> ?p ?o } }`,
        );
        expect(stillA.type).toBe('bindings');
        if (stillA.type === 'bindings') {
          expect(
            stillA.bindings.length,
            'peerId-scan must remove wallet A profile across a ProfileManager restart',
          ).toBe(0);
        }

        // Wallet B's subject is the sole remaining profile root for
        // this peerId.
        const afterB = await store.query(
          `SELECT ?p ?o WHERE { GRAPH <${graph}> { <${subjectB}> ?p ?o } }`,
        );
        expect(afterB.type).toBe('bindings');
        if (afterB.type === 'bindings') {
          expect(afterB.bindings.length).toBeGreaterThan(0);
          const nameTriples = afterB.bindings.filter((b) =>
            b['p']?.includes('schema.org/name'),
          );
          expect(nameTriples.some((b) => b['o'] === '"WalletB"')).toBe(true);
        }
      },
    );


    it(
      'A-12 casing: checksum-case and lowercase agentAddress converge to the same DID subject',
      () => {
        const checksum = '0xAb5801a7D398351b8bE11C439e05C5B3259aec9B';
        const lower = checksum.toLowerCase();
        const profileChecksum = buildAgentProfile({
          peerId: 'QmNoOp',
          agentAddress: checksum,
          name: 'Checksum',
          skills: [],
        });
        const profileLower = buildAgentProfile({
          peerId: 'QmNoOp',
          agentAddress: lower,
          name: 'Lower',
          skills: [],
        });
        expect(profileChecksum.rootEntity).toBe(profileLower.rootEntity);
        expect(profileChecksum.rootEntity).toBe(`did:dkg:agent:${lower}`);
      },
    );


    it('cleans up stale profile triples before re-publishing', async () => {
      const store = new OxigraphStore();
      const { DKGPublisher } = await import('@origintrail-official/dkg-publisher');
      const { TypedEventBus, generateEd25519Keypair } = await import('@origintrail-official/dkg-core');
      const eventBus = new TypedEventBus();
      const keypair = await generateEd25519Keypair();
      const publisher = new DKGPublisher({
        store,
        chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        eventBus,
        keypair,
        publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      });

      const manager = new ProfileManager(publisher, store);

      // First publish
      await manager.publishProfile({
        peerId: 'QmStale',
        name: 'OldName',
        framework: 'DKG',
        skills: [],
      });

      // Verify OldName is stored in the data graph
      const graph = 'did:dkg:context-graph:agents';
      const oldCount = await store.countQuads(graph);
      expect(oldCount).toBeGreaterThan(0);

      // Second publish with different name — should replace, not accumulate
      await manager.publishProfile({
        peerId: 'QmStale',
        name: 'NewName',
        framework: 'DKG',
        skills: [],
      });

      const newCount = await store.countQuads(graph);

      // Data graph triple count should stay the same (old cleaned up, new inserted)
      expect(newCount).toBe(oldCount);

      // The data graph should contain NewName, not OldName
      const result = await store.query(
        `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        const nameTriples = result.bindings.filter(b => b['p']?.includes('schema.org/name'));
        expect(nameTriples.length).toBeGreaterThan(0);
        expect(nameTriples.some(b => b['o'] === '"NewName"')).toBe(true);
        expect(nameTriples.every(b => b['o'] !== '"OldName"')).toBe(true);
      }
    });
});
