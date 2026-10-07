// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';

import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';
import {
  CONTEXT_GRAPH_ID,
  JOIN_KEY_CACHE_GRAPH,
  PROFILE_GRAPH,
  ROUTES_CHANGED,
  TRANSPORT_CHANGED,
  signedKeyFixture,
  signedKeyQuads,
} from './_helpers/signed-private-keys.js';

/**
 * GH#3067. A private roster's snapshot checks what it depends on: the roster
 * by the transport re-read, the peer gate by its content, and the members'
 * keys and routes by a revision that only a write to such a fact moves. On a
 * node whose queues, publishers and catalog lane keep writing, the node-wide
 * authority revision moves in every window. That must not fail a share, and a
 * key or route change in any window, the last one included, must.
 */
describe('recipient stability loop under sustained authority churn (GH#3067)', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  type ChurnTransport =
    | { kind: 'private-roster'; participantAgents: readonly string[] }
    | { kind: 'legacy-unregistered' }
    | { kind: 'approved-private-replica'; allowedPeers: string[] }
    | { kind: 'unavailable'; reason: string };

  /** The decorated store and projection exactly as the agent wires them. */
  function createChurnStack() {
    const innerStore = new OxigraphStore();
    stores.push(innerStore);
    let projection!: ContextGraphMetaProjection;
    const store = createListContextGraphsCacheInvalidatingStore(
      innerStore,
      () => undefined,
      createProjectionMutationObserver(() => projection),
    );
    projection = new ContextGraphMetaProjection(store);
    return { store, innerStore, projection };
  }
  type ChurnStack = ReturnType<typeof createChurnStack>;

  interface ChurnContext {
    readonly stack: ChurnStack;
    readonly store: ChurnStack['store'];
    readonly member: ethers.HDNodeWallet;
    readonly memberUri: string;
    readonly memberKey: ReturnType<typeof signedKeyFixture>;
    readonly peerId: string;
    readonly other: ethers.HDNodeWallet;
    readonly otherPeerId: string;
    readonly state: {
      roster: string[];
      allowedPeers: string[] | null;
      transport: ChurnTransport | null;
    };
  }

  /** A key fact of an agent outside the roster: moves the key and route revision, changes nothing resolved. */
  const bystanderRoute = (): Quad => ({
    subject: `did:dkg:agent:${ethers.Wallet.createRandom().address}`,
    predicate: DKG_ONTOLOGY.DKG_PEER_ID,
    object: '"12D3KooWChurnBystander"',
    graph: PROFILE_GRAPH,
  });

  let bookkeeping = 0;
  /**
   * What a busy node writes while a share resolves its recipients: queue job
   * transitions, share and knowledge-asset metadata, and working-memory
   * cleanup. Each one moves the node-wide revision; none can change a key.
   */
  async function unrelatedWrites({ store }: ChurnStack): Promise<void> {
    bookkeeping += 1;
    const job = `urn:dkg:promote-queue:job:churn-${bookkeeping}`;
    const wmGraph = `${contextGraphDataUri(CONTEXT_GRAPH_ID)}/_working_memory/churn-${bookkeeping}`;
    await store.replaceSubject!('urn:dkg:promote-queue:control-plane', job, [{
      subject: job,
      predicate: 'urn:dkg:promote-queue:state',
      object: `"running-${bookkeeping}"`,
      graph: 'urn:dkg:promote-queue:control-plane',
    }]);
    await store.deleteByPatternWithoutCount!({
      graph: 'urn:dkg:promote-queue:control-plane',
      subject: job,
      predicate: 'urn:dkg:promote-queue:state',
    });
    await store.deleteByPatternWithoutCount!({
      graph: `${contextGraphDataUri(CONTEXT_GRAPH_ID)}/_shared_memory_meta`,
      subject: `urn:dkg:share:churn-${bookkeeping}`,
    });
    await store.deleteByPatternWithoutCount!({
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      subject: `did:dkg:base:84532/0x1234567890123456789012345678901234567890/${bookkeeping}`,
    });
    await store.replaceGraph!(wmGraph, [{
      subject: `urn:dkg:churn:doc-${bookkeeping}`,
      predicate: 'urn:dkg:churn:predicate',
      object: '"x"',
      graph: wmGraph,
    }]);
    await store.dropGraph(wmGraph);
  }

  /**
   * A private-roster graph of two members. Read 1 of the transport classifies
   * the graph, read 2 is the confirmation after the first collect, read 3 after
   * the second and read 4 after the third, the last. `unrelated` runs the writes
   * above during every read after the first; `churn` names the reads during
   * which a key fact of an agent outside the roster is written, which moves the
   * key and route revision but cannot change the resolved set;
   * `during(read, context)` applies one real change at a chosen read.
   */
  function churningHost(options: {
    seed: (context: ChurnContext) => Quad[];
    allowedPeers?: 'both' | null;
    unrelated?: boolean;
    churn?: readonly number[];
    during?: (read: number, context: ChurnContext) => Promise<unknown> | void;
    transport?: ChurnTransport;
    withStack?: ChurnStack;
  }) {
    const member = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const peerId = '12D3KooWChurnMemberPeer';
    const otherPeerId = '12D3KooWChurnOtherPeer';
    const stack = options.withStack ?? createChurnStack();
    const state: ChurnContext['state'] = {
      roster: [member.address, other.address],
      allowedPeers: options.allowedPeers === null ? null : [peerId, otherPeerId],
      transport: options.transport ?? null,
    };
    const context: ChurnContext = {
      stack,
      store: stack.store,
      member,
      memberUri: `did:dkg:agent:${ethers.getAddress(member.address)}`,
      memberKey: signedKeyFixture(member, peerId),
      peerId,
      other,
      otherPeerId,
      state,
    };
    let reads = 0;
    const host = {
      store: stack.store,
      contextGraphMetaProjection: stack.projection,
      resolveSwmTransportAuthority: vi.fn(async (): Promise<ChurnTransport> => {
        reads += 1;
        if (reads > 1 && options.unrelated) await unrelatedWrites(stack);
        if (options.churn?.includes(reads)) await stack.store.insert([bystanderRoute()]);
        await options.during?.(reads, context);
        return state.transport ?? { kind: 'private-roster', participantAgents: [...state.roster] };
      }),
      getContextGraphAllowedPeers: vi.fn(async () => (
        state.allowedPeers === null ? null : [...state.allowedPeers]
      )),
      ensureAgentsInOnDemandPhonebook: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
    const ready = stack.store.insert(options.seed(context));
    return { host, context, ready, projection: stack.projection };
  }

  const resolve = (host: unknown) => WorkspaceCryptoMethods.prototype
    .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(host as never, {
      contextGraphId: CONTEXT_GRAPH_ID,
    });

  const profileKeys = (context: ChurnContext): Quad[] => [
    ...context.memberKey.quads,
    ...signedKeyQuads(context.other, context.otherPeerId),
  ];

  const revokeMemberKey = ({ store, member, memberUri, memberKey }: ChurnContext) => {
    const revokedAt = new Date().toISOString();
    const proof = member.signingKey.sign(ethers.hashMessage(
      computeWorkspaceAgentEncryptionKeyRevocationPayload({
        agentAddress: member.address,
        encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        publicKeyBytes: memberKey.publicKeyBytes,
        revokedAt,
      }),
    )).serialized;
    return store.insert([
      [DKG_ONTOLOGY.DKG_REVOKED_AT, `"${revokedAt}"`],
      [DKG_ONTOLOGY.DKG_REVOKED_BY, memberUri],
      [DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF, `"${proof}"`],
    ].map(([predicate, object]) => ({
      subject: memberKey.recipientKeyId,
      predicate,
      object,
      graph: PROFILE_GRAPH,
    })));
  };

  /** The member's key lives in the join key cache and the peer gate is open. */
  const joinCacheKeys = ({ memberKey, other, otherPeerId }: ChurnContext): Quad[] => [
    ...memberKey.quads.map((quad) => ({ ...quad, graph: JOIN_KEY_CACHE_GRAPH })),
    ...signedKeyQuads(other, otherPeerId),
  ];

  const replaceMemberRoute = ({ store, memberKey, memberUri }: ChurnContext) => store.replaceSubject!(
    JOIN_KEY_CACHE_GRAPH,
    memberUri,
    memberKey.quads.map((quad) => ({
      ...quad,
      graph: JOIN_KEY_CACHE_GRAPH,
      ...(quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID
        ? { object: '"12D3KooWChurnReplacedRoute"' }
        : {}),
    })),
  );

  const expectRecipients = (resolution: Awaited<ReturnType<typeof resolve>>, count: number) => {
    expect(resolution.requiresEncryption).toBe(true);
    expect(resolution.recipients).toHaveLength(count);
  };

  const REVISION_MOVED = { ...TRANSPORT_CHANGED, site: 'revision-moved' };

  const allowedPeerQuad = (peerId: string): Quad => ({
    subject: contextGraphDataUri(CONTEXT_GRAPH_ID),
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
    object: `"${peerId}"`,
    graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
  });

  /** The peer gate changes: the host's lookup answers differently and the store holds the new fact, as in the agent. */
  const changeGate = async ({ state, store }: ChurnContext, peers: string[]) => {
    state.allowedPeers = peers;
    await store.insert(peers.map(allowedPeerQuad));
  };

  it('resolves in the first window while unrelated writes move the node-wide revision in every read', async () => {
    const { host, ready, projection } = churningHost({ seed: profileKeys, unrelated: true });
    await ready;
    const nodeWide = projection.readAuthorityFactsRevision;
    const keyRoute = projection.recipientKeyRouteFence.revision;
    const peerGate = projection.peerGateRevision.read(CONTEXT_GRAPH_ID);

    expectRecipients(await resolve(host), 2);

    // The classification read and the confirmation of the one collect.
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(1);
    expect(projection.readAuthorityFactsRevision).toBeGreaterThan(nodeWide);
    expect(projection.recipientKeyRouteFence.revision).toBe(keyRoute);
    expect(projection.peerGateRevision.read(CONTEXT_GRAPH_ID)).toBe(peerGate);
  });

  it('keeps the quiet path at two authority reads and one collect', async () => {
    const { host, ready } = churningHost({ seed: profileKeys });
    await ready;

    expectRecipients(await resolve(host), 2);
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(1);
  });

  it('names the throw site of an authority that is unavailable at the first read', async () => {
    const { host, ready } = churningHost({
      seed: profileKeys,
      transport: { kind: 'unavailable', reason: 'chain-name-binding-unavailable' },
    });
    await ready;

    await expect(resolve(host)).rejects.toMatchObject({
      reason: 'chain-name-binding-unavailable',
      site: 'transport-unavailable',
    });
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(1);
  });

  it('collects again, and again learns the key graphs, when a key fact is written during a window', async () => {
    const { host, ready, projection } = churningHost({ seed: profileKeys, churn: [2] });
    await ready;
    const ensureReady = vi.spyOn(projection.recipientKeyRouteFence, 'ensureReady');

    expectRecipients(await resolve(host), 2);

    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(3);
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(2);
    expect(ensureReady).toHaveBeenCalledTimes(2);
  });

  // A change lands during read N. Reads 2 and 3 are followed by a collect that
  // reads it. Read 4 follows the last collect: only the snapshot's own check
  // can see it, and it must.
  interface WindowChange {
    readonly change: string;
    readonly seed: (context: ChurnContext) => Quad[];
    readonly allowedPeers?: 'both' | null;
    readonly apply: (context: ChurnContext) => Promise<unknown> | void;
    /** What a collect that reads the change refuses with. */
    readonly early: RegExp | { reason: string; detail: string; site: string };
  }

  const windowChanges: WindowChange[] = [
    {
      change: 'a recipient key is revoked',
      seed: profileKeys,
      apply: revokeMemberKey,
      early: /public encryption keys.*revoked/,
    },
    {
      change: 'a peer route is replaced in the join key cache',
      seed: joinCacheKeys,
      allowedPeers: null,
      apply: replaceMemberRoute,
      early: { ...ROUTES_CHANGED, site: 'recipient-set-changed' },
    },
    {
      change: 'a peer leaves the allowlist',
      seed: profileKeys,
      apply: (context) => changeGate(context, [context.peerId]),
      early: /has no recipient key advertised by a peer in the context graph allowlist/,
    },
    {
      // Same length, different members.
      change: 'a peer is swapped in the allowlist',
      seed: profileKeys,
      apply: (context) => changeGate(context, [context.peerId, '12D3KooWChurnSwappedPeer']),
      early: /has no recipient key advertised by a peer in the context graph allowlist/,
    },
    {
      change: 'the graph gains a peer allowlist',
      seed: joinCacheKeys,
      allowedPeers: null,
      apply: (context) => changeGate(context, [context.peerId]),
      early: /has no recipient key advertised by a peer in the context graph allowlist/,
    },
  ];

  it.each(windowChanges.flatMap((scenario) => [2, 3].map((read) => ({ ...scenario, read }))))(
    'fails closed when $change during authority read $read',
    async (scenario) => {
      const { host, ready } = churningHost({
        seed: scenario.seed,
        allowedPeers: scenario.allowedPeers,
        // Read 3 only happens when the first window moved.
        churn: scenario.read === 3 ? [2] : [],
        during: (read, context) => (read === scenario.read ? scenario.apply(context) : undefined),
      });
      await ready;

      await (scenario.early instanceof RegExp
        ? expect(resolve(host)).rejects.toThrow(scenario.early)
        : expect(resolve(host)).rejects.toMatchObject(scenario.early));
    },
  );

  it.each(windowChanges)('refuses in the last window when $change after the last collect', async (scenario) => {
    const { host, ready } = churningHost({
      seed: scenario.seed,
      allowedPeers: scenario.allowedPeers,
      // Reads 2 and 3 move the key revision without changing the set, so the
      // loop reaches its last window; the change lands during read 4.
      churn: [2, 3],
      during: (read, context) => (read === 4 ? scenario.apply(context) : undefined),
    });
    await ready;

    await expect(resolve(host)).rejects.toMatchObject(REVISION_MOVED);
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
  });

  it('never returns the revoked key when it is revoked while the last window is read', async () => {
    const { host, ready, context } = churningHost({
      seed: profileKeys,
      churn: [2, 3],
      during: (read, ctx) => (read === 4 ? revokeMemberKey(ctx) : undefined),
    });
    await ready;
    const encrypt = vi.fn();

    await expect(resolve(host).then(encrypt)).rejects.toMatchObject(REVISION_MOVED);
    expect(encrypt).not.toHaveBeenCalled();
    expect(context.state.roster).toHaveLength(2);
  });

  it.each([
    {
      change: 'a member leaves the roster',
      apply: ({ state, member }: ChurnContext) => { state.roster = [member.address]; },
      rejects: { ...TRANSPORT_CHANGED, site: 'transport-changed' },
    },
    {
      change: 'a member joins the roster',
      apply: ({ state }: ChurnContext) => { state.roster.push(ethers.Wallet.createRandom().address); },
      rejects: { ...TRANSPORT_CHANGED, site: 'transport-changed' },
    },
    {
      change: 'the graph stops being a private roster',
      apply: ({ state }: ChurnContext) => { state.transport = { kind: 'legacy-unregistered' }; },
      rejects: { ...TRANSPORT_CHANGED, site: 'transport-changed' },
    },
    {
      change: 'the graph becomes an approved private replica',
      apply: ({ state }: ChurnContext) => {
        state.transport = { kind: 'approved-private-replica', allowedPeers: [] };
      },
      rejects: { ...TRANSPORT_CHANGED, site: 'transport-changed' },
    },
    {
      change: 'its authority becomes unavailable',
      apply: ({ state }: ChurnContext) => {
        state.transport = { kind: 'unavailable', reason: 'chain-name-binding-unavailable' };
      },
      rejects: { reason: 'chain-name-binding-unavailable', site: 'transport-unavailable' },
    },
  ])('fails closed in the last window when $change', async (scenario) => {
    const { host, ready } = churningHost({
      seed: profileKeys,
      churn: [2, 3],
      during: (read, context) => (read === 4 ? scenario.apply(context) : undefined),
    });
    await ready;

    await expect(resolve(host)).rejects.toMatchObject(scenario.rejects);
  });

  it('refuses once the key revision has moved in every window, after exactly three collects', async () => {
    const { host, ready } = churningHost({ seed: profileKeys, churn: [2, 3, 4] });
    await ready;

    await expect(resolve(host)).rejects.toMatchObject(REVISION_MOVED);
    // Never a fourth collect: three collects, each followed by its confirmation.
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(3);
  });

  it('keeps legacy unregistered authority strict when the node-wide revision moves in every window', async () => {
    const { host, ready } = churningHost({
      seed: () => [],
      transport: { kind: 'legacy-unregistered' },
      unrelated: true,
    });
    await ready;

    await expect(resolve(host)).rejects.toMatchObject(REVISION_MOVED);
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
  });

  it('keeps an approved private replica strict when the node-wide revision moves in every window', async () => {
    const owner = ethers.Wallet.createRandom();
    const { host, ready } = churningHost({
      seed: () => [
        ...signedKeyQuads(owner),
        {
          subject: contextGraphDataUri(CONTEXT_GRAPH_ID),
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${owner.address}"`,
          graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
        },
      ],
      transport: { kind: 'approved-private-replica', allowedPeers: [] },
      unrelated: true,
    });
    await ready;

    await expect(resolve(host)).rejects.toMatchObject(REVISION_MOVED);
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(4);
  });

  it('stays fail-closed when the key graphs cannot be scanned, and converges once the writes stop', async () => {
    const stack = createChurnStack();
    const query = stack.innerStore.query.bind(stack.innerStore);
    vi.spyOn(stack.innerStore, 'query').mockImplementation(async (sparql, options) => {
      if (options?.source === 'agent.recipientKeyRouteFence.scan') throw new Error('store busy');
      return query(sparql, options);
    });
    let wildcard = 0;
    const { host, ready } = churningHost({
      seed: profileKeys,
      withStack: stack,
      // A drop of a graph nobody knows to be key-free is not harmless while the scan is unavailable.
      during: async (read) => {
        if (read === 2) await stack.store.dropGraph(`${contextGraphDataUri(CONTEXT_GRAPH_ID)}/_working_memory/wildcard-${wildcard += 1}`);
      },
    });
    await ready;

    expectRecipients(await resolve(host), 2);
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(3);
  });

  it('lets the VM publish key context resolve its recipients while unrelated writes move the node-wide revision', async () => {
    // `_resolveCuratedChainKeyContext` runs the same resolver, twice per
    // publish attempt, with no bounded repeat. The sender is deliberately not
    // a member, so a successful resolution ends in the recipient-set check
    // that follows it.
    const { host, ready } = churningHost({ seed: profileKeys, unrelated: true });
    await ready;
    const outsider = ethers.Wallet.createRandom();
    const agentLike = Object.assign(host, {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      defaultAgentAddress: outsider.address,
      peerId: '12D3KooWChurnPublisherPeer',
      resolveOnChainAccessPolicyState: vi.fn(async () => 1),
      isPrivateContextGraph: vi.fn(async () => true),
      loadSwmSenderKeyState: vi.fn(async () => undefined),
      getLocalSigningAgentForAddress: vi.fn((address: string) => ({ agentAddress: address })),
      resolveWorkspaceAgentRecipientsForCurrentAuthority: WorkspaceCryptoMethods.prototype
        .resolveWorkspaceAgentRecipientsForCurrentAuthority,
    });

    await expect(PublishMethods.prototype._resolveCuratedChainKeyContext.call(
      agentLike as never,
      CONTEXT_GRAPH_ID,
      undefined,
      undefined,
      undefined,
      'churn',
    )).rejects.toThrow(/is not in the recipient set/);
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
  });

  it('does not move the node-wide revision for a plain insert into an unrelated graph', async () => {
    const real = createChurnStack();
    const before = real.projection.readAuthorityFactsRevision;
    await real.store.insert([{
      subject: 'urn:dkg:churn:unrelated',
      predicate: 'urn:dkg:churn:predicate',
      object: '"x"',
      graph: 'urn:dkg:churn:graph',
    }]);
    expect(real.projection.readAuthorityFactsRevision).toBe(before);
  });

  it('lets four concurrent resolutions succeed while a real promote queue churns the store', async () => {
    const real = createChurnStack();
    const queue = new TripleStoreAsyncPromoteQueue(real.store, {});
    let transition = 0;
    const jobsAreDriven = async () => {
      // One real job lifecycle: the control-plane writes of enqueue, claim,
      // commit markers and success, through the decorated store.
      transition += 1;
      await queue.enqueue({
        contextGraphId: 'graphify',
        subGraphName: 'code',
        assertionName: `churn-${transition}`,
        entities: 'all',
      });
      const claimed = await queue.claimNext(`worker-${transition}`);
      if (claimed?.lease === undefined) return;
      const token = claimed.lease.claimToken;
      await queue.recordCommitMarker(claimed.jobId, token, 'swmInserted');
      await queue.succeed(claimed.jobId, token, { promotedCount: 1, succeededAt: Date.now() });
    };
    const hosts = Array.from({ length: 4 }, () => churningHost({
      seed: () => [],
      withStack: real,
      during: (read) => (read >= 2 ? jobsAreDriven() : undefined),
    }));
    // All four hosts share one store; give them the same two members' keys.
    const member = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    await real.store.insert([
      ...signedKeyQuads(member, '12D3KooWChurnSharedMemberPeer'),
      ...signedKeyQuads(other, '12D3KooWChurnSharedOtherPeer'),
    ]);
    for (const { context } of hosts) {
      context.state.roster = [member.address, other.address];
      context.state.allowedPeers = ['12D3KooWChurnSharedMemberPeer', '12D3KooWChurnSharedOtherPeer'];
    }
    const nodeWide = real.projection.readAuthorityFactsRevision;
    const keyRoute = real.projection.recipientKeyRouteFence.revision;

    const resolutions = await Promise.all(hosts.map(({ host }) => resolve(host)));

    for (const resolution of resolutions) expectRecipients(resolution, 2);
    for (const { host } of hosts) {
      expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    }
    expect(real.projection.readAuthorityFactsRevision).toBeGreaterThan(nodeWide);
    expect(real.projection.recipientKeyRouteFence.revision).toBe(keyRoute);
  });
  it('refuses a member the roster removes while a gate fact is being written, whichever lands last', async () => {
    const { host, ready } = churningHost({
      seed: profileKeys,
      // Reads 2 and 3 move the key revision so that the last window is reached; during
      // the last roster read a gate fact is written and the roster loses a member.
      churn: [2, 3],
      during: async (read, context) => {
        if (read !== 4) return;
        await changeGate(context, [context.peerId, context.otherPeerId]);
        context.state.roster = [context.member.address];
      },
    });
    await ready;

    await expect(resolve(host)).rejects.toMatchObject({ ...TRANSPORT_CHANGED, site: 'transport-changed' });
  });

  it('checks the peer gate by revision right after the last roster read, with no read of the gate in between', async () => {
    const { host, ready } = churningHost({ seed: profileKeys });
    await ready;

    expectRecipients(await resolve(host), 2);
    // The gate is read once, to collect; nothing awaits between the roster read and the verdict.
    expect(host.getContextGraphAllowedPeers).toHaveBeenCalledTimes(1);
    expect(host.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
  });

});
