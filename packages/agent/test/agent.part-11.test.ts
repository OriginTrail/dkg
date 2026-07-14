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


    // Regression coverage for PR #200's multi-agent access control. When a
    // non-default local agent creates a CG (callerAgentAddress !=
    // defaultAgentAddress), every owner-checked route must:
    //   - accept the owning caller wallet,
    //   - reject the node's default-agent token, and
    //   - reject a sibling agent wallet on the same node.
    // This exercises approve/revoke (CCL policy) and invite (peer allowlist);
    // registerContextGraph is covered implicitly through `isCallerOrNodeOwner`
    // sharing the same code path as invite via `assertCallerIsOwner`.
    it('scopes CG management to the owning non-default agent across policy and invite paths', async () => {
      const store = new OxigraphStore();
      const node = await DKGAgent.create({
        name: 'MultiAgentNode',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await node.start();

      const nonDefaultAddr = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const siblingAddr = new ethers.Wallet(HARDHAT_KEYS.REC2_OP).address;
      const invitePeerId = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';

      await node.createContextGraph({
        id: 'ops-multi-agent',
        name: 'Multi-Agent CG',
        callerAgentAddress: nonDefaultAddr,
      });

      const published = await node.publishCclPolicy({
        contextGraphId: 'ops-multi-agent',
        name: 'incident-review',
        version: '0.1.0',
        content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
      });

      // --- approveCclPolicy ---
      await expect(node.approveCclPolicy({ contextGraphId: 'ops-multi-agent', policyUri: published.policyUri }))
        .rejects.toThrow(/Only the contextGraph owner can manage policies/);
      await expect(node.approveCclPolicy({ contextGraphId: 'ops-multi-agent', policyUri: published.policyUri, callerAgentAddress: siblingAddr }))
        .rejects.toThrow(/Only the contextGraph owner can manage policies/);
      await expect(node.approveCclPolicy({ contextGraphId: 'ops-multi-agent', policyUri: published.policyUri, callerAgentAddress: nonDefaultAddr }))
        .resolves.toBeTruthy();

      // --- revokeCclPolicy ---
      await expect(node.revokeCclPolicy({ contextGraphId: 'ops-multi-agent', policyUri: published.policyUri }))
        .rejects.toThrow(/Only the contextGraph owner can manage policies/);
      await expect(node.revokeCclPolicy({ contextGraphId: 'ops-multi-agent', policyUri: published.policyUri, callerAgentAddress: siblingAddr }))
        .rejects.toThrow(/Only the contextGraph owner can manage policies/);
      await expect(node.revokeCclPolicy({ contextGraphId: 'ops-multi-agent', policyUri: published.policyUri, callerAgentAddress: nonDefaultAddr }))
        .resolves.toMatchObject({ status: 'revoked' });

      // --- inviteToContextGraph ---
      await expect(node.inviteToContextGraph('ops-multi-agent', invitePeerId))
        .rejects.toThrow(/Only the context graph creator can manage peer invitations/);
      await expect(node.inviteToContextGraph('ops-multi-agent', invitePeerId, siblingAddr))
        .rejects.toThrow(/Only the context graph creator can manage peer invitations/);
      await expect(node.inviteToContextGraph('ops-multi-agent', invitePeerId, nonDefaultAddr))
        .resolves.toBeUndefined();

      // --- rejectJoinRequest (G1 security fix, notifications-pane redesign) ---
      // Before the fix, rejectJoinRequest had NO owner check while approve was
      // gated — any local-token caller could reject a pending request. It now
      // mirrors the same `assertContextGraphOwner` gate. Seed a pending request,
      // then prove the same three-way owner gating + that rejected attempts do
      // not mutate state (the authz throw happens before the store write).
      const joinRequester = new ethers.Wallet(HARDHAT_KEYS.REC2_OP).address;
      const requestUri = `did:dkg:join-request:ops-multi-agent:${joinRequester.toLowerCase()}`;
      const reqStatus = async () => {
        const r = await store.query(
          `SELECT ?s WHERE { GRAPH <${contextGraphMetaUri('ops-multi-agent')}> { <${requestUri}> <https://dkg.network/ontology#requestStatus> ?s } }`,
        );
        return r.type === 'bindings' && r.bindings.length > 0
          ? String((r.bindings[0] as Record<string, string>)['s']).replace(/^"|"(\^\^.*)?$/g, '')
          : null;
      };
      await node.storePendingJoinRequest('ops-multi-agent', {
        agentAddress: joinRequester,
        scope: 'test-scope',
        issuedAtMs: Date.now(),
        delegateePeerId: invitePeerId,
        signature: `0x${'a'.repeat(130)}`,
      } as any, 'Requester');
      expect(await reqStatus()).toBe('pending');

      // Default-agent token (no explicit caller) — the owner is the non-default
      // wallet, so this is NOT authorised.
      await expect(node.rejectJoinRequest('ops-multi-agent', joinRequester))
        .rejects.toThrow(/Only the context graph curator/);
      // Sibling agent wallet on the same node — not the owner.
      await expect(node.rejectJoinRequest('ops-multi-agent', joinRequester, siblingAddr))
        .rejects.toThrow(/Only the context graph curator/);
      // Neither rejected attempt mutated the request status.
      expect(await reqStatus()).toBe('pending');
      // The owning curator wallet — authorised; flips the request to rejected.
      await expect(node.rejectJoinRequest('ops-multi-agent', joinRequester, nonDefaultAddr))
        .resolves.toBeUndefined();
      expect(await reqStatus()).toBe('rejected');

      await node.stop().catch(() => {});
    });

    // GH #757 follow-up (Codex review on PR #1132): the notifications route
    // passes a LOWERCASED token-verified caller address, while curator DIDs are
    // stored as written (usually EIP-55 checksummed). The owner check must
    // compare EVM addresses case-insensitively or the true curator's
    // pending-join read fails and notifications silently drop.
    it('listPendingJoinRequests accepts the curator address case-insensitively and still rejects non-curators', async () => {
      const store = new OxigraphStore();
      const node = await DKGAgent.create({
        name: 'CaseInsensitiveCuratorNode',
        store,
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await node.start();

      const curatorAddr = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address; // checksummed
      const siblingAddr = new ethers.Wallet(HARDHAT_KEYS.REC2_OP).address;
      await node.createContextGraph({
        id: 'ops-case-insensitive',
        name: 'Case CG',
        callerAgentAddress: curatorAddr,
      });

      // Lowercased caller (exactly what the notifications route resolves) —
      // must be accepted as the curator.
      await expect(node.listPendingJoinRequests('ops-case-insensitive', curatorAddr.toLowerCase()))
        .resolves.toEqual([]);
      // Checksummed caller still works.
      await expect(node.listPendingJoinRequests('ops-case-insensitive', curatorAddr))
        .resolves.toEqual([]);
      // Non-curator agents (any casing) and the node default agent stay rejected.
      await expect(node.listPendingJoinRequests('ops-case-insensitive', siblingAddr.toLowerCase()))
        .rejects.toThrow(/Only the context graph curator/);
      await expect(node.listPendingJoinRequests('ops-case-insensitive'))
        .rejects.toThrow(/Only the context graph curator/);

      await node.stop().catch(() => {});
    });


    it('maps local access policy to EVM publish policy and forwards participant agents on registration', async () => {
      const chain = new AsyncSignerAddressContextGraphChainAdapter();
      const agent = await DKGAgent.create({
        name: 'RegistrationPolicyBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      const ownerAgent = ethers.getAddress(chain.signerAddress);
      const allowedAgent = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const nonDefaultOwnerAgent = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;

      await expect(agent.createContextGraph({
        id: 'register-zero-participant-agent',
        name: 'Zero Participant Agent',
        accessPolicy: 1,
        participantAgents: [ethers.ZeroAddress],
        callerAgentAddress: ownerAgent,
      })).rejects.toThrow(/zero address/);
      await expect(agent.createContextGraph({
        id: 'register-duplicate-participant-agent',
        name: 'Duplicate Participant Agent',
        accessPolicy: 1,
        participantAgents: [allowedAgent, allowedAgent.toLowerCase()],
        callerAgentAddress: ownerAgent,
      })).rejects.toThrow(/Duplicate Ethereum address/);
      await expect(agent.createContextGraph({
        id: 'register-open-participant-agent',
        name: 'Open Participant Agent',
        participantAgents: [allowedAgent],
        callerAgentAddress: ownerAgent,
      })).rejects.toThrow(/Set accessPolicy: 1/);
      await expect(agent.createContextGraph({
        id: 'register-too-many-participant-agents',
        name: 'Too Many Participant Agents',
        accessPolicy: 1,
        participantAgents: Array.from({ length: 257 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`),
        callerAgentAddress: ownerAgent,
      })).rejects.toThrow(/participantAgents cannot exceed/);
      // OT-RFC-38 / LU-6 Phase B (Codex PR #610 fd5b31f1 round-2): on
      // single-tenant edge nodes (the mainnet launch deployment shape),
      // the previous strict "curator agent must equal chain signer"
      // policy was needless friction — every user is also the node
      // operator, so the chain signer IS the curator from the user's
      // perspective. The new default auto-promotes the chain signer as
      // the on-chain governance owner and persists the calling agent as
      // a participantAgent. Multi-tenant cores can opt back into the
      // legacy strict check via `{ strictEoaCuratorMatch: true }`.
      await agent.createContextGraph({
        id: 'register-non-default-curated-policy',
        name: 'Non-default Curated Policy',
        accessPolicy: 1,
        callerAgentAddress: nonDefaultOwnerAgent,
      });
      await expect(agent.registerContextGraph('register-non-default-curated-policy', { callerAgentAddress: nonDefaultOwnerAgent }))
        .resolves.toMatchObject({ onChainId: expect.any(String) });
      // Strict mode preserves the legacy reject for multi-tenant cores.
      await agent.createContextGraph({
        id: 'register-non-default-curated-policy-strict',
        name: 'Non-default Curated Policy (Strict)',
        accessPolicy: 1,
        callerAgentAddress: nonDefaultOwnerAgent,
      });
      await expect(agent.registerContextGraph('register-non-default-curated-policy-strict', {
        callerAgentAddress: nonDefaultOwnerAgent,
        strictEoaCuratorMatch: true,
      })).rejects.toThrow(/strictEoaCuratorMatch was requested|Per-agent chain signers are not supported/);

      await agent.createContextGraph({ id: 'register-open-policy', name: 'Open Policy', callerAgentAddress: ownerAgent });
      await agent.registerContextGraph('register-open-policy', { callerAgentAddress: ownerAgent });

      await agent.createContextGraph({
        id: 'register-curated-policy',
        name: 'Curated Policy',
        accessPolicy: 1,
        participantAgents: [allowedAgent],
        callerAgentAddress: ownerAgent,
      });
      await agent.registerContextGraph('register-curated-policy', { callerAgentAddress: ownerAgent });

      // Issue #865 — pre-#865 this case created the CG with NO explicit
      // accessPolicy and relied on `inviteAgentToContextGraph` writing a
      // DKG_ALLOWED_AGENT triple to silently promote the CG to curated
      // via `isPrivateContextGraph`'s allowlist heuristic on register.
      // That auto-promote was the rc.12 bug surfaced as the
      // "modal said Open but CG persisted as invite-only" symptom; the
      // heuristic now only fires when no explicit accessPolicy exists.
      // Express the curated intent up-front so this test continues to
      // assert the "registers as curated and forwards the allowlist as
      // participantAgents" contract (the on-chain effect the original
      // test was protecting).
      await agent.createContextGraph({
        id: 'register-agent-allowlist-policy',
        name: 'Agent Allowlist Policy',
        accessPolicy: 1,
        callerAgentAddress: ownerAgent,
      });
      await agent.inviteAgentToContextGraph('register-agent-allowlist-policy', allowedAgent, ownerAgent);
      await agent.registerContextGraph('register-agent-allowlist-policy', { callerAgentAddress: ownerAgent });

      await agent.createContextGraph({
        id: 'register-public-curated-publish-policy',
        name: 'Public Curated Publish Policy',
        callerAgentAddress: ownerAgent,
      });
      await agent.registerContextGraph('register-public-curated-publish-policy', {
        callerAgentAddress: ownerAgent,
        publishPolicy: 0,
      });

      // OT-RFC-38 / LU-6 Phase B (Codex PR #610 fd5b31f1 round-2):
      // chain calls are now indexed from `[1]` because the relaxed-default
      // register at `register-non-default-curated-policy` (above) succeeds
      // and produces chain call `[0]` ahead of the previously-first
      // `register-open-policy`.
      expect(chain.createOnChainContextGraphCalls[0]?.accessPolicy).toBe(1);
      expect(chain.createOnChainContextGraphCalls[1]).toMatchObject({
        accessPolicy: 0,
        publishPolicy: 1,
        participantAgents: [],
      });
      expect(chain.createOnChainContextGraphCalls[2]?.accessPolicy).toBe(1);
      expect(chain.createOnChainContextGraphCalls[2]?.publishPolicy).toBe(0);
      expect(chain.createOnChainContextGraphCalls[2]?.publishAuthority).toBe(ethers.getAddress(chain.signerAddress));
      expect(chain.createOnChainContextGraphCalls[2]?.participantAgents).toContain(allowedAgent);
      expect(chain.createOnChainContextGraphCalls[3]?.accessPolicy).toBe(1);
      expect(chain.createOnChainContextGraphCalls[3]?.publishPolicy).toBe(0);
      expect(chain.createOnChainContextGraphCalls[3]?.publishAuthority).toBe(ethers.getAddress(chain.signerAddress));
      // OT-RFC-38 / LU-6 Phase B — `getContextGraphParticipantAgentAddresses`
      // now unions DKG_PARTICIPANT_AGENT with DKG_ALLOWED_AGENT so the
      // on-chain participant list is a superset of the local allowlist.
      // This CG was registered via `inviteAgentToContextGraph(... allowedAgent)`
      // which writes a DKG_ALLOWED_AGENT triple; under Phase B the
      // chain registration must forward that wallet so cores can
      // authority-check its envelopes after auto-hosting.
      //
      // Issue #865 follow-up: because the create call now passes
      // `accessPolicy: 1` up-front (the previous test relied on the
      // now-removed "invite auto-promotes to curated" inference), the
      // creator-auto-include at `dkg-agent.ts:13085` adds the curator
      // (`ownerAgent`) to the local allowlist at create-time. The
      // subsequent invite layers `allowedAgent` on top, so the
      // chain-forwarded participant set is the union of both.
      expect(chain.createOnChainContextGraphCalls[3]?.participantAgents).toEqual(
        expect.arrayContaining([allowedAgent, ownerAgent]),
      );
      expect(chain.createOnChainContextGraphCalls[3]?.participantAgents).toHaveLength(2);
      expect(chain.createOnChainContextGraphCalls[4]?.accessPolicy).toBe(0);
      expect(chain.createOnChainContextGraphCalls[4]?.publishPolicy).toBe(0);
      expect(chain.createOnChainContextGraphCalls[4]?.publishAuthority).toBe(ethers.getAddress(chain.signerAddress));

      await agent.stop().catch(() => {});
    });


    it('uses best-effort adapter publisher-address inference for curated CG registration', async () => {
      const chain = new SignerListContextGraphChainAdapter();
      const agent = await DKGAgent.create({
        name: 'RegistrationSignerListBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      const ownerAgent = ethers.getAddress(chain.signerAddress);
      await agent.createContextGraph({
        id: 'register-curated-signer-list-policy',
        name: 'Curated Signer List Policy',
        accessPolicy: 1,
        callerAgentAddress: ownerAgent,
      });
      await agent.registerContextGraph('register-curated-signer-list-policy', { callerAgentAddress: ownerAgent });

      expect(chain.createOnChainContextGraphCalls[0]?.publishAuthority).toBe(ownerAgent);
      await agent.stop().catch(() => {});
    });


    // Codex PR #502 round-4: replaces the previous "without requiring
    // chain signer == local curator" test. The agent now enforces
    // "advertised curator == on-chain owner == chain signer == PCA
    // owner" so the registration tx's msg.sender (which mints the
    // on-chain governance NFT) is the same address as the PCA owner.
    // Non-default node operators CAN still PCA-register — they just
    // need to control the chain signer used for the registration tx.
    it('registers PCA curated context graphs when the PCA owner controls the chain signer (non-default operator)', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const pcaAccountId = 42n;
      // Chain signer is configured to BE the PCA owner — the PCA owner
      // controls the registration-tx msg.sender, so the governance NFT
      // mints to them.
      const chain = new PcaCuratedRegistrationChainAdapter(
        new Map([[pcaAccountId, pcaOwner]]),
        pcaOwner,
      );
      const agent = await DKGAgent.create({
        name: 'PcaRegistrationBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      expect(pcaOwner.toLowerCase()).toBe(chain.signerAddress.toLowerCase());
      await agent.createContextGraph({
        id: 'register-pca-curated-policy',
        name: 'PCA Curated Policy',
        accessPolicy: 1,
        callerAgentAddress: pcaOwner,
      });

      // pcaAccountId is a register-time knob now (Codex PR #502 round-3);
      // callers must supply it on `registerContextGraph` rather than
      // relying on a create-time persist that could silently replay a
      // stale id.
      await expect(agent.registerContextGraph('register-pca-curated-policy', {
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


    // PCA registration must fail closed when the adapter exposes the PCA
    // owner but not its tx signer. Without signer introspection the agent
    // cannot prove either owner mode or exact-PCA registered-agent mode, and
    // cannot keep local curator ownership aligned with the minted CG NFT.
    it('rejects PCA registration when chain adapter does not expose its tx signer', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const pcaAccountId = 242n;
      class SignerlessPcaChainAdapter extends PcaCuratedRegistrationChainAdapter {
        constructor(accountOwners: Map<bigint, string>) {
          // signerAddress = zero address: every probe path in
          // inferAdapterPublisherAddress filters it out via
          // normalizeAdapterPublisherAddress, so
          // getChainPublishAuthorityAddress returns undefined.
          super(accountOwners, ethers.ZeroAddress);
        }
        override async getSignerAddress(): Promise<string> {
          throw new Error('signer address not exposed by this adapter');
        }
      }
      const chain = new SignerlessPcaChainAdapter(new Map([[pcaAccountId, pcaOwner]]));
      const agent = await DKGAgent.create({
        name: 'PcaSignerlessAdapterBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await agent.createContextGraph({
        id: 'reject-pca-signerless-adapter',
        name: 'Reject PCA signerless adapter',
        accessPolicy: 1,
        callerAgentAddress: pcaOwner,
      });

      await expect(agent.registerContextGraph('reject-pca-signerless-adapter', {
        callerAgentAddress: pcaOwner,
        publishAuthorityAccountId: pcaAccountId,
      })).rejects.toThrow(/does not expose its registration-tx signer|owner\/agent authorization cannot be verified/);

      expect(chain.createOnChainContextGraphCalls).toHaveLength(0);
      await agent.stop().catch(() => {});
    });


    // Keep the local curator and registration signer aligned even after
    // #1366 permits exact-PCA registered agents to create waived CGs. A
    // different signer would own the on-chain Context Graph NFT while local
    // metadata names the PCA owner as curator.
    it('rejects PCA registration when local curator differs from the chain signer', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const pcaAccountId = 142n;
      // Chain signer is INTENTIONALLY different from the PCA owner —
      // simulates a node operator trying to PCA-register a CG using a
      // PCA they don't control the signer for.
      const chain = new PcaCuratedRegistrationChainAdapter(
        new Map([[pcaAccountId, pcaOwner]]),
        /* signerAddress: */ undefined,  // default MOCK_DEFAULT_SIGNER (0x1111...)
      );
      const agent = await DKGAgent.create({
        name: 'PcaSignerMismatchBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      expect(pcaOwner.toLowerCase()).not.toBe(chain.signerAddress.toLowerCase());
      await agent.createContextGraph({
        id: 'reject-pca-signer-mismatch',
        name: 'Reject PCA signer mismatch',
        accessPolicy: 1,
        callerAgentAddress: pcaOwner,
      });

      await expect(agent.registerContextGraph('reject-pca-signer-mismatch', {
        callerAgentAddress: pcaOwner,
        publishAuthorityAccountId: pcaAccountId,
      })).rejects.toThrow(/local curator .* differs from registration chain signer|wallet that will own the on-chain Context Graph NFT/);

      expect(chain.createOnChainContextGraphCalls).toHaveLength(0);
      await agent.stop().catch(() => {});
    });


    it('registers PCA curated context graphs when the PCA account id is supplied at registration time', async () => {
      const pcaOwner = new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address;
      const pcaAccountId = 43n;
      const chain = new PcaCuratedRegistrationChainAdapter(
        new Map([[pcaAccountId, pcaOwner]]),
        pcaOwner,
      );
      const agent = await DKGAgent.create({
        name: 'PcaRegistrationOverrideBot',
        store: new OxigraphStore(),
        chainAdapter: chain,
        nodeRole: 'core',
      });
      await agent.start();

      await agent.createContextGraph({
        id: 'register-pca-curated-override-policy',
        name: 'PCA Curated Override Policy',
        accessPolicy: 1,
        callerAgentAddress: pcaOwner,
      });

      await expect(agent.registerContextGraph('register-pca-curated-override-policy', {
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
