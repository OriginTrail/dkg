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

describe('Genesis Knowledge', () => {


  	  it('requires address-scoped curator authority for on-chain registration', async () => {
      const store = new OxigraphStore();
      const chain = new CapturingContextGraphChainAdapter();
      const agent = await DKGAgent.create({
        name: 'RegistrationOwnerBot',
        store,
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      const nonDefaultAddr = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const siblingAddr = new ethers.Wallet(HARDHAT_KEYS.REC2_OP).address;

      await agent.createContextGraph({
        id: 'register-owner-agent',
        name: 'Owner Agent',
        callerAgentAddress: nonDefaultAddr,
      });

      await expect(agent.registerContextGraph('register-owner-agent'))
        .rejects.toThrow(/Only the context graph curator can register/);
      await expect(agent.registerContextGraph('register-owner-agent', { callerAgentAddress: siblingAddr }))
        .rejects.toThrow(/Only the context graph curator can register/);
      await expect(agent.registerContextGraph('register-owner-agent', { callerAgentAddress: nonDefaultAddr }))
        .resolves.toMatchObject({ onChainId: expect.any(String) });

      await agent.createContextGraph({ id: 'register-legacy-peer-curator', name: 'Legacy Peer Curator' });
      const legacyMetaGraph = contextGraphMetaUri('register-legacy-peer-curator');
      const legacyUri = 'did:dkg:context-graph:register-legacy-peer-curator';
      await store.deleteByPattern({
        graph: legacyMetaGraph,
        subject: legacyUri,
        predicate: DKG_ONTOLOGY.DKG_CURATOR,
      });
      await store.insert([{
        graph: legacyMetaGraph,
        subject: legacyUri,
        predicate: DKG_ONTOLOGY.DKG_CURATOR,
        object: `did:dkg:agent:${agent.peerId}`,
      }]);
      await expect(agent.registerContextGraph('register-legacy-peer-curator', { callerAgentAddress: nonDefaultAddr }))
        .resolves.toMatchObject({ onChainId: expect.any(String) });

      await agent.createContextGraph({ id: 'register-foreign-peer-only', name: 'Foreign Peer Only' });
      const contextGraphUri = 'did:dkg:context-graph:register-foreign-peer-only';
      await store.deleteByPattern({ graph: 'did:dkg:context-graph:register-foreign-peer-only/_meta', subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR });
      await store.deleteByPattern({ graph: 'did:dkg:context-graph:ontology', subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR });
      await store.insert([
        {
          graph: 'did:dkg:context-graph:ontology',
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_CREATOR,
          object: 'did:dkg:agent:12D3KooWForeignCreatorPeer111111111111111111111111',
        },
      ]);
      // The raw store.insert/deleteByPattern above forge a foreign-created CG
      // out-of-band, bypassing the write path that would normally invalidate the
      // ContextGraphMetaProjection (real sync calls markDirtyFromQuads after
      // store.insert — see dkg-agent-lifecycle.ts). Invalidate it here so the
      // projection re-reads the forged creator instead of the stale self-stamp.
      (agent as any).contextGraphMetaProjection.markDirty('register-foreign-peer-only');

      await expect(agent.registerContextGraph('register-foreign-peer-only'))
        .rejects.toThrow(/has no address-scoped curator/);

      await agent.stop().catch(() => {});
    });


    it('validates CCL policy content before publish', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'ValidateBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();
      await agent.createContextGraph({ id: 'ops-validate', name: 'Ops Validate' });

      await expect(agent.publishCclPolicy({
        contextGraphId: 'ops-validate',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: wrong-name
version: 0.1.0
rules: []
decisions: []
`,
      })).rejects.toThrow(/name mismatch/);

      await expect(agent.publishCclPolicy({
        contextGraphId: 'ops-validate',
        name: 'incident-review',
        version: '0.1.0',
        content: 'rules: []',
      })).rejects.toThrow(/must define a string "policy" name/);

      await agent.stop().catch(() => {});
    });


    it('rejects conflicting CCL republish for the same name and version', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'CollisionBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();
      await agent.createContextGraph({ id: 'ops-collision', name: 'Ops Collision' });

      await agent.publishCclPolicy({
        contextGraphId: 'ops-collision',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });

      await expect(agent.publishCclPolicy({
        contextGraphId: 'ops-collision',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules:
  - name: flagged
    params: [Claim]
    all:
      - atom: { pred: claim, args: ["$Claim"] }
decisions: []
`,
      })).rejects.toThrow(/already exists with different content/);

      await agent.stop().catch(() => {});
    });


    it('resolves canonical snapshot facts and evaluates bundled policies without caller facts', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'SnapshotBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();
      await agent.createContextGraph({ id: 'ops-snapshot', name: 'Ops Snapshot' });

      const published = await agent.publishCclPolicy({
        contextGraphId: 'ops-snapshot',
        name: 'owner_assertion',
        version: '0.1.0',
        content: `policy: owner_assertion
version: 0.1.0
rules:
  - name: owner_asserted
    params: [Claim]
    all:
      - atom: { pred: claim, args: ["$Claim"] }
      - exists:
          where:
            - atom: { pred: owner_of, args: ["$Claim", "$Agent"] }
            - atom: { pred: signed_by, args: ["$Claim", "$Agent"] }
decisions:
  - name: propose_accept
    params: [Claim]
    all:
      - atom: { pred: owner_asserted, args: ["$Claim"] }
`,
      });
      await agent.approveCclPolicy({ contextGraphId: 'ops-snapshot', policyUri: published.policyUri });

      await store.insert(buildSnapshotFactQuads({
        contextGraphId: 'ops-snapshot',
        snapshotId: 'snap-owner-01',
        view: 'accepted',
        scopeUal: 'ual:dkg:example:owner-assertion',
        facts: [
          ['signed_by', 'p1', '0xalice'],
          ['claim', 'p1'],
          ['owner_of', 'p1', '0xalice'],
        ],
      }));

      const resolved = await agent.resolveFactsFromSnapshot({
        contextGraphId: 'ops-snapshot',
        policyName: 'owner_assertion',
        snapshotId: 'snap-owner-01',
        view: 'accepted',
        scopeUal: 'ual:dkg:example:owner-assertion',
      });

      expect(resolved.factResolutionMode).toBe('snapshot-resolved');
      expect(resolved.factResolverVersion).toBe('canonical-input-facts/v1');
      expect(resolved.facts).toEqual([
        ['claim', 'p1'],
        ['owner_of', 'p1', '0xalice'],
        ['signed_by', 'p1', '0xalice'],
      ]);

      const evaluation = await agent.evaluateCclPolicy({
        contextGraphId: 'ops-snapshot',
        name: 'owner_assertion',
        snapshotId: 'snap-owner-01',
        view: 'accepted',
        scopeUal: 'ual:dkg:example:owner-assertion',
      });

      expect(evaluation.factResolutionMode).toBe('snapshot-resolved');
      expect(evaluation.factQueryHash).toContain('sha256:');
      expect(evaluation.result.derived.owner_asserted).toEqual([['p1']]);
      expect(evaluation.result.decisions.propose_accept).toEqual([['p1']]);

      await agent.stop().catch(() => {});
    });


    it('resolves the same snapshot facts deterministically across nodes', async () => {
      const snapshotFacts: Array<[string, ...unknown[]]> = [
        ['signed_by', 'p1', '0xalice'],
        ['claim', 'p1'],
        ['owner_of', 'p1', '0xalice'],
      ];
      const quads = buildSnapshotFactQuads({
        contextGraphId: 'ops-deterministic',
        snapshotId: 'snap-owner-02',
        view: 'accepted',
        scopeUal: 'ual:dkg:example:owner-assertion',
        facts: snapshotFacts,
      });

      const storeA = new OxigraphStore();
      const storeB = new OxigraphStore();
      await storeA.insert(quads);
      await storeB.insert(quads);

      const agentA = await DKGAgent.create({ name: 'DeterministicA', store: storeA, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });
      const agentB = await DKGAgent.create({ name: 'DeterministicB', store: storeB, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });

      const resolvedA = await agentA.resolveFactsFromSnapshot({
        contextGraphId: 'ops-deterministic',
        policyName: 'owner_assertion',
        snapshotId: 'snap-owner-02',
        view: 'accepted',
        scopeUal: 'ual:dkg:example:owner-assertion',
      });
      const resolvedB = await agentB.resolveFactsFromSnapshot({
        contextGraphId: 'ops-deterministic',
        policyName: 'owner_assertion',
        snapshotId: 'snap-owner-02',
        view: 'accepted',
        scopeUal: 'ual:dkg:example:owner-assertion',
      });

      expect(resolvedA.facts).toEqual(resolvedB.facts);
      expect(resolvedA.factSetHash).toBe(resolvedB.factSetHash);
      expect(resolvedA.factQueryHash).toBe(resolvedB.factQueryHash);
      expect(resolvedA.factResolverVersion).toBe(resolvedB.factResolverVersion);
    });


    it('matches the reference evaluator across bundled CCL cases', async () => {
      const casesDir = fileURLToPath(new URL('../../../ccl_v0_1/tests/cases', import.meta.url));
      const policiesDir = fileURLToPath(new URL('../../../ccl_v0_1/policies', import.meta.url));
      const caseFiles = (await readdir(casesDir)).filter(name => name.endsWith('.yaml')).sort();

      for (const caseFile of caseFiles) {
        const testCase = loadYaml(join(casesDir, caseFile));
        const policyBody = await readFile(join(policiesDir, testCase.policy), 'utf8');
        const parsed = parseCclPolicy(policyBody);
        const agentResult = new CclEvaluator(parsed, testCase.facts).run();
        const referenceResult = new ReferenceEvaluator(parsed, testCase.facts).run();
        expect(agentResult).toEqual(referenceResult);
        expect(agentResult).toEqual(testCase.expected);
      }
    });
});
