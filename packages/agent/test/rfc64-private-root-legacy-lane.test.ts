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
import { encodeRootlessWorkspaceRequest } from
  '../../publisher/test/_helpers/rootless-workspace.js';

const PRIVATE_CG = 'rfc64-private-root-legacy-lane';
const PEER = '12D3KooWRfc64PrivateRootLanePeer';

type TransportState = 'catalog-blocked' | 'catalog-active';
type Responsibility = 'private-membership' | 'core-public' | 'edge-subscription' | null;

interface Internals {
  config: DKGAgent['config'];
  wireIdToLocalCgId: Map<string, string>;
  contextGraphNameCommitment(contextGraphId: string): string;
  rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId: string): boolean;
  rfc64PrivateRootSwmOnLegacyLaneV1(contextGraphId: string): boolean;
  readRfc64CatalogResponsibilityV1(contextGraphId: string): unknown;
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

  function stubAuthority(options: {
    legacyAllowed?: boolean;
    state?: TransportState;
    responsibility?: Responsibility;
  }) {
    vi.spyOn(internals, 'rfc64LegacySwmGossipAllowedForContextGraph')
      .mockReturnValue(options.legacyAllowed ?? false);
    vi.spyOn(internals, 'resolveRfc64AcceptedCompatibilityAuthorityV1').mockReturnValue(null);
    vi.spyOn(internals, 'resolveRfc64CatalogReceiverAuthorityV1')
      .mockReturnValue(receiverAuthority(options.state ?? 'catalog-blocked'));
    vi.spyOn(internals, 'readRfc64CatalogResponsibilityV1').mockReturnValue({
      contextGraphId: PRIVATE_CG,
      responsibilityReason: options.responsibility === undefined
        ? 'private-membership'
        : options.responsibility,
    });
    return {
      policy: vi.spyOn(internals, 'getExplicitAccessPolicy'),
      transport: vi.spyOn(internals, 'resolveSwmTransportAuthority'),
    };
  }

  it.each([
    ['a verified private member whose RFC-64 authority is blocked', {}, true],
    ['a Core holding a public graph', { responsibility: 'core-public' }, false],
    ['an Edge subscription to a public graph', { responsibility: 'edge-subscription' }, false],
    ['a graph the node holds no responsibility for', { responsibility: null }, false],
    ['a private member whose RFC-64 authority is active', { state: 'catalog-active' }, false],
    ['a node where legacy SWM is already allowed', { legacyAllowed: true }, false],
  ] as const)('decides the lane for %s', (_label, options, expected) => {
    const reads = stubAuthority(options);
    expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).toBe(expected);
    // Hot share and sync paths: the decision reads neither the store nor the chain.
    expect(reads.policy).not.toHaveBeenCalled();
    expect(reads.transport).not.toHaveBeenCalled();
  });

  it('leaves explicitly selected and accepted RFC-64 graphs on RFC-64', () => {
    stubAuthority({});
    internals.config.rfc64CatalogExecutionPlan = {
      ...defaultPlan,
      selectedAuthority: {
        [PRIVATE_CG]: receiverAuthority('catalog-blocked'),
      } as never,
    };
    expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).toBe(false);
    internals.config.rfc64CatalogExecutionPlan = defaultPlan;

    vi.mocked(internals.resolveRfc64AcceptedCompatibilityAuthorityV1)
      .mockReturnValue(receiverAuthority('catalog-active'));
    expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(PRIVATE_CG)).toBe(false);
  });

  it('maps a bound wire id to its graph and refuses an unbound one', () => {
    stubAuthority({});
    const wire = internals.contextGraphNameCommitment(PRIVATE_CG);
    internals.wireIdToLocalCgId.delete(wire);
    expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(wire)).toBe(false);
    internals.wireIdToLocalCgId.set(wire, PRIVATE_CG);
    try {
      expect(internals.rfc64PrivateRootSwmOnLegacyLaneV1(wire)).toBe(true);
      expect(internals.readRfc64CatalogResponsibilityV1).toHaveBeenCalledWith(PRIVATE_CG);
    } finally {
      internals.wireIdToLocalCgId.delete(wire);
    }
  });

  it('applies a root SHARE of a member private graph instead of declining it as catalog-owned', async () => {
    const handler = internals.getOrCreateSharedMemoryHandler();
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
      stubAuthority({});
      const privateOutcome = await handler.handle(share(0), PEER);
      expect(privateOutcome.reason ?? '').not.toContain('not authoritative');

      vi.restoreAllMocks();
      stubAuthority({ responsibility: 'edge-subscription' });
      await expect(handler.handle(share(1), PEER)).resolves.toMatchObject({
        applied: false,
        reason: expect.stringContaining('not authoritative'),
      });
    } finally {
      internals.wireIdToLocalCgId.delete(wire);
    }
  });

  it('admits SWM for a member of a blocked private graph through the legacy checks', async () => {
    vi.spyOn(internals, 'resolveAcceptedRfc64SharedMemoryAuthorityV1').mockReturnValue(false);
    const lane = vi.spyOn(internals, 'rfc64PrivateRootSwmOnLegacyLaneV1').mockReturnValue(true);
    vi.spyOn(internals, 'hasConfirmedSharedMemoryMetaState').mockResolvedValue(true);
    const canRead = vi.spyOn(internals, 'canReadContextGraph').mockResolvedValue(true);
    await expect(internals.canUseSharedMemoryForContextGraph(PRIVATE_CG)).resolves.toBe(true);
    expect(canRead).toHaveBeenCalledTimes(1);

    // A non-member still fails the legacy read check.
    canRead.mockResolvedValue(false);
    await expect(internals.canUseSharedMemoryForContextGraph(PRIVATE_CG)).resolves.toBe(false);

    // A refusal that is not a blocked private graph stands without a read.
    lane.mockReturnValue(false);
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
    vi.spyOn(internals, 'rfc64PrivateRootSwmOnLegacyLaneV1').mockReturnValue(onLane);
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
