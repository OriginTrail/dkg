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

describe('DKGAgent config — syncContextGraphs and queryAccess warning', () => {


    it('rejects replayed private sync requests', async () => {
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const wallet = ethers.Wallet.createRandom();
      const agent = await DKGAgent.create({
        name: 'PrivateSyncReplay',
        listenHost: '127.0.0.1',
        chainAdapter: chain,
      });
      try {
        await agent.start();
        (agent as any).subscribedContextGraphs.set('private-cg', {
          name: 'private-cg',
          subscribed: false,
          synced: true,
          onChainId: '1',
        });
        (agent as any).isPrivateContextGraph = async () => true;
        // LU-2: per-CG `chain.getContextGraphParticipants` is removed; stub
        // the agent-side resolver directly so the replay test exercises
        // the seenRequestIds path without depending on the dead surface.
        (agent as any).getPrivateContextGraphParticipants = async () => ['1'];
        (chain as any).verifySyncIdentity = async () => true;
        (chain as any).verifyACKIdentity = async () => true;

        const request = {
          contextGraphId: 'private-cg',
          offset: 0,
          limit: 10,
          includeSharedMemory: false,
          targetPeerId: agent.peerId,
          requesterPeerId: 'peer-requester',
          requestId: 'req-1',
          issuedAtMs: Date.now(),
          requesterIdentityId: '1',
        } as const;

        const digest = (agent as any).computeSyncDigest(
          request.contextGraphId,
          request.offset,
          request.limit,
          request.includeSharedMemory,
          request.targetPeerId,
          request.requesterPeerId,
          request.requestId,
          request.issuedAtMs,
        );
        const sig = ethers.Signature.from(await wallet.signMessage(digest));

        const signedRequest = {
          ...request,
          requesterSignatureR: sig.r,
          requesterSignatureVS: sig.yParityAndS,
        };

        const first = await (agent as any).authorizeSyncRequest(signedRequest, 'peer-requester');
        const second = await (agent as any).authorizeSyncRequest(signedRequest, 'peer-requester');

        expect(first).toBe(true);
        expect(second).toBe(false);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('emits warning when queryAccess.defaultPolicy is explicitly "public"', async () => {
      const { Logger } = await import('@origintrail-official/dkg-core');
      const logs: Array<{ level: string; message: string }> = [];
      Logger.setSink((entry) => logs.push(entry));
      let agent: DKGAgent | undefined;

      try {
        agent = await DKGAgent.create({
          name: 'PublicWarnTest',
          listenHost: '127.0.0.1',
          chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
          queryAccess: { defaultPolicy: 'public' },
        });
        await agent.start();

        const warning = logs.find(
          l => l.level === 'warn' && l.message.includes('Query access policy is "public"'),
        );
        expect(warning).toBeDefined();
      } finally {
        await agent?.stop().catch(() => {});
        Logger.setSink(null);
      }
    });


    it('does not emit public-query warning when queryAccess is omitted (deny default)', async () => {
      const { Logger } = await import('@origintrail-official/dkg-core');
      const logs: Array<{ level: string; message: string }> = [];
      Logger.setSink((entry) => logs.push(entry));
      let agent: DKGAgent | undefined;

      try {
        agent = await DKGAgent.create({
          name: 'DenyDefaultTest',
          listenHost: '127.0.0.1',
          chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        });
        await agent.start();

        const warning = logs.find(
          l => l.level === 'warn' && l.message.includes('Query access policy is "public"'),
        );
        expect(warning).toBeUndefined();
      } finally {
        await agent?.stop().catch(() => {});
        Logger.setSink(null);
      }
    });


    it('parseSyncRequest falls back to pipe-delimited on malformed JSON', async () => {
      const agent = await DKGAgent.create({
        name: 'ParseFallbackTest',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      try {
        await agent.start();
        const malformedJson = '{not valid json';
        const result = (agent as any).parseSyncRequest(
          new TextEncoder().encode(malformedJson),
        );
        // Falls back to pipe-delimited: the whole string becomes contextGraphId
        expect(result.contextGraphId).toBeDefined();
        expect(result.offset).toBe(0);
        expect(result.limit).toBeDefined();
        expect(result.phase).toBe('data');
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('parseSyncRequest parses meta phase from pipe-delimited format', async () => {
      const agent = await DKGAgent.create({
        name: 'ParseMetaPhase',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      try {
        await agent.start();
        const msg = 'my-context-graph|10|50|meta';
        const result = (agent as any).parseSyncRequest(
          new TextEncoder().encode(msg),
        );
        expect(result.contextGraphId).toBe('my-context-graph');
        expect(result.offset).toBe(10);
        expect(result.limit).toBe(50);
        expect(result.phase).toBe('meta');
        expect(result.includeSharedMemory).toBe(false);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('parseSyncRequest handles workspace prefix in pipe-delimited format', async () => {
      const agent = await DKGAgent.create({
        name: 'ParseWorkspace',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      try {
        await agent.start();
        const msg = 'workspace:my-cg|0|100|data';
        const result = (agent as any).parseSyncRequest(
          new TextEncoder().encode(msg),
        );
        expect(result.contextGraphId).toBe('my-cg');
        expect(result.includeSharedMemory).toBe(true);
        expect(result.phase).toBe('data');
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('canReadContextGraph allows locally subscribed private CGs when identityId is 0n', async () => {
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      (chain as any).getIdentityId = async () => 0n;
      const agent = await DKGAgent.create({
        name: 'CanReadLocal',
        listenHost: '127.0.0.1',
        chainAdapter: chain,
      });
      try {
        await agent.start();
        (agent as any).subscribedContextGraphs.set('local-private-cg', {
          name: 'local-private-cg',
          subscribed: false,
          synced: true,
        });
        (agent as any).isPrivateContextGraph = async () => true;
        (agent as any).getPrivateContextGraphParticipants = async () => ['1'];

        const canRead = await (agent as any).canReadContextGraph('local-private-cg');
        expect(canRead).toBe(true);

        const cannotRead = await (agent as any).canReadContextGraph('unsubscribed-private-cg');
        expect(cannotRead).toBe(false);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('authorizeSyncRequest uses verifySyncIdentity when available', async () => {
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const wallet = ethers.Wallet.createRandom();
      const agent = await DKGAgent.create({
        name: 'SyncIdentityTest',
        listenHost: '127.0.0.1',
        chainAdapter: chain,
      });
      try {
        await agent.start();
        (agent as any).subscribedContextGraphs.set('private-cg', {
          name: 'private-cg',
          subscribed: false,
          synced: true,
          onChainId: '1',
        });
        (agent as any).isPrivateContextGraph = async () => true;
        (agent as any).getPrivateContextGraphParticipants = async () => [
          wallet.address, '1',
        ];
        let syncIdentityCalled = false;
        let ackIdentityCalled = false;
        (chain as any).verifySyncIdentity = async () => { syncIdentityCalled = true; return true; };
        const origVerifyACK = chain.verifyACKIdentity?.bind(chain);
        (chain as any).verifyACKIdentity = async (...args: unknown[]) => { ackIdentityCalled = true; return origVerifyACK?.(...args); };

        const request = {
          contextGraphId: 'private-cg',
          offset: 0,
          limit: 10,
          includeSharedMemory: false,
          targetPeerId: agent.peerId,
          requesterPeerId: 'peer-req',
          requestId: `req-${Date.now()}`,
          issuedAtMs: Date.now(),
          requesterIdentityId: '1',
        };

        const digest = (agent as any).computeSyncDigest(
          request.contextGraphId, request.offset, request.limit,
          request.includeSharedMemory, request.targetPeerId,
          request.requesterPeerId, request.requestId, request.issuedAtMs,
        );
        const sig = ethers.Signature.from(await wallet.signMessage(digest));

        const signed = {
          ...request,
          requesterSignatureR: sig.r,
          requesterSignatureVS: sig.yParityAndS,
        };

        const result = await (agent as any).authorizeSyncRequest(signed, 'peer-req');
        expect(result).toBe(true);
        expect(syncIdentityCalled).toBe(true);
        expect(ackIdentityCalled).toBe(false);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('authorizeSyncRequest denies when signer does not verify for claimed identityId', async () => {
      const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const wallet = ethers.Wallet.createRandom();
      const agent = await DKGAgent.create({
        name: 'SyncIdentityMismatchTest',
        listenHost: '127.0.0.1',
        chainAdapter: chain,
      });
      try {
        await agent.start();
        (agent as any).subscribedContextGraphs.set('private-cg', {
          name: 'private-cg',
          subscribed: false,
          synced: true,
          onChainId: '1',
        });
        (agent as any).isPrivateContextGraph = async () => true;
        (agent as any).getPrivateContextGraphParticipants = async () => ['108', wallet.address];
        (chain as any).verifySyncIdentity = async () => false;

        const request = {
          contextGraphId: 'private-cg',
          offset: 0,
          limit: 10,
          includeSharedMemory: false,
          targetPeerId: agent.peerId,
          requesterPeerId: 'peer-req',
          requestId: `req-${Date.now()}`,
          issuedAtMs: Date.now(),
          requesterIdentityId: '108',
        };

        const digest = (agent as any).computeSyncDigest(
          request.contextGraphId,
          request.offset,
          request.limit,
          request.includeSharedMemory,
          request.targetPeerId,
          request.requesterPeerId,
          request.requestId,
          request.issuedAtMs,
        );
        const sig = ethers.Signature.from(await wallet.signMessage(digest));
        const signed = {
          ...request,
          requesterSignatureR: sig.r,
          requesterSignatureVS: sig.yParityAndS,
        };

        const result = await (agent as any).authorizeSyncRequest(signed, 'peer-req');
        expect(result).toBe(false);
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('buildSyncRequest uses pipe-delimited format for public CGs', async () => {
      const agent = await DKGAgent.create({
        name: 'BuildReqPublic',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      try {
        await agent.start();
        (agent as any).subscribedContextGraphs.set('public-cg', {
          name: 'public-cg', subscribed: true, synced: true,
        });
        const bytes = await (agent as any).buildSyncRequest('public-cg', 5, 100, false, 'peer-remote', 'meta');
        const text = new TextDecoder().decode(bytes);
        expect(text).toBe('public-cg|5|100|meta');

        const sessionBytes = await (agent as any).buildSyncRequest('public-cg', 5, 100, false, 'peer-remote', 'meta', undefined, undefined, 'meta-session');
        const sessionText = new TextDecoder().decode(sessionBytes);
        expect(sessionText).toBe('public-cg|5|100|meta|session|meta-session');
      } finally {
        await agent.stop().catch(() => {});
      }
    });


    it('buildSyncRequest stays unauthenticated for discovered public CGs', async () => {
      const agent = await DKGAgent.create({
        name: 'BuildReqDiscoveredPublic',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      try {
        await agent.start();
        (agent as any).subscribedContextGraphs.set('discovered-public-cg', {
          name: 'discovered-public-cg',
          subscribed: false,
          synced: true,
        });

        const bytes = await (agent as any).buildSyncRequest('discovered-public-cg', 0, 50, false, 'peer-remote');
        const text = new TextDecoder().decode(bytes);

        expect(text).toBe('discovered-public-cg|0|50');
      } finally {
        await agent.stop().catch(() => {});
      }
    });
});
