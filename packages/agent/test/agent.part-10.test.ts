import { describe, it, expect, beforeAll, afterAll, vi, DKGAgentWallet, buildAgentProfile, collectPublishableMultiaddrs, CclEvaluator, CclResourceNotFoundError, DiscoveryClient, ProfileManager, encrypt, decrypt, ed25519ToX25519Private, ed25519ToX25519Public, x25519SharedSecret, DKGAgent, AGENT_REGISTRY_CONTEXT_GRAPH, parseCclPolicy, OxigraphStore, getGenesisQuads, computeNetworkId, PROTOCOL_SYNC, PROTOCOL_STORAGE_ACK, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphWorkspaceGraphUri, contextGraphMetaUri, sparqlString, DKGQueryEngine, sha256, EVMChainAdapter, MockChainAdapter, createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS, mintTokens, ethers, tmpdir, mkdtemp, readFile, readdir, rm, join, fileURLToPath, _wrapAgentPublisherForSeal, CapturingContextGraphChainAdapter, AsyncSignerAddressContextGraphChainAdapter, SignerListContextGraphChainAdapter, PcaCuratedRegistrationChainAdapter, NonRegisteringACKChainAdapter, FlakyRegistrationACKChainAdapter, TransientIdentityFailureChainAdapter, BrandNewCoreTransientChainAdapter, PermanentProfileFailureChainAdapter, RetryPathPermanentFailureChainAdapter, ContextAuthorizedPublisherChainAdapter, buildSnapshotFactQuads, ReferenceEvaluator, loadYaml, CCL_FACT_NS, OperationalKeyOnlyPublishChainAdapter, ExternalOperationalKeyPublishChainAdapter, AddressOnlyExternalOperationalKeyPublishChainAdapter, AsyncAddressSignMessageAsPublishChainAdapter, GenericSignMessageExternalOperationalKeyPublishChainAdapter, MultiSignerGenericSignMessagePublishChainAdapter, SingleAddressMismatchedGenericSignMessagePublishChainAdapter, SingleSignerAdapterPublishChainAdapter, ReservingAuthorityContextGraphChainAdapter, type Quad, type ChainAdapter, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type OnChainPublishResult, type V10PublishDirectParams } from './agent.shared';



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

    it('produces deterministic genesis quads', () => {
      const quads = getGenesisQuads();
      expect(quads.length).toBeGreaterThan(20);

      const networkDef = quads.filter(q => q.subject === 'did:dkg:network:v9-testnet');
      expect(networkDef.length).toBeGreaterThan(0);

      const agentsContextGraph = quads.filter(q => q.graph === 'did:dkg:context-graph:agents');
      expect(agentsContextGraph.length).toBeGreaterThan(0);

      const ontology = quads.filter(q => q.graph === 'did:dkg:context-graph:ontology');
      expect(ontology.length).toBeGreaterThan(0);
    });


    it('computes a stable networkId', async () => {
      const id1 = await computeNetworkId();
      const id2 = await computeNetworkId();
      expect(id1).toBe(id2);
      expect(id1.length).toBe(64);
    });


    it('loads genesis into store on DKGAgent.create()', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'GenesisTest',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });

      const result = await store.query(
        `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v }`,
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        expect(result.bindings.length).toBe(1);
      }

      const contextGraphs = await store.query(
        `SELECT ?p WHERE { <did:dkg:context-graph:agents> a <https://dkg.network/ontology#SystemContextGraph> }`,
      );
      expect(contextGraphs.type).toBe('bindings');

      await agent.stop().catch(() => {});
    });

    it('loads the selected genesis into store and reports its network id', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'SelectedGenesisTest',
        genesisId: 'gnosis-mainnet',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });

      const selectedGenesis = await store.query(
        `SELECT ?v WHERE { <did:dkg:network:gnosis-mainnet> <https://dkg.network/ontology#genesisVersion> ?v }`,
      );
      expect(selectedGenesis.type).toBe('bindings');
      if (selectedGenesis.type === 'bindings') {
        expect(selectedGenesis.bindings.length).toBe(1);
      }

      const defaultGenesis = await store.query(
        `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v }`,
      );
      expect(defaultGenesis.type).toBe('bindings');
      if (defaultGenesis.type === 'bindings') {
        expect(defaultGenesis.bindings.length).toBe(0);
      }

      expect(await agent.networkId()).toBe(await computeNetworkId('gnosis-mainnet'));

      await agent.stop().catch(() => {});
    });

    it('rejects switching an existing store to a different genesis', async () => {
      const store = new OxigraphStore();
      const defaultAgent = await DKGAgent.create({
        name: 'DefaultGenesisStore',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await defaultAgent.stop().catch(() => {});

      await expect(DKGAgent.create({
        name: 'ForeignGenesisStore',
        genesisId: 'gnosis-mainnet',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      })).rejects.toThrow(/contains a different genesis/);
    });


    it('genesis loading is idempotent', async () => {
      const store = new OxigraphStore();
      const agent1 = await DKGAgent.create({ name: 'Idempotent1', store, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });
      const agent2 = await DKGAgent.create({ name: 'Idempotent2', store, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });

      const result = await store.query(
        `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v }`,
      );
      if (result.type === 'bindings') {
        expect(result.bindings.length).toBe(1);
      }

      await agent1.stop().catch(() => {});
      await agent2.stop().catch(() => {});
    });


    it('publishes, approves, lists, and resolves CCL policies per contextGraph', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'PolicyBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();

      await agent.createContextGraph({ id: 'ops-policy', name: 'Ops Policy' });

      const published = await agent.publishCclPolicy({
        contextGraphId: 'ops-policy',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });

      expect(published.policyUri).toContain('did:dkg:policy:');
      expect(published.hash).toContain('sha256:');

      await agent.approveCclPolicy({ contextGraphId: 'ops-policy', policyUri: published.policyUri });

      const listed = await agent.listCclPolicies({ contextGraphId: 'ops-policy' });
      expect(listed).toHaveLength(1);
      expect(listed[0].name).toBe('incident-review');
      expect(listed[0].isActiveDefault).toBe(true);

      const resolved = await agent.resolveCclPolicy({ contextGraphId: 'ops-policy', name: 'incident-review', includeBody: true });
      expect(resolved?.policyUri).toBe(published.policyUri);
      expect(resolved?.body).toContain('rules: []');

      const evaluation = await agent.evaluateCclPolicy({
        contextGraphId: 'ops-policy',
        name: 'incident-review',
        facts: [['claim', 'c1']],
        snapshotId: 'snap-1',
      });
      expect(evaluation.policy.policyUri).toBe(published.policyUri);
      expect(evaluation.factSetHash).toContain('sha256:');
      expect(evaluation.result.derived).toEqual({});

      const publishedEval = await agent.evaluateAndPublishCclPolicy({
        contextGraphId: 'ops-policy',
        name: 'incident-review',
        facts: [['claim', 'c1']],
        snapshotId: 'snap-2',
      });
      expect(publishedEval.evaluationUri).toContain('did:dkg:ccl-eval:');
      expect(publishedEval.publish.status).toBeDefined();

      const storedEval = await store.query(
        `SELECT ?hash WHERE { GRAPH <did:dkg:context-graph:ops-policy> { <${publishedEval.evaluationUri}> <https://dkg.network/ontology#factSetHash> ?hash } }`,
      );
      expect(storedEval.type).toBe('bindings');
      if (storedEval.type === 'bindings') {
        expect(storedEval.bindings.length).toBe(1);
      }

      const listedEvals = await agent.listCclEvaluations({
        contextGraphId: 'ops-policy',
        snapshotId: 'snap-2',
      });
      expect(listedEvals).toHaveLength(1);
      expect(listedEvals[0].evaluationUri).toBe(publishedEval.evaluationUri);
      expect(listedEvals[0].results).toEqual([]);

      await agent.stop().catch(() => {});
    });


    it('types real missing-policy and missing-binding failures for HTTP boundaries', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'MissingPolicyBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();
      await agent.createContextGraph({ id: 'ops-missing-policy', name: 'Missing Policy' });

      await expect(agent.approveCclPolicy({
        contextGraphId: 'ops-missing-policy',
        policyUri: 'did:dkg:policy:missing',
      })).rejects.toMatchObject({
        name: 'CclResourceNotFoundError',
        code: 'CCL_RESOURCE_NOT_FOUND',
        resource: 'policy',
      });
      await expect(agent.revokeCclPolicy({
        contextGraphId: 'ops-missing-policy',
        policyUri: 'did:dkg:policy:missing',
      })).rejects.toMatchObject({
        name: 'CclResourceNotFoundError',
        code: 'CCL_RESOURCE_NOT_FOUND',
        resource: 'policy_binding',
      });

      await agent.stop().catch(() => {});
    });


    it('treats an approved policy with a missing body as an integrity failure', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'IncompletePolicyBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();
      await agent.createContextGraph({ id: 'ops-incomplete-policy', name: 'Incomplete Policy' });
      const published = await agent.publishCclPolicy({
        contextGraphId: 'ops-incomplete-policy',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });
      await agent.approveCclPolicy({
        contextGraphId: 'ops-incomplete-policy',
        policyUri: published.policyUri,
      });
      await store.deleteByPattern({
        subject: published.policyUri,
        predicate: DKG_ONTOLOGY.DKG_POLICY_BODY,
        graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
      });

      let failure: unknown;
      try {
        await agent.evaluateCclPolicy({
          contextGraphId: 'ops-incomplete-policy',
          name: 'incident-review',
          facts: [],
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(CclResourceNotFoundError);
      expect(failure).toMatchObject({
        message: `CCL policy body missing: ${published.policyUri}`,
      });

      await agent.stop().catch(() => {});
    });


    it('prefers stricter per-context policy overrides when resolving CCL policy', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'ContextPolicyBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();

      await agent.createContextGraph({ id: 'ops-context', name: 'Ops Context' });

      const base = await agent.publishCclPolicy({
        contextGraphId: 'ops-context',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });
      await agent.approveCclPolicy({ contextGraphId: 'ops-context', policyUri: base.policyUri });

      const override = await agent.publishCclPolicy({
        contextGraphId: 'ops-context',
        name: 'incident-review',
        version: '0.2.0',
        contextType: 'incident_review',
        content: `policy: incident-review
version: 0.2.0
rules: []
decisions: []
`,
      });
      await agent.approveCclPolicy({ contextGraphId: 'ops-context', policyUri: override.policyUri, contextType: 'incident_review' });

      const resolvedDefault = await agent.resolveCclPolicy({ contextGraphId: 'ops-context', name: 'incident-review' });
      expect(resolvedDefault?.policyUri).toBe(base.policyUri);

      const resolvedContext = await agent.resolveCclPolicy({ contextGraphId: 'ops-context', name: 'incident-review', contextType: 'incident_review' });
      expect(resolvedContext?.policyUri).toBe(override.policyUri);
      expect(resolvedContext?.activeContexts).toContain('incident_review');

      const evaluatedContext = await agent.evaluateCclPolicy({
        contextGraphId: 'ops-context',
        name: 'incident-review',
        contextType: 'incident_review',
        facts: [['claim', 'c2']],
      });
      expect(evaluatedContext.policy.policyUri).toBe(override.policyUri);

      const publishedContextEval = await agent.evaluateAndPublishCclPolicy({
        contextGraphId: 'ops-context',
        name: 'incident-review',
        contextType: 'incident_review',
        facts: [['claim', 'c2']],
        snapshotId: 'snap-ctx',
      });
      const listedByContext = await agent.listCclEvaluations({
        contextGraphId: 'ops-context',
        contextType: 'incident_review',
        snapshotId: 'snap-ctx',
      });
      expect(listedByContext.some(entry => entry.evaluationUri === publishedContextEval.evaluationUri)).toBe(true);

      await agent.stop().catch(() => {});
    });


    it('falls back to the previous default policy after revoking a superseding binding', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'RevokeDefaultBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();

      await agent.createContextGraph({ id: 'ops-revoke-default', name: 'Ops Revoke Default' });

      const v1 = await agent.publishCclPolicy({
        contextGraphId: 'ops-revoke-default',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });
      const v2 = await agent.publishCclPolicy({
        contextGraphId: 'ops-revoke-default',
        name: 'incident-review',
        version: '0.2.0',
        content: `policy: incident-review
version: 0.2.0
rules: []
decisions: []
`,
      });

      await agent.approveCclPolicy({ contextGraphId: 'ops-revoke-default', policyUri: v1.policyUri });
      await agent.approveCclPolicy({ contextGraphId: 'ops-revoke-default', policyUri: v2.policyUri });

      const resolvedLatest = await agent.resolveCclPolicy({ contextGraphId: 'ops-revoke-default', name: 'incident-review' });
      expect(resolvedLatest?.policyUri).toBe(v2.policyUri);

      const revoked = await agent.revokeCclPolicy({ contextGraphId: 'ops-revoke-default', policyUri: v2.policyUri });
      expect(revoked.status).toBe('revoked');

      const resolvedFallback = await agent.resolveCclPolicy({ contextGraphId: 'ops-revoke-default', name: 'incident-review' });
      expect(resolvedFallback?.policyUri).toBe(v1.policyUri);

      const listed = await agent.listCclPolicies({ contextGraphId: 'ops-revoke-default', name: 'incident-review' });
      const revokedRecord = listed.find(policy => policy.policyUri === v2.policyUri);
      const activeRecord = listed.find(policy => policy.policyUri === v1.policyUri);
      expect(revokedRecord?.status).toBe('revoked');
      expect(activeRecord?.status).toBe('approved');
      expect(activeRecord?.isActiveDefault).toBe(true);

      await agent.stop().catch(() => {});
    });


    it('falls back from a revoked context override to the default policy', async () => {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'RevokeContextBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();

      await agent.createContextGraph({ id: 'ops-revoke-context', name: 'Ops Revoke Context' });

      const base = await agent.publishCclPolicy({
        contextGraphId: 'ops-revoke-context',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });
      const override = await agent.publishCclPolicy({
        contextGraphId: 'ops-revoke-context',
        name: 'incident-review',
        version: '0.2.0',
        contextType: 'incident_review',
        content: `policy: incident-review
version: 0.2.0
rules: []
decisions: []
`,
      });

      await agent.approveCclPolicy({ contextGraphId: 'ops-revoke-context', policyUri: base.policyUri });
      await agent.approveCclPolicy({ contextGraphId: 'ops-revoke-context', policyUri: override.policyUri, contextType: 'incident_review' });

      const resolvedOverride = await agent.resolveCclPolicy({ contextGraphId: 'ops-revoke-context', name: 'incident-review', contextType: 'incident_review' });
      expect(resolvedOverride?.policyUri).toBe(override.policyUri);

      const revoked = await agent.revokeCclPolicy({
        contextGraphId: 'ops-revoke-context',
        policyUri: override.policyUri,
        contextType: 'incident_review',
      });
      expect(revoked.contextType).toBe('incident_review');

      const resolvedFallback = await agent.resolveCclPolicy({ contextGraphId: 'ops-revoke-context', name: 'incident-review', contextType: 'incident_review' });
      expect(resolvedFallback?.policyUri).toBe(base.policyUri);
      expect(resolvedFallback?.isActiveDefault).toBe(true);

      await agent.stop().catch(() => {});
    });


    it('restricts CCL policy approval to the contextGraph owner', async () => {
      // Shared store simulates two agent processes on the same node so `other`
      // can see the CG metadata. After PR #200, ownership is wallet-scoped via
      // `DKG_CURATOR`, so we pass an explicit `callerAgentAddress` on `other`'s
      // request to prove non-owner wallets are rejected.
      const store = new OxigraphStore();
      const owner = await DKGAgent.create({
        name: 'OwnerBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      const other = await DKGAgent.create({
        name: 'OtherBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      const otherAddr = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;

      await owner.start();
      await other.start();
      await owner.createContextGraph({ id: 'ops-owner', name: 'Ops Owner' });

      const published = await owner.publishCclPolicy({
        contextGraphId: 'ops-owner',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });

      await expect(other.approveCclPolicy({ contextGraphId: 'ops-owner', policyUri: published.policyUri, callerAgentAddress: otherAddr }))
        .rejects.toThrow(/Only the contextGraph owner can manage policies/);

      await expect(owner.approveCclPolicy({ contextGraphId: 'ops-owner', policyUri: published.policyUri }))
        .resolves.toBeTruthy();

      await owner.stop().catch(() => {});
      await other.stop().catch(() => {});
    });


    it('restricts CCL policy revocation to the contextGraph owner', async () => {
      // See note on policy-approval test above: ownership is wallet-scoped via
      // `DKG_CURATOR` after PR #200; `other` passes an explicit non-owner
      // `callerAgentAddress` to prove the check rejects other wallets.
      const store = new OxigraphStore();
      const owner = await DKGAgent.create({
        name: 'OwnerRevokeBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      const other = await DKGAgent.create({
        name: 'OtherRevokeBot',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      const otherAddr = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;

      await owner.start();
      await other.start();
      await owner.createContextGraph({ id: 'ops-owner-revoke', name: 'Ops Owner Revoke' });

      const published = await owner.publishCclPolicy({
        contextGraphId: 'ops-owner-revoke',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });
      await owner.approveCclPolicy({ contextGraphId: 'ops-owner-revoke', policyUri: published.policyUri });

      await expect(other.revokeCclPolicy({ contextGraphId: 'ops-owner-revoke', policyUri: published.policyUri, callerAgentAddress: otherAddr }))
        .rejects.toThrow(/Only the contextGraph owner can manage policies/);

      await expect(owner.revokeCclPolicy({ contextGraphId: 'ops-owner-revoke', policyUri: published.policyUri }))
        .resolves.toMatchObject({ status: 'revoked' });

      await owner.stop().catch(() => {});
      await other.stop().catch(() => {});
    });
});
