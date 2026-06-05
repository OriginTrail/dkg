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


    // OT-RFC-38 / LU-6 Phase B (Codex PR #610 fd5b31f1 fix):
    // `publishPolicy` and `publishAuthorityAccountId` are now PERSISTED
    // at create time so the deferred-registration path
    // (memory.ts auto-register on first VM publish) preserves the
    // user's create-time choice. Replaces the Codex PR #502 round-6/7
    // "reject at create boundary" rule — the original concern (silent
    // drop) is now solved by persistence + read-at-register rather than
    // by forcing two-step flows. Boundary validation still rejects
    // invalid combinations (PCA on open-publish, non-positive ids,
    // non-{0,1} policies).
    it('rejects publishAuthorityAccountId on createContextGraph() with publishPolicy=1 (open)', async () => {
      const chain = new PcaCuratedRegistrationChainAdapter(new Map([[7n, ethers.Wallet.createRandom().address]]));
      const agent = await DKGAgent.create({
        name: 'PcaOpenPolicyBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await expect(agent.createContextGraph({
        id: 'reject-pca-create-open',
        name: 'Reject PCA Create (Open)',
        publishPolicy: 1,
        publishAuthorityAccountId: 7n,
        callerAgentAddress: ethers.getAddress(chain.signerAddress),
      })).rejects.toThrow(/PCA|publishAuthorityAccountId|curated publishPolicy/i);

      await expect(agent.createContextGraph({
        id: 'reject-pca-create-non-positive',
        name: 'Reject PCA Create (non-positive)',
        accessPolicy: 1,
        publishAuthorityAccountId: 0n,
        callerAgentAddress: ethers.getAddress(chain.signerAddress),
      })).rejects.toThrow(/positive integer/i);

      await agent.stop().catch(() => {});
    });


    it('persists publishPolicy + publishAuthorityAccountId at create time and propagates to registerContextGraph', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const pcaAccountId = 42n;
      const chain = new PcaCuratedRegistrationChainAdapter(
        new Map([[pcaAccountId, pcaOwner]]),
        pcaOwner,
      );
      const agent = await DKGAgent.create({
        name: 'PcaPersistedBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await agent.createContextGraph({
        id: 'pca-persisted-create',
        name: 'PCA Persisted Create',
        accessPolicy: 1,
        publishPolicy: 0,
        publishAuthorityAccountId: pcaAccountId,
        callerAgentAddress: pcaOwner,
      });

      const stored = await agent.getStoredContextGraphRegistrationOptions('pca-persisted-create');
      expect(stored.publishPolicy).toBe(0);
      expect(stored.publishAuthorityAccountId).toBe(pcaAccountId);

      // Deferred-register path: pass NO publishPolicy/PCA at register
      // time — the persisted create-time values must flow through.
      // memory.ts's auto-register call reads them via
      // `getStoredContextGraphRegistrationOptions` and forwards them.
      await expect(agent.registerContextGraph('pca-persisted-create', {
        callerAgentAddress: pcaOwner,
        publishPolicy: stored.publishPolicy,
        publishAuthorityAccountId: stored.publishAuthorityAccountId,
      })).resolves.toMatchObject({ onChainId: expect.any(String) });

      expect(chain.createOnChainContextGraphCalls[0]).toMatchObject({
        publishPolicy: 0,
        publishAuthority: pcaOwner,
        publishAuthorityAccountId: pcaAccountId,
      });
      await agent.stop().catch(() => {});
    });


    it('rejects PCA curated registration when local curator is not the PCA owner', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const nonOwner = new ethers.Wallet(HARDHAT_KEYS.REC2_OP).address;
      const pcaAccountId = 99n;
      const chain = new PcaCuratedRegistrationChainAdapter(new Map([[pcaAccountId, pcaOwner]]));
      const agent = await DKGAgent.create({
        name: 'PcaRejectsNonOwnerBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      expect(nonOwner.toLowerCase()).not.toBe(pcaOwner.toLowerCase());
      await agent.createContextGraph({
        id: 'reject-pca-non-owner',
        name: 'Reject PCA non-owner',
        accessPolicy: 1,
        callerAgentAddress: nonOwner,
      });

      // pcaAccountId at register time (not create) per Codex PR #502
      // round-3 contract change.
      await expect(agent.registerContextGraph('reject-pca-non-owner', {
        callerAgentAddress: nonOwner,
        publishAuthorityAccountId: pcaAccountId,
      })).rejects.toThrow(/PCA account 99|only the PCA owner/i);

      expect(chain.createOnChainContextGraphCalls).toHaveLength(0);
      await agent.stop().catch(() => {});
    });


    // Codex review #502-1: a failed PCA registration must not leave the
    // requested pcaAccountId persisted in local CG metadata. If it did,
    // every retry would silently replay the same bad id from storage even
    // after the caller corrects their request.
    it('does NOT persist the requested PCA account id when registration fails (e.g. nonexistent token)', async () => {
      const badAccountId = 999n;
      const chain = new PcaCuratedRegistrationChainAdapter(new Map());
      // Use the chain's own signer as the local curator so the EOA-curated
      // branch (the fallback after persist-rollback) can succeed without
      // chain-signer mismatch. The bad id throws on owner lookup (no entry
      // in the map), so the persist must NOT fire.
      const ownerAddr = ethers.getAddress(chain.signerAddress);
      const agent = await DKGAgent.create({
        name: 'PcaPersistRollbackBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await agent.createContextGraph({
        id: 'pca-persist-rollback',
        name: 'PCA Persist Rollback',
        accessPolicy: 1,
        callerAgentAddress: ownerAddr,
      });

      // First attempt: bad pcaAccountId. PcaCuratedRegistrationChainAdapter
      // throws on `getPublishingConvictionAccountOwner(badAccountId)`, which
      // the agent now wraps into a stable "PCA account ... does not exist"
      // error (#502-3) and short-circuits before persisting.
      await expect(agent.registerContextGraph('pca-persist-rollback', {
        callerAgentAddress: ownerAddr,
        publishAuthorityAccountId: badAccountId,
      })).rejects.toThrow(/PCA account 999 does not exist/);
      expect(chain.createOnChainContextGraphCalls).toHaveLength(0);

      // Second attempt: caller omits pcaAccountId. If the bad id had been
      // persisted on the failed first attempt, the resolver would replay
      // it from storage and the call would throw the same "PCA account 999
      // does not exist" error again. With the fix it doesn't — the
      // resolver finds no stored id and falls through to the EOA-curated
      // branch (publishAuthority = chain signer = local curator).
      await expect(agent.registerContextGraph('pca-persist-rollback', {
        callerAgentAddress: ownerAddr,
      })).resolves.toMatchObject({ onChainId: expect.any(String) });

      expect(chain.createOnChainContextGraphCalls).toHaveLength(1);
      expect(chain.createOnChainContextGraphCalls[0]).toMatchObject({
        publishPolicy: 0,
        publishAuthority: ownerAddr,
      });
      // No `publishAuthorityAccountId` on the on-chain call confirms the
      // bad id is gone (the field is conditionally spread only when
      // `isPcaCurated`).
      expect(chain.createOnChainContextGraphCalls[0]?.publishAuthorityAccountId ?? 0n).toBe(0n);
      await agent.stop().catch(() => {});
    });


    // Codex PR #502 round-7: a previous iteration of this test asserted
    // that `accessPolicy=0 + publishPolicy=0 + pcaAccountId` should be
    // rejected client-side as "curated/private only". That was wrong —
    // the on-chain `ContextGraphs.createContextGraph` contract supports
    // this exact combo (publicly-discoverable CG, only PCA-authorized
    // publishers can write). The agent guard now rejects ONLY
    // `publishPolicy === EVM_PUBLISH_OPEN + PCA`. This positive test
    // pins the broader valid-mode contract.
    it('accepts PCA registration with accessPolicy=0 (public) + publishPolicy=0 (curated) + pcaAccountId — public-discoverable + PCA-curated is on-chain valid', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const pcaAccountId = 88n;
      // Chain signer == PCA owner per the round-4 invariant.
      const chain = new PcaCuratedRegistrationChainAdapter(
        new Map([[pcaAccountId, pcaOwner]]),
        pcaOwner,
      );
      const agent = await DKGAgent.create({
        name: 'PcaPublicDiscoverableBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      // Create as a plain (no allowlist, no private) CG.
      await agent.createContextGraph({
        id: 'accept-public-discoverable-pca',
        name: 'Accept public-discoverable + PCA',
        callerAgentAddress: pcaOwner,
      });

      await expect(agent.registerContextGraph('accept-public-discoverable-pca', {
        callerAgentAddress: pcaOwner,
        accessPolicy: 0,
        publishPolicy: 0,
        publishAuthorityAccountId: pcaAccountId,
      })).resolves.toMatchObject({ onChainId: expect.any(String) });

      expect(chain.createOnChainContextGraphCalls[0]).toMatchObject({
        accessPolicy: 0,
        publishPolicy: 0,
        publishAuthority: pcaOwner,
        publishAuthorityAccountId: pcaAccountId,
      });
      await agent.stop().catch(() => {});
    });


    // Codex PR #502 round-7 (complementary negative test): the only
    // axis where PCA is incoherent is `publishPolicy === EVM_PUBLISH_OPEN`.
    // The on-chain `isAuthorizedPublisher`'s PCA branch never fires for
    // open publish policy, so the combo is genuinely meaningless.
    it('rejects PCA registration when publishPolicy is open (regardless of accessPolicy)', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const pcaAccountId = 188n;
      const chain = new PcaCuratedRegistrationChainAdapter(
        new Map([[pcaAccountId, pcaOwner]]),
        pcaOwner,
      );
      const agent = await DKGAgent.create({
        name: 'PcaOpenPublishPolicyBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await agent.createContextGraph({
        id: 'reject-open-publish-policy-pca',
        name: 'Reject open publishPolicy + PCA',
        callerAgentAddress: pcaOwner,
      });

      await expect(agent.registerContextGraph('reject-open-publish-policy-pca', {
        callerAgentAddress: pcaOwner,
        publishPolicy: 1,  // open
        publishAuthorityAccountId: pcaAccountId,
      })).rejects.toThrow(/curated publish policy/i);

      expect(chain.createOnChainContextGraphCalls).toHaveLength(0);
      await agent.stop().catch(() => {});
    });


    // Codex review #502 follow-up: only KNOWN nonexistent-token reverts
    // should be translated to "PCA account ... does not exist". Transient
    // RPC / adapter failures must preserve their original message so the
    // daemon mapping doesn't synthesize a 404 for retriable issues.
    it('does NOT rewrite generic adapter failures (e.g. RPC outages) as "PCA does not exist"', async () => {
      const rpcOutageMsg = 'connection refused: chain RPC unreachable';
      class RpcOutageChainAdapter extends AsyncSignerAddressContextGraphChainAdapter {
        async getPublishingConvictionAccountOwner(_accountId: bigint): Promise<string> {
          throw new Error(rpcOutageMsg);
        }
      }
      const chain = new RpcOutageChainAdapter();
      const pcaOwner = ethers.getAddress(chain.signerAddress);
      const agent = await DKGAgent.create({
        name: 'PcaRpcOutageBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await agent.createContextGraph({
        id: 'rpc-outage-during-register',
        name: 'RPC Outage During Register',
        accessPolicy: 1,
        callerAgentAddress: pcaOwner,
      });

      // The thrown error must preserve the original RPC outage message
      // verbatim and must NOT be wrapped as "PCA account ... does not
      // exist" — the daemon mapping would otherwise turn a retriable
      // 5xx-class infrastructure failure into a misleading 404.
      let caught: Error | undefined;
      try {
        await agent.registerContextGraph('rpc-outage-during-register', {
          callerAgentAddress: pcaOwner,
          publishAuthorityAccountId: 42n,
        });
      } catch (err: any) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught?.message ?? '').toContain(rpcOutageMsg);
      expect(caught?.message ?? '').not.toMatch(/PCA account 42 does not exist/);

      await agent.stop().catch(() => {});
    });


    // Codex PR #502 round-9: untyped callers can pass `1` / `'1'` /
    // `1n` for pcaAccountId. The previous round-8 coercion accepted
    // `Number.isInteger(...)`, which silently lets unsafe ints
    // (above 2^53-1) round-trip through `BigInt(...)` with the wrong
    // value. Test pins the safer `Number.isSafeInteger` contract.
    it('rejects unsafe JS integers as publishAuthorityAccountId — only safe ints / bigints / decimal strings accepted', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const chain = new PcaCuratedRegistrationChainAdapter(
        new Map([[42n, pcaOwner]]),
        pcaOwner,
      );
      const agent = await DKGAgent.create({
        name: 'PcaUnsafeIntegerBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await agent.createContextGraph({
        id: 'reject-unsafe-int-pca',
        name: 'Reject unsafe int PCA',
        accessPolicy: 1,
        callerAgentAddress: pcaOwner,
      });

      // 2^60 — well above Number.MAX_SAFE_INTEGER (2^53-1). JS would
      // silently round before BigInt(...) sees it.
      await expect(agent.registerContextGraph('reject-unsafe-int-pca', {
        callerAgentAddress: pcaOwner,
        publishAuthorityAccountId: Math.pow(2, 60) as unknown as bigint,
      })).rejects.toThrow(/PCA account id must be a positive integer/);

      // Negative number.
      await expect(agent.registerContextGraph('reject-unsafe-int-pca', {
        callerAgentAddress: pcaOwner,
        publishAuthorityAccountId: -1 as unknown as bigint,
      })).rejects.toThrow(/PCA account id must be a positive integer/);

      // Floating-point.
      await expect(agent.registerContextGraph('reject-unsafe-int-pca', {
        callerAgentAddress: pcaOwner,
        publishAuthorityAccountId: 1.5 as unknown as bigint,
      })).rejects.toThrow(/PCA account id must be a positive integer/);

      // Non-numeric string.
      await expect(agent.registerContextGraph('reject-unsafe-int-pca', {
        callerAgentAddress: pcaOwner,
        publishAuthorityAccountId: 'abc' as unknown as bigint,
      })).rejects.toThrow(/PCA account id must be a positive integer/);

      expect(chain.createOnChainContextGraphCalls).toHaveLength(0);
      await agent.stop().catch(() => {});
    });


    // Codex review #502-2: `{ private: true, accessPolicy: 0,
    // pcaAccountId }` create+register must not flip-flop between curated
    // (at create time) and open (at register time). The daemon route's
    // `inferredAccessPolicy` keeps both legs aligned; this test pins the
    // agent-level contract: `private: true` is a curated signal that
    // dominates accessPolicy=0.
    it('treats private:true as a curated signal that dominates accessPolicy=0 for PCA registration', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const pcaAccountId = 77n;
      // PCA owner controls the chain signer (Codex PR #502 round-4
      // contract: chain signer == PCA owner required for PCA mode).
      const chain = new PcaCuratedRegistrationChainAdapter(
        new Map([[pcaAccountId, pcaOwner]]),
        pcaOwner,
      );
      const agent = await DKGAgent.create({
        name: 'PcaPrivateOverridesAccessPolicyBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await agent.createContextGraph({
        id: 'pca-private-dominates',
        name: 'PCA Private Dominates AccessPolicy',
        private: true,
        callerAgentAddress: pcaOwner,
      });

      // Register with accessPolicy=1 (matches the daemon route's
      // `inferredAccessPolicy` for `private: true`). The agent must accept
      // and route into the PCA curated branch when pcaAccountId is
      // supplied at register time (Codex PR #502 round-3).
      await expect(agent.registerContextGraph('pca-private-dominates', {
        accessPolicy: 1,
        callerAgentAddress: pcaOwner,
        publishAuthorityAccountId: pcaAccountId,
      })).resolves.toMatchObject({ onChainId: expect.any(String) });

      expect(chain.createOnChainContextGraphCalls[0]).toMatchObject({
        publishPolicy: 0,
        publishAuthority: pcaOwner,
        publishAuthorityAccountId: pcaAccountId,
      });
      await agent.stop().catch(() => {});
    });
});
