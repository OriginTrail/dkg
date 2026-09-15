// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { buildRfc64CatalogStatusSnapshotV1 } from
  '../src/rfc64/catalog-status-snapshot-v1.js';
import { resolveRfc64CatalogActivationsV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';
import {
  LOCAL,
  PRIVATE_CG,
  PROVIDER,
  PROVIDER_PEER,
  chainIdentity,
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
});
