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

describe('AgentWallet', () => {

    it('generates a wallet with keypair', async () => {
      const wallet = await DKGAgentWallet.generate();
      expect(wallet.masterKey).toHaveLength(32);
      expect(wallet.keypair.secretKey).toBeDefined();
      expect(wallet.keypair.publicKey).toBeDefined();
      expect(wallet.peerId()).toBeDefined();
    });


    it('signs with Ed25519 master key', async () => {
      const wallet = await DKGAgentWallet.generate();
      const sig = await wallet.sign(new TextEncoder().encode('test'));
      expect(sig).toHaveLength(64);
    });


    it('saves and loads wallet from disk', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dkg-wallet-'));
      try {
        const wallet = await DKGAgentWallet.generate();
        await wallet.save(dir);

        const keyFile = await readFile(join(dir, 'agent-key.bin'));
        expect(keyFile).toHaveLength(32);

        const loaded = await DKGAgentWallet.load(dir);
        expect(Buffer.from(loaded.masterKey).toString('hex')).toBe(
          Buffer.from(wallet.masterKey).toString('hex'),
        );

        expect(loaded.peerId()).toBe(wallet.peerId());

        expect(Buffer.from(loaded.keypair.secretKey).toString('hex')).toBe(
          Buffer.from(wallet.keypair.secretKey).toString('hex'),
        );
        expect(Buffer.from(loaded.keypair.publicKey).toString('hex')).toBe(
          Buffer.from(wallet.keypair.publicKey).toString('hex'),
        );
      } finally {
        await rm(dir, { recursive: true });
      }
    });


    it('fromMasterKey produces same peerId and keypair', async () => {
      const wallet = await DKGAgentWallet.generate();
      const restored = await DKGAgentWallet.fromMasterKey(wallet.masterKey);
      expect(restored.peerId()).toBe(wallet.peerId());
      expect(Buffer.from(restored.keypair.secretKey).toString('hex')).toBe(
        Buffer.from(wallet.keypair.secretKey).toString('hex'),
      );
      expect(Buffer.from(restored.keypair.publicKey).toString('hex')).toBe(
        Buffer.from(wallet.keypair.publicKey).toString('hex'),
      );
    });


    it('DKGAgent.create() persists identity across restarts', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dkg-agent-persist-'));
      try {
        const agent1 = await DKGAgent.create({ name: 'PersistBot', dataDir: dir, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });
        const peerId1 = agent1.wallet.keypair.publicKey;

        const agent2 = await DKGAgent.create({ name: 'PersistBot', dataDir: dir, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });
        const peerId2 = agent2.wallet.keypair.publicKey;

        expect(Buffer.from(peerId2).toString('hex')).toBe(
          Buffer.from(peerId1).toString('hex'),
        );
      } finally {
        await rm(dir, { recursive: true });
      }
    });


    it('different wallets produce different peerIds', async () => {
      const a = await DKGAgentWallet.generate();
      const b = await DKGAgentWallet.generate();
      expect(a.peerId()).not.toBe(b.peerId());
    });
});
