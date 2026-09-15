// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/dkg-agent.js';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';
import {
  buildRfc64CatalogConfigurationEvidenceV1,
  buildRfc64CatalogStatusSnapshotV1,
} from
  '../src/rfc64/catalog-status-snapshot-v1.js';
import { resolveRfc64CatalogActivationsV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';
import {
  LOCAL,
  PRIVATE_CG,
  PROVIDER,
  PROVIDER_PEER,
  PUBLIC_CG,
  chainIdentity,
  policy,
  policyEnvelope,
  privateActivation,
} from './rfc64-catalog-activation-fixtures.js';

describe('RFC-64 catalog status snapshot', () => {
  it('owns the complete versioned DTO and withholds private target identities', () => {
    const activations = resolveRfc64CatalogActivationsV1({
      catalog: {
        ...privateActivation(),
        rollout: { defaultMode: 'catalog' },
      },
      persistenceAvailable: true,
    }, chainIdentity);
    const privateError = `provider ${PROVIDER_PEER} failed for ${PROVIDER}`;
    const snapshot = buildRfc64CatalogStatusSnapshotV1({
      activations,
      runtime: {
        service: null,
        bootstrap: {
          running: false,
          pass: 1,
          retryIntervalMs: 1_000,
          lastPassStartedAtMs: 10,
          lastPassCompletedAtMs: 20,
          targets: [{
            scope: {
              networkId: chainIdentity.networkId,
              contextGraphId: PRIVATE_CG,
              subGraphName: null,
              authorAddress: PROVIDER,
              catalogEra: '0',
            },
            providers: [PROVIDER_PEER],
            mode: 'catalog',
            outcome: 'known-incomplete',
            completionReason: 'no-authorized-provider',
            attempts: 1,
            providerPeerId: PROVIDER_PEER,
            appliedHeadDigest: null,
            stagedHeadDigest: null,
            catalogVersion: null,
            inventoryRowCount: null,
            lastError: privateError,
            updatedAtMs: 20,
          }],
        },
        runtimeSelection: {
          subscriptionDriven: true,
          eligibleContextGraphs: [PRIVATE_CG],
          selectedContextGraphs: [PRIVATE_CG],
        },
        responsibilities: [{
          contextGraphId: PRIVATE_CG,
          responsible: true,
          responsibilityReason: 'private-membership',
          active: true,
          mode: 'catalog',
          selectionSource: 'default',
        }],
        authorityRpcCircuit: {
          state: 'closed',
          consecutiveExhaustions: 0,
          retryAtMs: null,
        },
        contextGraphs: [],
        shadowExecution: null,
      },
    });

    expect(Object.keys(snapshot).sort()).toEqual([
      'rfc64Catalog',
      'rfc64PublicCatalog',
      'schemaVersion',
    ]);
    expect(Object.keys(snapshot.rfc64PublicCatalog).sort()).toEqual([
      'autoPublishEnabled',
      'bootstrap',
      'completeSwmProviders',
      'enabled',
      'rollout',
      'runtimeSelection',
      'selectedContextGraphs',
      'service',
    ]);
    expect(Object.keys(snapshot.rfc64Catalog).sort()).toEqual([
      'authorityRpcCircuit',
      'autoPublishEnabled',
      'configuration',
      'contextGraphs',
      'enabled',
      'privateAuthorityConfigured',
      'privateRecovery',
      'resourceTelemetry',
      'responsibilities',
      'rollout',
      'runtimeSelection',
      'selectedContextGraphs',
      'selectedPrivateContextGraphs',
      'selectedPublicContextGraphs',
      'shadowExecution',
    ]);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.rfc64PublicCatalog.bootstrap).toBeNull();
    expect(snapshot.rfc64Catalog.privateRecovery).toEqual([expect.objectContaining({
      contextGraphId: PRIVATE_CG,
      accessPolicy: 1,
      targetCount: 1,
      outcomeCounts: { 'known-incomplete': 1 },
      completionReasons: ['no-authorized-provider'],
    })]);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(PROVIDER_PEER);
    expect(serialized).not.toContain(PROVIDER);
    expect(serialized).not.toContain(LOCAL);
    expect(serialized).not.toContain(privateError);
  });

  it('projects only public bootstrap targets and complete SWM providers', () => {
    const publicPolicyEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const activations = resolveRfc64CatalogActivationsV1({
      publicCatalog: {
        bootstrap: {
          acceptedPublicPolicies: [{
            policyEnvelope: publicPolicyEnvelope,
            targets: [],
            completeSwmProviders: [PROVIDER_PEER],
          }],
          retryIntervalMs: 1_000,
        },
      },
      persistenceAvailable: true,
    }, chainIdentity);
    const snapshot = buildRfc64CatalogStatusSnapshotV1({
      activations,
      runtime: {
        service: null,
        bootstrap: {
          running: false,
          pass: 1,
          retryIntervalMs: 1_000,
          lastPassStartedAtMs: 10,
          lastPassCompletedAtMs: 20,
          targets: [PUBLIC_CG, PRIVATE_CG].map((contextGraphId) => ({
            scope: {
              networkId: chainIdentity.networkId,
              contextGraphId,
              subGraphName: null,
              authorAddress: PROVIDER,
              catalogEra: '0',
            },
            providers: [PROVIDER_PEER],
            mode: 'catalog' as const,
            outcome: 'known-incomplete' as const,
            completionReason: 'no-authorized-provider' as const,
            attempts: 1,
            providerPeerId: PROVIDER_PEER,
            appliedHeadDigest: null,
            stagedHeadDigest: null,
            catalogVersion: null,
            inventoryRowCount: null,
            lastError: null,
            updatedAtMs: 20,
          })),
        },
        runtimeSelection: {
          subscriptionDriven: true,
          eligibleContextGraphs: [PUBLIC_CG, PRIVATE_CG],
          selectedContextGraphs: [PUBLIC_CG, PRIVATE_CG],
        },
        responsibilities: [],
        authorityRpcCircuit: {
          state: 'closed',
          consecutiveExhaustions: 0,
          retryAtMs: null,
        },
        contextGraphs: [],
        shadowExecution: null,
      },
    });

    expect(snapshot.rfc64PublicCatalog.bootstrap?.targets).toHaveLength(1);
    expect(snapshot.rfc64PublicCatalog.bootstrap?.targets[0]?.scope.contextGraphId)
      .toBe(PUBLIC_CG);
    expect(snapshot.rfc64PublicCatalog.completeSwmProviders).toEqual([{
      contextGraphId: PUBLIC_CG,
      accessPolicy: 0,
      publishPolicy: 1,
      providers: [PROVIDER_PEER],
    }]);
    expect(snapshot.rfc64PublicCatalog.rollout.contextGraphModes)
      .toEqual({ [PUBLIC_CG]: 'catalog' });
  });

  it('attests sorted legacy and shadow rollout overrides', () => {
    const activations = resolveRfc64CatalogActivationsV1({
      catalog: {
        rollout: {
          defaultMode: 'catalog',
          contextGraphModes: {
            [PUBLIC_CG]: 'shadow',
            [PRIVATE_CG]: 'legacy',
          },
        },
      },
      persistenceAvailable: true,
    }, chainIdentity);

    expect(buildRfc64CatalogConfigurationEvidenceV1(activations.activationState))
      .toMatchObject({
        source: 'operator-override',
        defaultMode: 'catalog',
        legacyOverrideCount: 1,
        shadowOverrideCount: 1,
      });
  });

  it('composes the disabled agent snapshot without reading dormant subsystems', async () => {
    const activations = resolveRfc64CatalogActivationsV1({
      catalog: { enabled: false },
      persistenceAvailable: true,
    }, chainIdentity);
    const readRuntimeSelection = vi.fn(() => ({
      subscriptionDriven: false,
      eligibleContextGraphs: [],
      selectedContextGraphs: [],
    }));
    const readResponsibilities = vi.fn(() => []);
    const readAuthorityCircuit = vi.fn(() => ({
      state: 'closed' as const,
      consecutiveExhaustions: 0,
      retryAtMs: null,
    }));
    const readOperationalStatus = vi.fn(async () => []);
    const agent = {
      config: { rfc64CatalogActivations: activations },
      readRfc64CatalogRuntimeSelectionV1: readRuntimeSelection,
      readRfc64CatalogResponsibilitiesV1: readResponsibilities,
      readRfc64AuthorityRpcCircuitSnapshotV1: readAuthorityCircuit,
      readRfc64CatalogOperationalStatusV1: readOperationalStatus,
      rfc64PublicCatalogStatsV1: vi.fn(() => {
        throw new Error('disabled service must not be read');
      }),
      readRfc64PublicCatalogBootstrapStatusV1: vi.fn(() => {
        throw new Error('disabled bootstrap must not be read');
      }),
      readRfc64CatalogShadowExecutionStatusV1: vi.fn(() => {
        throw new Error('disabled shadow status must not be read');
      }),
    } as unknown as DKGAgent;

    const snapshot = await Rfc64CatalogMethods.prototype
      .readRfc64CatalogStatusSnapshotV1.call(agent);

    expect(snapshot.rfc64Catalog.enabled).toBe(false);
    expect(snapshot.rfc64PublicCatalog.service).toBeNull();
    expect(readRuntimeSelection).toHaveBeenCalledOnce();
    expect(readResponsibilities).toHaveBeenCalledOnce();
    expect(readAuthorityCircuit).toHaveBeenCalledOnce();
    expect(readOperationalStatus).toHaveBeenCalledOnce();
  });
});
