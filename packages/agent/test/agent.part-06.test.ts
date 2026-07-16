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

describe('PeerId key extraction', () => {

    it('extracts Ed25519 public key from libp2p PeerId', async () => {
      const agent = await DKGAgent.create({
        name: 'KeyTest',
        listenPort: 0,
        skills: [],
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();

      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peerId = peerIdFromString(agent.peerId);
      const digest = peerId.toMultihash().digest;

      // Ed25519 PeerId protobuf: [08 01 12 20 <32 bytes of Ed25519 public key>]
      expect(digest[0]).toBe(0x08);
      expect(digest[1]).toBe(0x01);
      expect(digest[2]).toBe(0x12);
      expect(digest[3]).toBe(0x20);

      const extractedKey = digest.slice(4, 36);
      expect(extractedKey.length).toBe(32);
      expect(Buffer.from(extractedKey).toString('hex')).toBe(
        Buffer.from(agent.wallet.keypair.publicKey).toString('hex'),
      );

      await agent.stop();
    }, 10000);
});
