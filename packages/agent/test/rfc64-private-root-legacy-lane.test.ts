// SPDX-License-Identifier: Apache-2.0
//
// #2858: a private graph's root-scope SWM keeps the legacy member lane while
// its RFC-64 authority is not active. RFC-64 closed that lane for every
// catalog-mode graph, and on a node without private catalog authority the
// replacement never activates, so members lost the curator's root writes and
// every later update. Public graphs, explicit RFC-64 selections and an active
// RFC-64 authority keep their RFC-64 behaviour.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { encodeRootlessWorkspaceRequest, rootlessSharedMemoryGraphFromWire } from
  '../../publisher/test/_helpers/rootless-workspace.js';

const PRIVATE_CG = 'rfc64-private-root-legacy-lane';
const PEER = '12D3KooWRfc64PrivateRootLanePeer';

type TransportState = 'catalog-blocked' | 'catalog-active';

interface Internals {
  config: DKGAgent['config'];
  wireIdToLocalCgId: Map<string, string>;
  contextGraphNameCommitment(contextGraphId: string): string;
  rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId: string): boolean;
  rfc64PrivateRootSwmOnLegacyLaneV1(contextGraphId: string): Promise<boolean>;
  getCgMeta(contextGraphId: string): Promise<Record<string, unknown>>;
  listLocalAgents(): Array<{ agentAddress: string }>;
  defaultAgentAddress?: string;
  resolveRfc64CatalogReceiverAuthorityV1(contextGraphId: string): unknown;
  resolveRfc64AcceptedCompatibilityAuthorityV1(contextGraphId: string): unknown;
  resolveAcceptedRfc64SharedMemoryAuthorityV1(contextGraphId: string): boolean | undefined;
  getExplicitAccessPolicy(contextGraphId: string): Promise<'private' | 'public' | null>;
  resolveSwmTransportAuthority(contextGraphId: string, options: unknown): Promise<unknown>;
  hasConfirmedSharedMemoryMetaState(contextGraphId: string): Promise<boolean>;
  canReadContextGraph(contextGraphId: string, options: unknown): Promise<boolean>;
  canUseSharedMemoryForContextGraph(contextGraphId: string): Promise<boolean>;
  createSwmTargetExecutorSessionV1(): unknown;
  runContextGraphSyncWithBackpressure(...args: unknown[]): Promise<unknown>;
  recoverContextGraphSwmFromPeer(peerId: string, contextGraphId: string): Promise<unknown>;
  getOrCreateSharedMemoryHandler(): {
    handle(data: Uint8Array, from: string): Promise<{ applied: boolean; reason?: string }>;
  };
  store: { hasGraph(graph: string): Promise<boolean> };
}

function receiverAuthority(state: TransportState) {
  return {
    contextGraphId: PRIVATE_CG,
    selected: false,
    eligible: true,
    active: state === 'catalog-active',
    mode: 'catalog',
    killSwitchActive: false,
    legacySyncAllowed: false,
    track2Enabled: true,
    authoringAllowed: true,
    reconciliationLane: 'catalog-apply',
  };
}

describe('private root SWM on the legacy member lane (#2858)', () => {
  let agent: DKGAgent;
  let internals: Internals;
  let defaultPlan: DKGAgent['config']['rfc64CatalogExecutionPlan'];

  beforeAll(async () => {
    agent = await DKGAgent.create({
      name: 'Rfc64PrivateRootLegacyLane',
      chainAdapter: new MockChainAdapter(),
    });
    internals = agent as unknown as Internals;
    defaultPlan = internals.config.rfc64CatalogExecutionPlan;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    internals.config.rfc64CatalogExecutionPlan = defaultPlan;
  });

  afterAll(async () => {
    try { await agent.stop(); } catch { /* not started */ }
  });

  const LOCAL = '0x1111111111111111111111111111111111111111';
  const OTHER = '0x2222222222222222222222222222222222222222';

  function meta(overrides: Record<string, unknown> = {}) {
    return {
      accessPolicy: 'private',
      allowedAgents: [OTHER, LOCAL],
      participantAgents: [],
      curators: [],
      creators: [],
      revokedAgents: [],
      ...overrides,
    };
  }

  function stubAuthority(options: {
    legacyAllowed?: boolean;
    state?: TransportState;
    meta?: Record<string, unknown>;
  }) {
    vi.spyOn(internals, 'rfc64LegacySwmGossipAllowedForContextGraph')
      .mockReturnValue(options.legacyAllowed ?? false);
    vi.spyOn(internals, 'resolveRfc64AcceptedCompatibilityAuthorityV1').mockReturnValue(null);
    vi.spyOn(internals, 'resolveRfc64CatalogReceiverAuthorityV1')
      .mockReturnValue(receiverAuthority(options.state ?? 'catalog-blocked'));
    vi.spyOn(internals, 'getCgMeta').mockResolvedValue(options.meta ?? meta());
    vi.spyOn(internals, 'listLocalAgents').mockReturnValue([{ agentAddress: LOCAL }]);
    return {
      transport: vi.spyOn(internals, 'resolveSwmTransportAuthority'),
    };
  }

  it.each([
    ['an allowlisted member of a private graph whose RFC-64 authority is blocked', {}, true],
    ['a participant member', { meta: meta({ allowedAgents: [], participantAgents: [LOCAL] }) }, true],
    ['the curator named by DID', {
      meta: meta({ allowedAgents: [OTHER], curators: [`did:dkg:agent:${LOCAL.toUpperCase().replace('0X', '0x')}`] }),
    }, true],
    ['a revoked member', { meta: meta({ revokedAgents: [LOCAL] }) }, false],
    ['a node that is not a member', { meta: meta({ allowedAgents: [OTHER] }) }, false],
    ['a graph declared public', { meta: meta({ accessPolicy: 'public' }) }, false],
    ['a graph with no explicit policy', { meta: meta({ accessPolicy: undefined }) }, false],
    ['a member whose RFC-64 authority is active on a node without private authority', {
      state: 'catalog-active',
    }, true],
    ['a node where legacy SWM is already allowed', { legacyAllowed: true }, false],
  ] as const)('decides the lane for %s', async (_label, options, expected) => {
    const reads = stubAuthority(options as never);
    await expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).resolves.toBe(expected);
    // No chain read: membership comes from the node's own metadata.
    expect(reads.transport).not.toHaveBeenCalled();
  });

  it('leaves an active RFC-64 authority to deliver on a node with private access-policy authority', async () => {
    stubAuthority({ state: 'catalog-active' });
    const configured = internals.config.rfc64CatalogAccessPolicyAuthority;
    internals.config.rfc64CatalogAccessPolicyAuthority = { localAgentAddress: LOCAL } as never;
    try {
      await expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).resolves.toBe(false);
      expect(internals.getCgMeta).not.toHaveBeenCalled();
    } finally {
      internals.config.rfc64CatalogAccessPolicyAuthority = configured;
    }
    // A blocked authority keeps the member lane even there: nothing else delivers.
    vi.mocked(internals.resolveRfc64CatalogReceiverAuthorityV1)
      .mockReturnValue(receiverAuthority('catalog-blocked'));
    internals.config.rfc64CatalogAccessPolicyAuthority = { localAgentAddress: LOCAL } as never;
    try {
      await expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).resolves.toBe(true);
    } finally {
      internals.config.rfc64CatalogAccessPolicyAuthority = configured;
    }
  });

  it('leaves explicitly selected and accepted RFC-64 graphs on RFC-64', async () => {
    stubAuthority({});
    internals.config.rfc64CatalogExecutionPlan = {
      ...defaultPlan,
      selectedAuthority: {
        [PRIVATE_CG]: receiverAuthority('catalog-blocked'),
      } as never,
    };
    await expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).resolves.toBe(false);
    internals.config.rfc64CatalogExecutionPlan = defaultPlan;

    const bootstrap = internals.config.rfc64CatalogBootstrap;
    internals.config.rfc64CatalogBootstrap = {
      acceptedPolicies: [{ policyEnvelope: { payload: { contextGraphId: PRIVATE_CG } } }],
    } as never;
    try {
      await expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).resolves.toBe(false);
    } finally {
      internals.config.rfc64CatalogBootstrap = bootstrap;
    }

    vi.mocked(internals.resolveRfc64AcceptedCompatibilityAuthorityV1)
      .mockReturnValue(receiverAuthority('catalog-blocked'));
    await expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).resolves.toBe(false);
    expect(internals.getCgMeta).not.toHaveBeenCalled();
  });

  it('maps a bound wire id to its graph and refuses an unbound one', async () => {
    stubAuthority({});
    const wire = internals.contextGraphNameCommitment(PRIVATE_CG);
    internals.wireIdToLocalCgId.delete(wire);
    await expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(wire)).resolves.toBe(false);
    internals.wireIdToLocalCgId.set(wire, PRIVATE_CG);
    try {
      await expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(wire)).resolves.toBe(true);
      expect(internals.getCgMeta).toHaveBeenCalledWith(PRIVATE_CG);
    } finally {
      internals.wireIdToLocalCgId.delete(wire);
    }
  });

  it('wires the member lane into the SHARE apply gate for root scope only', async () => {
    const handler = internals.getOrCreateSharedMemoryHandler();
    const gate = handler as unknown as {
      legacyApplyAllowedOracle(contextGraphId: string, subGraphName: string | null): boolean | Promise<boolean>;
    };
    const wire = internals.contextGraphNameCommitment(PRIVATE_CG);
    internals.wireIdToLocalCgId.set(wire, PRIVATE_CG);
    const share = (index: number) => encodeRootlessWorkspaceRequest({
      contextGraphId: wire,
      nquads: new TextEncoder().encode(
        `<urn:test:private-root-lane:${index}> <http://schema.org/name> "Root write" `
          + `<${contextGraphDataUri(wire)}> .`,
      ),
      publisherPeerId: PEER,
      shareOperationId: `private-root-lane-${index}`,
      timestampMs: Date.now(),
    });
    try {
      // The handler applies a signed, encrypted member share once this gate
      // admits it (workspace-handler-private-root-legacy-lane.test.ts in the
      // publisher); the member's own checks still run after it.
      stubAuthority({});
      await expect(Promise.resolve(gate.legacyApplyAllowedOracle(wire, null))).resolves.toBe(true);

      vi.restoreAllMocks();
      stubAuthority({ meta: meta({ accessPolicy: 'public' }) });
      await expect(Promise.resolve(gate.legacyApplyAllowedOracle(wire, null))).resolves.toBe(false);
      const publicShare = share(1);
      await expect(handler.handle(publicShare, PEER)).resolves.toMatchObject({
        applied: false,
        reason: expect.stringContaining('not authoritative'),
      });
      await expect(internals.store.hasGraph(rootlessSharedMemoryGraphFromWire(publicShare)))
        .resolves.toBe(false);
    } finally {
      internals.wireIdToLocalCgId.delete(wire);
    }
  });

  it('admits SWM for a member of a blocked private graph through the legacy checks', async () => {
    vi.spyOn(internals, 'resolveAcceptedRfc64SharedMemoryAuthorityV1').mockReturnValue(false);
    const lane = vi.spyOn(internals, 'rfc64PrivateRootSwmOnLegacyLaneV1').mockResolvedValue(true);
    vi.spyOn(internals, 'hasConfirmedSharedMemoryMetaState').mockResolvedValue(true);
    const canRead = vi.spyOn(internals, 'canReadContextGraph').mockResolvedValue(true);
    await expect(internals.canUseSharedMemoryForContextGraph(PRIVATE_CG)).resolves.toBe(true);
    expect(canRead).toHaveBeenCalledTimes(1);

    // A non-member still fails the legacy read check.
    canRead.mockResolvedValue(false);
    await expect(internals.canUseSharedMemoryForContextGraph(PRIVATE_CG)).resolves.toBe(false);

    // A refusal that is not a blocked private graph stands without a read.
    lane.mockResolvedValue(false);
    canRead.mockClear();
    await expect(internals.canUseSharedMemoryForContextGraph(PRIVATE_CG)).resolves.toBe(false);
    expect(canRead).not.toHaveBeenCalled();

    // An accepted RFC-64 admission needs neither.
    vi.mocked(internals.resolveAcceptedRfc64SharedMemoryAuthorityV1).mockReturnValue(true);
    lane.mockClear();
    await expect(internals.canUseSharedMemoryForContextGraph(PRIVATE_CG)).resolves.toBe(true);
    expect(lane).not.toHaveBeenCalled();
  });

  it.each([
    [true, true],
    [false, false],
  ])('recovers the root scope of a blocked private graph: lane=%s', async (onLane, rootScope) => {
    vi.spyOn(internals, 'resolveRfc64CatalogReceiverAuthorityV1')
      .mockReturnValue(receiverAuthority('catalog-blocked'));
    vi.spyOn(internals, 'rfc64PrivateRootSwmOnLegacyLaneV1').mockResolvedValue(onLane);
    const recoverPrivateTarget = vi.fn(async (_input: { includeRootScope: boolean }) => ({}));
    vi.spyOn(internals, 'createSwmTargetExecutorSessionV1')
      .mockReturnValue({ recoverPrivateTarget });
    vi.spyOn(internals, 'runContextGraphSyncWithBackpressure').mockImplementation(
      async (...args: unknown[]) => (args[4] as () => Promise<unknown>)(),
    );

    await internals.recoverContextGraphSwmFromPeer(PEER, PRIVATE_CG);

    expect(recoverPrivateTarget).toHaveBeenCalledTimes(1);
    expect(recoverPrivateTarget.mock.calls[0]![0]).toMatchObject({ includeRootScope: rootScope });
  });
});
