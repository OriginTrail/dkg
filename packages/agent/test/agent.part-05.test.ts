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

describe('Encryption', () => {

    it('encrypts and decrypts with XChaCha20-Poly1305', () => {
      const key = sha256(new TextEncoder().encode('test-key'));
      const plaintext = new TextEncoder().encode('Hello, encrypted world!');

      const { ciphertext, nonce } = encrypt(key, plaintext);
      expect(ciphertext).not.toEqual(plaintext);
      expect(nonce).toHaveLength(24);

      const decrypted = decrypt(key, ciphertext, nonce);
      expect(new TextDecoder().decode(decrypted)).toBe('Hello, encrypted world!');
    });


    it('derives X25519 keys from Ed25519', async () => {
      const wallet = await DKGAgentWallet.generate();
      const x25519Priv = ed25519ToX25519Private(wallet.keypair.secretKey);
      const x25519Pub = ed25519ToX25519Public(wallet.keypair.publicKey);

      expect(x25519Priv).toHaveLength(32);
      expect(x25519Pub).toHaveLength(32);
    });


    it('X25519 key agreement produces shared secret', async () => {
      const walletA = await DKGAgentWallet.generate();
      const walletB = await DKGAgentWallet.generate();

      const privA = ed25519ToX25519Private(walletA.keypair.secretKey);
      const pubA = ed25519ToX25519Public(walletA.keypair.publicKey);
      const privB = ed25519ToX25519Private(walletB.keypair.secretKey);
      const pubB = ed25519ToX25519Public(walletB.keypair.publicKey);

      const sharedAB = x25519SharedSecret(privA, pubB);
      const sharedBA = x25519SharedSecret(privB, pubA);

      expect(sharedAB).toHaveLength(32);
      expect(Buffer.from(sharedAB).toString('hex')).toBe(Buffer.from(sharedBA).toString('hex'));
    });


    it('decrypt with wrong key fails', () => {
      const key = sha256(new TextEncoder().encode('correct-key'));
      const wrongKey = sha256(new TextEncoder().encode('wrong-key'));
      const plaintext = new TextEncoder().encode('secret');

      const { ciphertext, nonce } = encrypt(key, plaintext);
      expect(() => decrypt(wrongKey, ciphertext, nonce)).toThrow();
    });


    it('encrypts empty payload', () => {
      const key = sha256(new TextEncoder().encode('key'));
      const { ciphertext, nonce } = encrypt(key, new Uint8Array(0));
      const decrypted = decrypt(key, ciphertext, nonce);
      expect(decrypted).toHaveLength(0);
    });


    it('encrypts large payload', () => {
      const key = sha256(new TextEncoder().encode('key'));
      const large = new Uint8Array(100_000).fill(42);
      const { ciphertext, nonce } = encrypt(key, large);
      const decrypted = decrypt(key, ciphertext, nonce);
      expect(decrypted).toHaveLength(100_000);
      expect(decrypted[0]).toBe(42);
      expect(decrypted[99_999]).toBe(42);
    });
});
