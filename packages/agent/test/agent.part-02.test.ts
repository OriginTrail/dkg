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

describe('Profile Builder', () => {

    it('builds agent profile quads', () => {
      // A-12 migration: profile DIDs are the EVM-address form, not peer-id.
      const addr = '0x' + '1'.repeat(40);
      const { quads, rootEntity } = buildAgentProfile({
        peerId: 'QmTest123',
        agentAddress: addr,
        name: 'TestBot',
        description: 'A test agent',
        framework: 'OpenClaw',
        skills: [
          {
            skillType: 'ImageAnalysis',
            pricePerCall: 0.5,
            currency: 'TRAC',
            successRate: 0.95,
            pricingModel: 'PerInvocation',
          },
        ],
      });

      expect(rootEntity).toBe(`did:dkg:agent:${addr}`);
      expect(quads.length).toBeGreaterThanOrEqual(8);

      const subjects = quads.map(q => q.subject);
      expect(subjects).toContain(`did:dkg:agent:${addr}`);
      expect(subjects).toContain(`did:dkg:agent:${addr}/.well-known/genid/offering1`);

      const predicates = quads.map(q => q.predicate);
      expect(predicates).toContain('https://schema.org/name');
      expect(predicates).toContain('https://dkg.origintrail.io/skill#offersSkill');
      expect(predicates).toContain('https://dkg.origintrail.io/skill#skill');
    });


    it('handles multiple skills', () => {
      const { quads } = buildAgentProfile({
        peerId: 'QmMulti',
        name: 'MultiBot',
        skills: [
          { skillType: 'ImageAnalysis' },
          { skillType: 'TextAnalysis' },
        ],
      });

      const offeringSubjects = quads.filter(
        q => q.predicate === 'https://dkg.origintrail.io/skill#offersSkill',
      );
      expect(offeringSubjects).toHaveLength(2);
    });


    it('all quads target the agent-registry graph', () => {
      const { quads } = buildAgentProfile({
        peerId: 'QmGraph',
        name: 'GraphBot',
        skills: [{ skillType: 'CodeGeneration' }],
      });

      for (const q of quads) {
        expect(q.graph).toBe('did:dkg:context-graph:agents');
      }
    });


    it('emits dkg:multiaddr triples (one per published address) and dkg:lastSeen (phonebook)', () => {
      // PR feat/chain-agents-cg-phonebook: profile now publishes the
      // node's dialable multiaddrs and a freshness timestamp so other
      // peers' dial fallback can find direct addrs even after their
      // peerStore entries age out.
      const { quads } = buildAgentProfile({
        peerId: 'QmPhonebook',
        name: 'PhonebookBot',
        skills: [],
        multiaddrs: [
          '/ip4/203.0.113.10/tcp/9090/p2p/QmPhonebook',
          '/ip4/198.51.100.20/tcp/9090/p2p-circuit/p2p/QmPhonebook',
        ],
        lastSeen: '2026-05-26T15:00:00.000Z',
      });

      const multiQuads = quads.filter(
        (q) => q.predicate === 'https://dkg.network/ontology#multiaddr',
      );
      expect(multiQuads).toHaveLength(2);
      expect(multiQuads.map((q) => q.object)).toEqual([
        '"/ip4/203.0.113.10/tcp/9090/p2p/QmPhonebook"',
        '"/ip4/198.51.100.20/tcp/9090/p2p-circuit/p2p/QmPhonebook"',
      ]);

      const lastSeenQuad = quads.find(
        (q) => q.predicate === 'https://dkg.network/ontology#lastSeen',
      );
      expect(lastSeenQuad?.object).toBe('"2026-05-26T15:00:00.000Z"');
    });


    it('lastSeen defaults to the current ISO timestamp when omitted', () => {
      const before = new Date().toISOString();
      const { quads } = buildAgentProfile({
        peerId: 'QmDefault',
        name: 'DefaultBot',
        skills: [],
      });
      const after = new Date().toISOString();
      const lastSeen = quads.find(
        (q) => q.predicate === 'https://dkg.network/ontology#lastSeen',
      )?.object.replace(/"/g, '');
      expect(lastSeen).toBeDefined();
      expect(lastSeen! >= before && lastSeen! <= after).toBe(true);
    });


    it('collectPublishableMultiaddrs drops non-public addresses + dedups (uses core isPublicLikeAddress)', () => {
      // Filter must drop addresses that no remote peer could plausibly
      // dial — loopback, link-local, unspecified bind, RFC1918, CGNAT,
      // ULA, and DNS hostnames that resolve to local-only names.
      // Real production addrs (public IPs + circuit forms anchored on a
      // public relay) pass through. Duplicates from libp2p's listen /
      // announce dedup are collapsed.
      //
      // Codex review of PR #700 round 2 flagged that the previous regex
      // filter still leaked RFC1918 / CGNAT / ULA / `/dns*/localhost`
      // into the agent profile. The fence below pins the wider drop set
      // we now reuse from `core/src/node.ts:isPublicLikeAddress`.
      const out = collectPublishableMultiaddrs([
        '/ip4/127.0.0.1/tcp/9090/p2p/QmA',           // loopback
        '/ip4/0.0.0.0/tcp/9090/p2p/QmA',             // unspecified bind
        '/ip4/169.254.0.5/tcp/9090/p2p/QmA',         // link-local
        '/ip4/10.0.0.5/tcp/9090/p2p/QmA',            // RFC1918 (10/8)
        '/ip4/172.16.0.5/tcp/9090/p2p/QmA',          // RFC1918 (172.16/12)
        '/ip4/172.31.255.255/tcp/9090/p2p/QmA',      // RFC1918 boundary
        '/ip4/192.168.1.5/tcp/9090/p2p/QmA',         // RFC1918 (192.168/16)
        '/ip4/100.105.212.110/tcp/9090/p2p/QmA',     // CGNAT (100.64/10)
        '/ip6/::1/tcp/9090/p2p/QmA',                 // loopback
        '/ip6/::/tcp/9090/p2p/QmA',                  // unspecified
        '/ip6/fe80::1/tcp/9090/p2p/QmA',             // link-local
        '/ip6/fc00::1/tcp/9090/p2p/QmA',             // ULA
        '/ip6/fd12::1/tcp/9090/p2p/QmA',             // ULA
        '/dns4/localhost/tcp/9090/p2p/QmA',          // DNS localhost
        '/dns4/host.local/tcp/9090/p2p/QmA',         // mDNS .local
        '/ip4/203.0.113.10/tcp/9090/p2p/QmA',        // public, keep
        '/ip4/203.0.113.10/tcp/9090/p2p/QmA',        // duplicate of above, drop
        '/ip4/198.51.100.20/tcp/9090/p2p-circuit/p2p/QmA', // circuit on public relay, keep
        '/dns4/relay.origintrail.network/tcp/443/p2p/QmA', // public DNS, keep
      ]);
      expect(out).toEqual([
        '/ip4/203.0.113.10/tcp/9090/p2p/QmA',
        '/ip4/198.51.100.20/tcp/9090/p2p-circuit/p2p/QmA',
        '/dns4/relay.origintrail.network/tcp/443/p2p/QmA',
      ]);
    });


    it('skips malformed multiaddrs containing a literal quote (defensive)', () => {
      // Quote characters would break the raw template-literal RDF
      // emission and inject extra triples. Production libp2p multiaddrs
      // never contain `"`; the guard exists for malformed test fixtures
      // or untrusted upstream input.
      const { quads } = buildAgentProfile({
        peerId: 'QmGuard',
        name: 'GuardBot',
        skills: [],
        multiaddrs: ['/ip4/1.2.3.4/tcp/9090', '/ip4/bad"injected/tcp/0'],
      });
      const multiQuads = quads.filter(
        (q) => q.predicate === 'https://dkg.network/ontology#multiaddr',
      );
      expect(multiQuads).toHaveLength(1);
      expect(multiQuads[0].object).toBe('"/ip4/1.2.3.4/tcp/9090"');
    });


    it('includes hosting profile when contextGraphsServed is set', () => {
      const { quads } = buildAgentProfile({
        peerId: 'QmHost',
        name: 'HostBot',
        skills: [],
        contextGraphsServed: ['agent-skills', 'climate'],
      });

      const hostingQuads = quads.filter(q =>
        q.predicate === 'https://dkg.origintrail.io/skill#hostingProfile',
      );
      expect(hostingQuads).toHaveLength(1);

      const contextGraphsQuads = quads.filter(q =>
        q.predicate === 'https://dkg.origintrail.io/skill#contextGraphsServed',
      );
      expect(contextGraphsQuads).toHaveLength(2);
      const servedValues = contextGraphsQuads.map(q => q.object);
      expect(servedValues).toContain('"agent-skills"');
      expect(servedValues).toContain('"climate"');
    });


    it('omits optional fields when not provided', () => {
      const { quads } = buildAgentProfile({
        peerId: 'QmMinimal',
        name: 'MinimalBot',
        skills: [],
      });

      const descQuads = quads.filter(q => q.predicate === 'http://schema.org/description');
      expect(descQuads).toHaveLength(0);

      const frameworkQuads = quads.filter(q =>
        q.predicate === 'https://dkg.origintrail.io/skill#framework',
      );
      expect(frameworkQuads).toHaveLength(0);
    });
});
