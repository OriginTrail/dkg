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

describe('DKGAgent ACK signer gating', () => {

    it('allows core chainConfig without a profile admin key for existing no-admin identities', async () => {
      const operational = ethers.Wallet.createRandom();

      const agent = await DKGAgent.create({
        name: 'CoreMissingAdminKey',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: ethers.ZeroAddress,
          operationalKeys: [operational.privateKey],
        },
        nodeRole: 'core',
      });

      expect(agent).toBeInstanceOf(DKGAgent);
    });


    it('auto-registers an ACK signer before registering the StorageACK handler', async () => {
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new MockChainAdapter('mock:31337', primary.address);
      chain.seedIdentity(primary.address, 42n);

      const agent = await DKGAgent.create({
        name: 'AckSignerAutoRegister',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'core',
        ackSignerKey: ackSigner.privateKey,
      });

      try {
        await agent.start();

        expect(await chain.isOperationalWalletRegistered(42n, ackSigner.address)).toBe(true);
        expect(agent.node.libp2p.getProtocols()).toContain(PROTOCOL_STORAGE_ACK);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('retries operational-wallet registration during StorageACK setup', async () => {
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new FlakyRegistrationACKChainAdapter('mock:31337', primary.address);
      chain.seedIdentity(primary.address, 45n);

      const agent = await DKGAgent.create({
        name: 'AckSignerRegistrationRetry',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'core',
        ackSignerKey: ackSigner.privateKey,
      });

      try {
        await agent.start();

        expect(chain.ensureCalls).toBeGreaterThanOrEqual(2);
        expect(await chain.isOperationalWalletRegistered(45n, ackSigner.address)).toBe(true);
        expect(agent.node.libp2p.getProtocols()).toContain(PROTOCOL_STORAGE_ACK);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('recovers StorageACK registration after a transient boot-time chain outage (#894 / Codex PR #901)', async () => {
      // The on-chain identity exists, but the chain is unreachable for the two
      // boot-time identity lookups (initial + recovery). Boot must NOT hang or
      // throw — HTTP readiness can't depend on chain reachability — and the
      // identity is left at 0n. Crucially, the first ACK attempt (awaited by
      // start()) is NON-BLOCKING (Codex :1752): it does no chain probe, returns
      // 'retryable' immediately, and start() proceeds. The SCHEDULED retry then
      // re-resolves the identity (chain now reachable) and registers the handler.
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new TransientIdentityFailureChainAdapter('mock:31337', primary.address, 2);
      chain.seedIdentity(primary.address, 47n);

      const agent = await DKGAgent.create({
        name: 'AckTransientIdentityRecovery',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'core',
        ackSignerKey: ackSigner.privateKey,
        storageAckRegistrationRetryMs: 1000,
      });

      try {
        // Boot completes despite the two failed boot-time identity lookups. The
        // first ACK attempt does NOT probe the chain, so the handler is NOT yet
        // registered when start() returns (it's deferred to the retry).
        await agent.start();
        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);

        // The scheduled retry re-resolves the identity (chain reachable now) and
        // registers the handler — recovery without restart.
        await vi.waitFor(
          () => expect(agent.node.libp2p.getProtocols()).toContain(PROTOCOL_STORAGE_ACK),
          { timeout: 10_000, interval: 100 },
        );
        expect(await chain.isOperationalWalletRegistered(47n, ackSigner.address)).toBe(true);
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 20_000);


    it('provisions a brand-new core node profile on the retry path after a transient boot outage (#894 / Codex PR #901 :1757)', async () => {
      // No identity exists yet AND the chain is down during boot, before
      // ensureProfile() ever runs. Re-probing getIdentityId() alone would loop at
      // 0n forever; the retry path must call ensureProfile() (core only) to
      // provision once the chain is back, then register the handler.
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new BrandNewCoreTransientChainAdapter('mock:31337', primary.address, 2);
      // No seedIdentity — the node has never provisioned.

      const agent = await DKGAgent.create({
        name: 'AckBrandNewCoreRecovery',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'core',
        ackSignerKey: ackSigner.privateKey,
        storageAckRegistrationRetryMs: 1000,
      });

      try {
        await agent.start();
        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);

        await vi.waitFor(
          () => expect(agent.node.libp2p.getProtocols()).toContain(PROTOCOL_STORAGE_ACK),
          { timeout: 10_000, interval: 100 },
        );
        // The retry path provisioned the profile (ensureProfile was called) and
        // an identity now exists.
        expect(chain.ensureProfileCalls).toBeGreaterThanOrEqual(1);
        expect(await chain.getIdentityId()).toBeGreaterThan(0n);
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 20_000);


    it('does NOT retry-loop on a permanent boot provisioning failure (#894 / Codex PR #901 round-3 :1714)', async () => {
      // A deterministic provisioning failure (insufficient funds) must stay
      // 'disabled': StorageACK is not registered AND ensureProfile is called
      // exactly once — the 30s retry loop must NOT re-submit it forever.
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new PermanentProfileFailureChainAdapter('mock:31337', primary.address);
      // No seedIdentity — the node must provision, and that provisioning fails.

      const agent = await DKGAgent.create({
        name: 'AckPermanentProvisionFailure',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'core',
        ackSignerKey: ackSigner.privateKey,
        storageAckRegistrationRetryMs: 1000,
      });

      try {
        await agent.start();
        // Boot's ensureProfile failed deterministically (1 call).
        expect(chain.ensureProfileCalls).toBe(1);
        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);

        // Wait well past several 25ms retry intervals. A buggy build (treating
        // the permanent failure as transient) would re-call ensureProfile every
        // interval; the fix keeps it 'disabled' so the count stays 1.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(chain.ensureProfileCalls).toBe(1);
        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 20_000);


    it('stops the StorageACK retry loop when RETRY-path provisioning fails permanently (#894 / Codex PR #901 round-4 :1838)', async () => {
      // Boot fails TRANSIENTLY (RPC down) so the retry loop arms. Once the chain
      // is back, the retry-path provisioning fails DETERMINISTICALLY (insufficient
      // funds). The retry-path catch must reclassify → disable → stop scheduling,
      // so ensureProfile is NOT re-run on every subsequent interval.
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new RetryPathPermanentFailureChainAdapter('mock:31337', primary.address, 2);
      // No seedIdentity — the node must provision, and that provisioning fails.

      const agent = await DKGAgent.create({
        name: 'AckRetryPathPermanentFailure',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'core',
        ackSignerKey: ackSigner.privateKey,
        storageAckRegistrationRetryMs: 1000,
      });

      try {
        // Boot's two identity lookups fail transiently → retry armed; the first
        // (non-blocking) ACK attempt does no provisioning, so 0 ensureProfile yet.
        await agent.start();
        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);

        // Wait for the retry to fire, attempt provisioning (fails permanently),
        // disable, and stop. Then confirm it does NOT keep re-provisioning.
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const callsAfterFirstRetry = chain.ensureProfileCalls;
        expect(callsAfterFirstRetry).toBeGreaterThanOrEqual(1); // retry tried provisioning
        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);

        // Past several more intervals: the count must NOT keep climbing (no loop).
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(chain.ensureProfileCalls).toBe(callsAfterFirstRetry);
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 20_000);


    it('clamps a 0 / invalid storageAckRegistrationRetryMs to the floor (no tight loop) and still recovers (#894 / Codex PR #901 round-4 :2106)', async () => {
      // A 0 retry interval used verbatim would collapse the retry into a tight
      // loop hammering the RPC. The clamp floors it, so scheduling still works
      // (the transient-recovery node registers) without busy-spinning.
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new TransientIdentityFailureChainAdapter('mock:31337', primary.address, 2);
      chain.seedIdentity(primary.address, 51n);

      const agent = await DKGAgent.create({
        name: 'AckZeroRetryClamp',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'core',
        ackSignerKey: ackSigner.privateKey,
        storageAckRegistrationRetryMs: 0, // clamped to MIN_STORAGE_ACK_REGISTRATION_RETRY_MS
      });

      try {
        await agent.start();
        // Recovery still happens — the clamped (floored) retry fires and registers.
        await vi.waitFor(
          () => expect(agent.node.libp2p.getProtocols()).toContain(PROTOCOL_STORAGE_ACK),
          { timeout: 10_000, interval: 100 },
        );
        // The clamp prevented a busy-spin: a 1s floor over the recovery window
        // means only a handful of identity lookups, not thousands.
        expect(chain.identityCalls).toBeLessThan(20);
      } finally {
        await agent.stop().catch(() => {});
      }
    }, 20_000);


    it('does not auto-register ACK signer candidates for edge nodes', async () => {
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new MockChainAdapter('mock:31337', primary.address);
      chain.seedIdentity(primary.address, 46n);

      const agent = await DKGAgent.create({
        name: 'EdgeAckSignerNoAutoRegister',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'edge',
        ackSignerKey: ackSigner.privateKey,
      });

      try {
        await agent.start();

        expect(await chain.isOperationalWalletRegistered(46n, ackSigner.address)).toBe(false);
        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('does not register StorageACK when no ACK key is confirmed on-chain', async () => {
      const primary = ethers.Wallet.createRandom();
      const ackSigner = ethers.Wallet.createRandom();
      const chain = new NonRegisteringACKChainAdapter('mock:31337', primary.address);
      chain.seedIdentity(primary.address, 43n);

      const agent = await DKGAgent.create({
        name: 'AckSignerUnconfirmed',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        nodeRole: 'core',
        ackSignerKey: ackSigner.privateKey,
      });

      try {
        await agent.start();

        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('does not source ACK signer candidates from chainConfig when a chainAdapter is supplied', async () => {
      const primary = ethers.Wallet.createRandom();
      const staleChainConfigSigner = ethers.Wallet.createRandom();
      const chain = new MockChainAdapter('mock:31337', primary.address);
      chain.seedIdentity(primary.address, 44n);

      const agent = await DKGAgent.create({
        name: 'AckSignerChainAdapterIgnoresChainConfig',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: ethers.ZeroAddress,
          adminPrivateKey: ethers.Wallet.createRandom().privateKey,
          operationalKeys: [staleChainConfigSigner.privateKey],
        },
        nodeRole: 'core',
      });

      try {
        await agent.start();

        expect(await chain.isOperationalWalletRegistered(44n, staleChainConfigSigner.address)).toBe(false);
        expect(agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_STORAGE_ACK);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('resolves publish signer from the adapter instead of pinning operationalKeys[0]', async () => {
      const primary = ethers.Wallet.createRandom();
      const authorized = ethers.Wallet.createRandom();
      const chain = new ContextAuthorizedPublisherChainAdapter(primary, authorized);

      const agent = await DKGAgent.create({
        name: 'AdapterAuthorizedPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(77n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-adapter-authorized-publisher',
            predicate: 'http://schema.org/name',
            object: '"AdapterAuthorizedPublisher"',
            graph: 'did:dkg:context-graph:42',
          }],
        });

        expect(result.status).toBe('confirmed');
        expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(authorized.address.toLowerCase());
        expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(authorized.address.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('awaits async adapter signer address probes', async () => {
      const wallet = ethers.Wallet.createRandom();
      const chain = new AsyncAddressSignMessageAsPublishChainAdapter(wallet);

      const agent = await DKGAgent.create({
        name: 'AsyncAdapterAddressPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-async-adapter-address',
            predicate: 'http://schema.org/name',
            object: '"AsyncAdapterAddress"',
            graph: 'did:dkg:context-graph:42',
          }],
        });

        expect(result.status).toBe('confirmed');
        expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
        expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('keeps getOperationalPrivateKey as a legacy adapter-backed publish fallback', async () => {
      const wallet = ethers.Wallet.createRandom();
      const chain = new OperationalKeyOnlyPublishChainAdapter(wallet);

      const agent = await DKGAgent.create({
        name: 'LegacyOperationalKeyPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-operational-key-fallback',
            predicate: 'http://schema.org/name',
            object: '"OperationalKeyFallback"',
            graph: 'did:dkg:context-graph:42',
          }],
        });

        expect(result.status).toBe('confirmed');
        expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
        expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('uses getOperationalPrivateKey as curated registration authority for adapter-only publishers', async () => {
      const wallet = ethers.Wallet.createRandom();
      const chain = new OperationalKeyOnlyPublishChainAdapter(wallet);

      const agent = await DKGAgent.create({
        name: 'LegacyOperationalKeyRegistrationAuthority',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
      });

      try {
        const authority = await (agent as unknown as {
          getChainPublishAuthorityAddress(contextGraphId?: string): Promise<string | undefined>;
        }).getChainPublishAuthorityAddress('42');

        expect(authority?.toLowerCase()).toBe(wallet.address.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });
});
