// SPDX-License-Identifier: Apache-2.0

import {
  contextGraphWorkspaceGraphUri,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_AUTHOR as AUTHOR,
  RFC64_ROLLOUT_CONTEXT_GRAPH_ID as CONTEXT_GRAPH_ID,
  rfc64RolloutActivation as activation,
  rfc64RolloutPolicyEnvelope as policyEnvelope,
} from './_helpers/rfc64-rollout-agent-harness.js';

const {
  startAgent,
  cleanup,
} = createRfc64RolloutAgentHarness();

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('RFC-64 rollout selected-SWM recovery integration', () => {
  it('keeps selected complete-provider recovery live under catalog authority', async () => {
    const providerPeerId = '12D3KooWCatalogCompleteProvider';
    let connect!: ReturnType<typeof vi.spyOn>;
    let queue!: ReturnType<typeof vi.spyOn>;
    const catalog = await startAgent({
      name: 'catalog-complete-provider',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          retryIntervalMs: 0,
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
      beforeStart: (agent) => {
        connect = vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
        queue = vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
          .mockReturnValue(true);
      },
    });
    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();

    expect(catalog.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs)
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(catalog.getSyncContextGraphIds()).not.toContain(CONTEXT_GRAPH_ID);
    expect(connect).toHaveBeenCalledWith(providerPeerId, { timeoutMs: 10_000 });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'rfc64-authorized-swm-recovery-v1',
        providerPeerId,
        targets: [{ contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' }],
      }),
      expect.any(Function),
      0,
    );
    await expect(catalog.planSharedMemorySyncContextGraphs(
      providerPeerId,
      [CONTEXT_GRAPH_ID],
      createOperationContext('sync'),
    )).resolves.toEqual({ targets: [] });
    await expect(catalog.planSharedMemorySyncContextGraphs(
      providerPeerId,
      [CONTEXT_GRAPH_ID],
      createOperationContext('sync'),
      { requireCompleteProviderMatch: true },
    )).resolves.toEqual({ targets: [] });
    vi.spyOn(catalog, 'resolveRfc64CompleteSwmProviderPeerIdsV1')
      .mockReturnValue([providerPeerId, providerPeerId]);
    expect(catalog.resolveActiveRfc64SwmRecoveryPlanV1(providerPeerId)).toEqual({
      kind: 'rfc64-active-swm-recovery-plan-v1',
      providerPeerId,
      targets: [{ contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' }],
    });
    expect(catalog.getRfc64SelectedSwmGraphSyncStatus(CONTEXT_GRAPH_ID)).toEqual({
      mechanism: 'rfc64-selected-on-connect',
      state: 'continuing',
      configuredProviderCount: 1,
      retryRequiredProviderCount: 1,
      terminalProviderCount: 0,
    });

    const admission = (catalog as any).selectedSwmBootstrapAdmission;
    const terminalOwner = admission.beginTransfer(providerPeerId, [CONTEXT_GRAPH_ID]);
    expect(admission.markTransferTerminal(terminalOwner)).toBe(true);
    queue.mockClear();
    catalog.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(admission.snapshot(providerPeerId)).toBeNull();
    expect(catalog.getRfc64SelectedSwmGraphSyncStatus(CONTEXT_GRAPH_ID)).toEqual({
      mechanism: 'rfc64-selected-on-connect',
      state: 'inactive',
      configuredProviderCount: 0,
      retryRequiredProviderCount: 0,
      terminalProviderCount: 0,
    });

    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(queue).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPeerId,
        targets: [{ contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' }],
      }),
      expect.any(Function),
      0,
    );
    expect(catalog.getRfc64SelectedSwmGraphSyncStatus(CONTEXT_GRAPH_ID)).toMatchObject({
      state: 'continuing',
      configuredProviderCount: 1,
      retryRequiredProviderCount: 1,
    });
  });

  it('closes recovery readiness until a subscription-triggered catalog pass settles', async () => {
    const providerPeerId = '12D3KooWCatalogStalledCompleteProvider';
    let markCatalogEntered!: () => void;
    let releaseCatalog!: () => void;
    const catalogEntered = new Promise<void>((resolve) => { markCatalogEntered = resolve; });
    const stalledCatalog = new Promise<null>((resolve) => {
      releaseCatalog = () => resolve(null);
    });
    let queue!: ReturnType<typeof vi.spyOn>;
    const catalog = await startAgent({
      name: 'catalog-readiness-invalidation',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [{ authorAddress: AUTHOR, providers: [providerPeerId] }],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
      beforeStart: (agent) => {
        vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
        vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
          .mockImplementation(async () => {
            markCatalogEntered();
            return stalledCatalog;
          });
        queue = vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
          .mockReturnValue(true);
      },
      config: { syncContextGraphs: [] },
    });

    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(catalog.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs).toEqual([]);
    expect(catalog.isRfc64CatalogBootstrapSwmRecoveryReadyV1(providerPeerId)).toBe(true);

    catalog.subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await catalogEntered;
    expect(catalog.readRfc64CatalogRuntimeSelectionV1().selectedContextGraphs)
      .toEqual([CONTEXT_GRAPH_ID]);
    expect(catalog.isRfc64CatalogBootstrapSwmRecoveryReadyV1(providerPeerId)).toBe(false);
    expect(queue).not.toHaveBeenCalled();

    releaseCatalog();
    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(catalog.isRfc64CatalogBootstrapSwmRecoveryReadyV1(providerPeerId)).toBe(true);
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPeerId,
        targets: [{ contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' }],
      }),
      expect.any(Function),
      0,
    );
  });

  it('aborts an in-flight selected recovery fetch before it can mutate the store', async () => {
    const providerPeerId = '12D3KooWCatalogRevocationProvider';
    let markFetchEntered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => { markFetchEntered = resolve; });
    let fetchSignal: AbortSignal | undefined;
    const catalog = await startAgent({
      name: 'catalog-recovery-revocation',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          retryIntervalMs: 0,
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
      beforeStart: (agent) => {
        vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
        vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
          .mockReturnValue(true);
      },
      config: { durableSyncEnabled: true },
    });
    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();

    const dataQuad: Quad = {
      subject: 'https://example.org/revoked',
      predicate: 'https://schema.org/name',
      object: '"must-not-commit"',
      graph: contextGraphWorkspaceGraphUri(CONTEXT_GRAPH_ID),
    };
    let firstFetch = true;
    vi.spyOn(catalog, 'fetchSyncPages').mockImplementation(async (
      _ctx,
      _peerId,
      _contextGraphId,
      _includeSharedMemory,
      phase,
      _graphUri,
      _deadline,
      options,
    ) => {
      if (firstFetch) {
        firstFetch = false;
        fetchSignal = options?.signal;
        markFetchEntered();
        await new Promise<never>((_resolve, reject) => {
          const signal = fetchSignal;
          if (signal === undefined) {
            reject(new Error('selected recovery did not forward its revocation signal'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      const quads = phase === 'data' ? [dataQuad] : [];
      return {
        quads,
        bytesReceived: quads.length,
        resumedFromOffset: 0,
        nextOffset: quads.length,
        checkpointKey: `revocation:${phase}`,
        completed: true,
        timedOut: false,
      };
    });
    vi.spyOn(catalog, 'getOrCreateSyncVerifyWorker').mockReturnValue({
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: metaQuads.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
    } as any);

    const recovery = catalog.syncSelectedSharedMemoryFromPeerDetailed(
      providerPeerId,
      [CONTEXT_GRAPH_ID],
      {
        selectedSwmPriority: true,
        requestedScope: {
          kind: 'rfc64-recovery-plan',
          plan: {
            kind: 'rfc64-authorized-swm-recovery-v1',
            providerPeerId,
            targets: [{ contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' }],
          },
        },
        stopOnBackoffWorthyFailure: true,
        priority: 2_000,
        source: 'on-connect',
      },
    );
    await fetchEntered;

    const admission = (catalog as any).selectedSwmBootstrapAdmission;
    expect(admission.snapshot(providerPeerId)).toMatchObject({ phase: 'retry-required' });
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal?.aborted).toBe(false);
    catalog.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    expect(fetchSignal?.aborted).toBe(true);
    expect(admission.snapshot(providerPeerId)).toBeNull();

    await expect(recovery).resolves.toMatchObject({
      kind: 'selected-shared-memory',
      scopeComplete: false,
      targetDiagnostics: {
        selectedPublic: { completed: 0, total: 1 },
      },
    });
    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(admission.snapshot(providerPeerId)).toBeNull();
    const store = (catalog as any).store;
    await expect(store.hasGraph(contextGraphWorkspaceGraphUri(CONTEXT_GRAPH_ID)))
      .resolves.toBe(false);
  });

  it('revokes selected recovery after verification but before materialization', async () => {
    const providerPeerId = '12D3KooWCatalogLateRevocationProvider';
    const catalog = await startAgent({
      name: 'catalog-late-recovery-revocation',
      activation: {
        ...activation('catalog'),
        bootstrap: {
          retryIntervalMs: 0,
          acceptedPublicPolicies: [{
            policyEnvelope: policyEnvelope(),
            targets: [],
            completeSwmProviders: [providerPeerId],
          }],
        },
      },
      beforeStart: (agent) => {
        vi.spyOn(agent, 'connectToPeerId').mockResolvedValue();
        vi.spyOn(agent, 'queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect')
          .mockReturnValue(true);
      },
      config: { durableSyncEnabled: true },
    });
    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();

    const dataQuad: Quad = {
      subject: 'https://example.org/late-revoked',
      predicate: 'https://schema.org/name',
      object: '"must-not-materialize"',
      graph: contextGraphWorkspaceGraphUri(CONTEXT_GRAPH_ID),
    };
    vi.spyOn(catalog, 'fetchSyncPages').mockImplementation(async (
      _ctx,
      _peerId,
      _contextGraphId,
      _includeSharedMemory,
      phase,
    ) => {
      const quads = phase === 'data' ? [dataQuad] : [];
      return {
        quads,
        bytesReceived: quads.length,
        resumedFromOffset: 0,
        nextOffset: quads.length,
        checkpointKey: `late-revocation:${phase}`,
        completed: true,
        timedOut: false,
      };
    });
    let markVerificationEntered!: () => void;
    let releaseVerification!: () => void;
    const verificationEntered = new Promise<void>((resolve) => {
      markVerificationEntered = resolve;
    });
    const verificationRelease = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    vi.spyOn(catalog, 'getOrCreateSyncVerifyWorker').mockReturnValue({
      processSharedMemoryBatch: async (dataQuads, metaQuads) => {
        markVerificationEntered();
        await verificationRelease;
        return {
          verifiedData: dataQuads,
          verifiedMeta: metaQuads,
          totalFetchedDataQuads: dataQuads.length,
          totalFetchedMetaQuads: metaQuads.length,
          droppedDataTriples: 0,
          emptyResponses: 0,
          entityCreators: [],
        };
      },
    } as any);

    const recovery = catalog.syncSelectedSharedMemoryFromPeerDetailed(
      providerPeerId,
      [CONTEXT_GRAPH_ID],
      {
        selectedSwmPriority: true,
        requestedScope: {
          kind: 'rfc64-recovery-plan',
          plan: {
            kind: 'rfc64-authorized-swm-recovery-v1',
            providerPeerId,
            targets: [{ contextGraphId: CONTEXT_GRAPH_ID, lane: 'selected-public' }],
          },
        },
        stopOnBackoffWorthyFailure: true,
        priority: 2_000,
        source: 'on-connect',
      },
    );
    await verificationEntered;

    const admission = (catalog as any).selectedSwmBootstrapAdmission;
    catalog.unsubscribeFromContextGraph(CONTEXT_GRAPH_ID);
    releaseVerification();

    await expect(recovery).resolves.toMatchObject({
      kind: 'selected-shared-memory',
      scopeComplete: false,
      targetDiagnostics: {
        selectedPublic: { completed: 0, total: 1 },
      },
    });
    await catalog.whenRfc64PublicCatalogBootstrapIdleV1();
    expect(admission.snapshot(providerPeerId)).toBeNull();
    const store = (catalog as any).store;
    await expect(store.hasGraph(contextGraphWorkspaceGraphUri(CONTEXT_GRAPH_ID)))
      .resolves.toBe(false);
  });
});
