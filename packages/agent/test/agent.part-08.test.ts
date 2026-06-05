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


    it('keeps chainConfig.operationalKeys fallback when a custom adapter has no signer probes', async () => {
      const wallet = ethers.Wallet.createRandom();
      const chain = new ExternalOperationalKeyPublishChainAdapter(wallet.address);

      const agent = await DKGAgent.create({
        name: 'ExternalOperationalKeyPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: '0x00000000000000000000000000000000000000A1',
          operationalKeys: [wallet.privateKey],
        },
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-chain-config-operational-key-fallback',
            predicate: 'http://schema.org/name',
            object: '"ChainConfigOperationalKeyFallback"',
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


    it('keeps chainConfig.operationalKeys fallback when a custom adapter only exposes signer addresses', async () => {
      const wallet = ethers.Wallet.createRandom();
      const chain = new AddressOnlyExternalOperationalKeyPublishChainAdapter(wallet.address);

      const agent = await DKGAgent.create({
        name: 'AddressOnlyExternalOperationalKeyPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: '0x00000000000000000000000000000000000000A1',
          operationalKeys: [wallet.privateKey],
        },
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-address-only-operational-key-fallback',
            predicate: 'http://schema.org/name',
            object: '"AddressOnlyOperationalKeyFallback"',
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


    it('keeps chainConfig.operationalKeys fallback when custom adapter only exposes generic signMessage', async () => {
      const wallet = ethers.Wallet.createRandom();
      const unrelatedSigner = ethers.Wallet.createRandom();
      const chain = new GenericSignMessageExternalOperationalKeyPublishChainAdapter(
        wallet.address,
        unrelatedSigner,
      );

      const agent = await DKGAgent.create({
        name: 'GenericSignMessageOperationalKeyPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: '0x00000000000000000000000000000000000000A1',
          operationalKeys: [wallet.privateKey],
        },
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-generic-sign-message-operational-key-fallback',
            predicate: 'http://schema.org/name',
            object: '"GenericSignMessageOperationalKeyFallback"',
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


    it('uses chainConfig fallback authority when generic signMessage is not the publish signer', async () => {
      const wallet = ethers.Wallet.createRandom();
      const unrelatedSigner = ethers.Wallet.createRandom();
      const chain = new GenericSignMessageExternalOperationalKeyPublishChainAdapter(
        wallet.address,
        unrelatedSigner,
      );

      const agent = await DKGAgent.create({
        name: 'GenericSignMessageRegistrationAuthority',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: '0x00000000000000000000000000000000000000A1',
          operationalKeys: [wallet.privateKey],
        },
      });

      try {
        const authority = await (agent as unknown as {
          getChainPublishAuthorityAddress(contextGraphId?: string): Promise<string | undefined>;
        }).getChainPublishAuthorityAddress('42');

        expect(authority?.toLowerCase()).toBe(wallet.address.toLowerCase());
        expect(authority?.toLowerCase()).not.toBe(unrelatedSigner.address.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('keeps chainConfig.operationalKeys fallback when multi-signer adapter lacks signMessageAs', async () => {
      const wallet = ethers.Wallet.createRandom();
      const genericSigner = ethers.Wallet.createRandom();
      const advertisedSigner = ethers.Wallet.createRandom();
      const chain = new MultiSignerGenericSignMessagePublishChainAdapter(
        wallet.address,
        genericSigner,
        advertisedSigner,
      );

      const agent = await DKGAgent.create({
        name: 'MultiSignerGenericSignMessageOperationalKeyPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: '0x00000000000000000000000000000000000000A1',
          operationalKeys: [wallet.privateKey],
        },
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-multi-signer-generic-sign-message-operational-key-fallback',
            predicate: 'http://schema.org/name',
            object: '"MultiSignerGenericSignMessageOperationalKeyFallback"',
            graph: 'did:dkg:context-graph:42',
          }],
        });

        expect(result.status).toBe('confirmed');
        expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
        expect(chain.capturedPublisherAddress?.toLowerCase()).not.toBe(genericSigner.address.toLowerCase());
        expect(chain.capturedPublisherAddress?.toLowerCase()).not.toBe(advertisedSigner.address.toLowerCase());
        expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('keeps chainConfig.operationalKeys fallback when single-address adapter signMessage uses another key', async () => {
      const wallet = ethers.Wallet.createRandom();
      const advertisedSigner = ethers.Wallet.createRandom();
      const genericSigner = ethers.Wallet.createRandom();
      const chain = new SingleAddressMismatchedGenericSignMessagePublishChainAdapter(
        wallet.address,
        advertisedSigner,
        genericSigner,
      );

      const agent = await DKGAgent.create({
        name: 'SingleAddressMismatchedGenericSignMessagePublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: '0x00000000000000000000000000000000000000A1',
          operationalKeys: [wallet.privateKey],
        },
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-single-address-mismatched-generic-sign-message',
            predicate: 'http://schema.org/name',
            object: '"SingleAddressMismatchedGenericSignMessage"',
            graph: 'did:dkg:context-graph:42',
          }],
        });

        expect(result.status).toBe('confirmed');
        expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
        expect(chain.capturedPublisherAddress?.toLowerCase()).not.toBe(advertisedSigner.address.toLowerCase());
        expect(chain.capturedPublisherAddress?.toLowerCase()).not.toBe(genericSigner.address.toLowerCase());
        expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('does not reserve a publish signer while resolving curated registration authority', async () => {
      const wallet = ethers.Wallet.createRandom();
      const chain = new ReservingAuthorityContextGraphChainAdapter(wallet);

      const agent = await DKGAgent.create({
        name: 'NonReservingRegistrationAuthority',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
      });

      try {
        const authority = await (agent as unknown as {
          getChainPublishAuthorityAddress(contextGraphId?: string): Promise<string | undefined>;
        }).getChainPublishAuthorityAddress('42');

        expect(authority?.toLowerCase()).toBe(wallet.address.toLowerCase());
        expect(chain.reservations).toBe(0);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('uses a single-signer adapter instead of chainConfig.operationalKeys fallback', async () => {
      const adapterWallet = ethers.Wallet.createRandom();
      const staleChainConfigSigner = ethers.Wallet.createRandom();
      const chain = new SingleSignerAdapterPublishChainAdapter(adapterWallet);

      const agent = await DKGAgent.create({
        name: 'SingleSignerAdapterPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: '0x00000000000000000000000000000000000000A1',
          operationalKeys: [staleChainConfigSigner.privateKey],
        },
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-single-signer-adapter',
            predicate: 'http://schema.org/name',
            object: '"SingleSignerAdapter"',
            graph: 'did:dkg:context-graph:42',
          }],
        });

        expect(result.status).toBe('confirmed');
        expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(adapterWallet.address.toLowerCase());
        expect(chain.capturedPublisherAddress?.toLowerCase()).not.toBe(staleChainConfigSigner.address.toLowerCase());
        expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(adapterWallet.address.toLowerCase());
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('keeps chainConfig.operationalKeys fallback when publisherAddress pins the same key', async () => {
      const wallet = ethers.Wallet.createRandom();
      const chain = new ExternalOperationalKeyPublishChainAdapter(wallet.address);

      const agent = await DKGAgent.create({
        name: 'PinnedOperationalKeyPublisher',
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: chain,
        publisherAddress: wallet.address,
        chainConfig: {
          rpcUrl: 'http://127.0.0.1:0',
          hubAddress: '0x00000000000000000000000000000000000000A1',
          operationalKeys: [wallet.privateKey],
        },
      });

      try {
        await _wrapAgentPublisherForSeal(agent);
        agent.publisher.setIdentityId(1n);
        const result = await agent.publisher.publish({
          contextGraphId: '42',
          quads: [{
            subject: 'urn:test:agent-pinned-operational-key-fallback',
            predicate: 'http://schema.org/name',
            object: '"PinnedOperationalKeyFallback"',
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
});
