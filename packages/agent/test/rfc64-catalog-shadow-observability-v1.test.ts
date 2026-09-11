import { describe, expect, it } from 'vitest';

import {
  observeRfc64CatalogShadowReceiverCompletionV1,
  projectRfc64CatalogShadowExecutionStatusV1,
  readRfc64CatalogShadowReceiverCompletionCountersV1,
} from '../src/rfc64/catalog-shadow-observability-v1.js';
import { Rfc64PublicCatalogReceiverV1 } from
  '../src/rfc64/public-catalog-receiver-v1.js';
import {
  bindRfc64SwmCatalogProjectionOwnerV1,
  Rfc64SwmCatalogProjectionOwnerV1,
  Rfc64SwmCatalogProjectionSupervisorMethods,
} from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import type { DKGAgent } from '../src/dkg-agent.js';

const SHADOW_CG = '0x1111111111111111111111111111111111111111/private-shadow';
const OTHER_CG = '0x2222222222222222222222222222222222222222/catalog';
const PRIVATE_AUTHOR = '0x3333333333333333333333333333333333333333';
const PRIVATE_PROVIDER = '12D3KooPrivateProviderMustNotLeak';
const PRIVATE_UAL = 'did:dkg:otp:20430/secret-ual';
const PRIVATE_ERROR = `provider ${PRIVATE_PROVIDER} failed for ${PRIVATE_UAL}`;
const HEAD_DIGEST = `0x${'44'.repeat(32)}`;

describe('RFC-64 catalog shadow observability projection', () => {
  it('reads the safe projection from the agent-owned supervisor and inventory runtime', () => {
    const agent = {
      config: {
        rfc64CatalogExecutionPlan: {
          selectedAuthority: { [SHADOW_CG]: { mode: 'shadow' } },
        },
      },
      readRfc64CatalogShadowContextGraphIdsV1: () => [SHADOW_CG],
      readRfc64PublicCatalogBootstrapStatusV1: () => ({
        running: false,
        pass: 1,
        retryIntervalMs: 5_000,
        lastPassStartedAtMs: 10,
        lastPassCompletedAtMs: 20,
        targets: [{
          scope: { contextGraphId: SHADOW_CG },
          mode: 'shadow',
          outcome: 'shadow-staged',
          appliedHeadDigest: null,
        }],
      }),
    } as unknown as DKGAgent;
    bindRfc64SwmCatalogProjectionOwnerV1(
      agent,
      new Rfc64SwmCatalogProjectionOwnerV1({
        resolvePartition: () => undefined,
        listLocalAuthorAddresses: () => [],
        acceptsPublicRootLane: () => false,
        acceptsFinalizedPrivateLane: () => false,
        listFinalizedPrivateRepairs: () => [],
        repairFinalizedPrivatePlacement: async () => undefined,
        reconcile: async () => null,
        warn: () => undefined,
      }),
    );
    observeRfc64CatalogShadowReceiverCompletionV1(
      agent,
      SHADOW_CG,
      'shadow',
      'staged-only',
    );

    const status = Rfc64SwmCatalogProjectionSupervisorMethods.prototype
      .readRfc64CatalogShadowExecutionStatusV1.call(agent);

    expect(status).toMatchObject({
      contextGraphCount: 1,
      legacyAuthorityRetained: true,
      authoritativeApplyAllowed: false,
      inventoryObserver: { scope: 'process', inFlight: 0 },
      projectionSupervisor: { trackedAuthorScopes: 0 },
      receiverStaging: {
        trackedTargets: 1,
        staged: 1,
        authoritativeApplyCount: 0,
        stagingObserved: true,
        stageOnlyInvariantSatisfied: true,
      },
    });
  });

  it('proves staged-only progress with fixed aggregate counters and no identifiers', () => {
    const status = projectRfc64CatalogShadowExecutionStatusV1({
      shadowContextGraphIds: [SHADOW_CG, SHADOW_CG],
      inFlightInventoryObservers: 2,
      inventoryObserver: {
        attemptedUpserts: 7,
        appliedUpserts: 5,
        existingUpserts: 1,
        attemptedRemovals: 4,
        appliedRemovals: 2,
        absentRemovals: 1,
        failed: 2,
        casRetries: 3,
        lastAction: 'upsert',
        lastContextGraphId: SHADOW_CG,
        lastKaUal: PRIVATE_UAL,
        lastHeadDigest: HEAD_DIGEST,
        lastError: PRIVATE_ERROR,
      },
      projectionSupervisor: {
        running: false,
        pass: 4,
        retryIntervalMs: 5_000,
        lastPassStartedAtMs: 10,
        lastPassCompletedAtMs: 20,
        repairs: [{
          contextGraphId: SHADOW_CG,
          authorAddress: PRIVATE_AUTHOR,
          outcome: 'reconciled',
          attempts: 2,
          inventoryHeadObjectDigest: HEAD_DIGEST,
          catalogVersion: '2',
          inventoryRowCount: '3',
          lastError: null,
          updatedAtMs: 20,
        }, {
          contextGraphId: OTHER_CG,
          authorAddress: PRIVATE_AUTHOR,
          outcome: 'failed',
          attempts: 1,
          inventoryHeadObjectDigest: null,
          catalogVersion: null,
          inventoryRowCount: null,
          lastError: PRIVATE_ERROR,
          updatedAtMs: 20,
        }],
      } as never,
      bootstrap: {
        running: false,
        pass: 3,
        retryIntervalMs: 5_000,
        lastPassStartedAtMs: 30,
        lastPassCompletedAtMs: 40,
        targets: [{
          scope: {
            networkId: 'otp:20430',
            contextGraphId: SHADOW_CG,
            subGraphName: null,
            authorAddress: PRIVATE_AUTHOR,
            catalogEra: '0',
          },
          providers: [PRIVATE_PROVIDER],
          mode: 'shadow',
          outcome: 'shadow-staged',
          completionReason: null,
          attempts: 1,
          providerPeerId: PRIVATE_PROVIDER,
          appliedHeadDigest: null,
          stagedHeadDigest: HEAD_DIGEST,
          catalogVersion: '2',
          inventoryRowCount: '3',
          lastError: null,
          updatedAtMs: 40,
        }, {
          scope: {
            networkId: 'otp:20430',
            contextGraphId: OTHER_CG,
            subGraphName: null,
            authorAddress: PRIVATE_AUTHOR,
            catalogEra: '0',
          },
          providers: [PRIVATE_PROVIDER],
          mode: 'catalog',
          outcome: 'failed',
          completionReason: null,
          attempts: 1,
          providerPeerId: null,
          appliedHeadDigest: null,
          stagedHeadDigest: null,
          catalogVersion: null,
          inventoryRowCount: null,
          lastError: PRIVATE_ERROR,
          updatedAtMs: 40,
        }],
      } as never,
      receiverCompletions: {
        trackedTargets: 1,
        staged: 1,
        notFound: 0,
        failed: 0,
        authoritativeApplyCount: 0,
      },
    });

    expect(status).toEqual({
      schemaVersion: 1,
      contextGraphCount: 1,
      legacyAuthorityRetained: true,
      authoritativeApplyAllowed: false,
      inventoryObserver: {
        scope: 'process',
        inFlight: 2,
        attemptedUpserts: 7,
        attemptedRemovals: 4,
        committedMutations: 7,
        noOpMutations: 2,
        failedMutations: 2,
        casRetries: 3,
      },
      projectionSupervisor: {
        running: false,
        passes: 4,
        trackedAuthorScopes: 1,
        pending: 0,
        reconciled: 1,
        noInventory: 0,
        failed: 0,
        lastPassStartedAtMs: 10,
        lastPassCompletedAtMs: 20,
      },
      receiverStaging: {
        running: false,
        passes: 3,
        trackedTargets: 1,
        pending: 0,
        staged: 1,
        notFound: 0,
        knownIncomplete: 0,
        failed: 0,
        authoritativeApplyCount: 0,
        stagingObserved: true,
        stageOnlyInvariantSatisfied: true,
        lastPassStartedAtMs: 30,
        lastPassCompletedAtMs: 40,
      },
    });
    const serialized = JSON.stringify(status);
    for (const sensitive of [
      SHADOW_CG,
      OTHER_CG,
      PRIVATE_AUTHOR,
      PRIVATE_PROVIDER,
      PRIVATE_UAL,
      PRIVATE_ERROR,
      HEAD_DIGEST,
    ]) expect(serialized).not.toContain(sensitive);
  });

  it('makes any authoritative shadow completion visible as an invariant failure', () => {
    const status = projectRfc64CatalogShadowExecutionStatusV1({
      shadowContextGraphIds: [SHADOW_CG],
      inFlightInventoryObservers: 0,
      inventoryObserver: {
        attemptedUpserts: 0,
        appliedUpserts: 0,
        existingUpserts: 0,
        attemptedRemovals: 0,
        appliedRemovals: 0,
        absentRemovals: 0,
        failed: 0,
        casRetries: 0,
        lastAction: null,
        lastContextGraphId: null,
        lastKaUal: null,
        lastHeadDigest: null,
        lastError: null,
      },
      projectionSupervisor: null,
      bootstrap: {
        running: false,
        pass: 1,
        retryIntervalMs: 0,
        lastPassStartedAtMs: 1,
        lastPassCompletedAtMs: 2,
        targets: [{
          scope: { contextGraphId: SHADOW_CG },
          mode: 'shadow',
          outcome: 'applied',
          appliedHeadDigest: HEAD_DIGEST,
        }],
      } as never,
      receiverCompletions: {
        trackedTargets: 1,
        staged: 0,
        notFound: 0,
        failed: 0,
        authoritativeApplyCount: 1,
      },
    });

    expect(status?.receiverStaging).toMatchObject({
      trackedTargets: 1,
      staged: 0,
      authoritativeApplyCount: 1,
      stagingObserved: false,
      stageOnlyInvariantSatisfied: false,
    });
  });

  it('records ordinary receiver completions cumulatively before later classification', async () => {
    const owner = {};
    let outcome: 'applied' | 'staged-only' = 'applied';
    const receiver = new Rfc64PublicCatalogReceiverV1({
      isHeadSatisfied: async () => false,
      reconcileHead: async () => outcome,
    }, {
      onCompletion: (announcement, completionOutcome) => {
        observeRfc64CatalogShadowReceiverCompletionV1(
          owner,
          announcement.contextGraphId,
          'shadow',
          completionOutcome,
        );
      },
    });
    const announcement = (version: string) => ({
      kind: 'dkg/rfc64/public-catalog/head-announcement/v1',
      networkId: 'otp:20430',
      contextGraphId: SHADOW_CG,
      subGraphName: null,
      authorAddress: PRIVATE_AUTHOR,
      catalogEra: '0',
      catalogVersion: version,
      policyDigest: `0x${'11'.repeat(32)}`,
      catalogHeadObjectDigest: `0x${version.padStart(64, '0')}`,
      signatureVariantDigest: `0x${'22'.repeat(32)}`,
    }) as never;

    receiver.schedule(announcement('1'), PRIVATE_PROVIDER);
    await receiver.whenIdle();
    outcome = 'staged-only';
    receiver.schedule(announcement('2'), PRIVATE_PROVIDER);
    await receiver.whenIdle();

    expect(readRfc64CatalogShadowReceiverCompletionCountersV1(owner, [SHADOW_CG]))
      .toEqual({
        trackedTargets: 2,
        staged: 1,
        notFound: 0,
        failed: 0,
        authoritativeApplyCount: 1,
      });
    await receiver.close();
  });

  it('retains conservative apply evidence after the bounded CG tracker fills', () => {
    const owner = {};
    for (let index = 0; index < 1_024; index += 1) {
      observeRfc64CatalogShadowReceiverCompletionV1(
        owner,
        `bounded-shadow-${index}`,
        'shadow',
        'staged-only',
      );
    }
    observeRfc64CatalogShadowReceiverCompletionV1(
      owner,
      'overflow-shadow',
      'shadow',
      'applied',
    );

    expect(readRfc64CatalogShadowReceiverCompletionCountersV1(
      owner,
      ['overflow-shadow'],
    )).toMatchObject({
      trackedTargets: 1,
      authoritativeApplyCount: 1,
    });
  });

  it('omits the block when no Context Graph is in shadow mode', () => {
    expect(projectRfc64CatalogShadowExecutionStatusV1({
      shadowContextGraphIds: [],
      inFlightInventoryObservers: 0,
      inventoryObserver: {} as never,
      projectionSupervisor: null,
      bootstrap: null,
      receiverCompletions: {
        trackedTargets: 0,
        staged: 0,
        notFound: 0,
        failed: 0,
        authoritativeApplyCount: 0,
      },
    })).toBeNull();
  });
});
