// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  rfc64CatalogKillSwitchActiveV1,
  rfc64CatalogRolloutModeForContextGraphV1,
  resolveRfc64CatalogActivationsV1,
} from '../src/rfc64/public-catalog-activation-config-v1.js';
import {
  mergeRfc64CatalogRolloutConfigsV1,
  type ResolvedRfc64CatalogRolloutConfigV1,
} from '../src/rfc64/catalog-rollout-authority-v1.js';
import {
  snapshotRfc64CatalogBootstrapConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from '../src/rfc64/catalog-authority-config-v1.js';
import { mergeRfc64CatalogBootstrapsV1 } from '../src/dkg-agent.js';
import {
  PRIVATE_CG,
  PUBLIC_CG,
  chainIdentity,
  policy,
  policyEnvelope,
  privateActivation,
  publicBootstrapPolicy,
} from './rfc64-catalog-activation-fixtures.js';

describe('RFC-64 catalog rollout and compatibility merging', () => {
  it('keeps pre-defaultMode resolved snapshots source-compatible', () => {
    const legacySnapshot: ResolvedRfc64CatalogRolloutConfigV1 = {
      killSwitch: false,
      contextGraphModes: {},
    };

    expect(mergeRfc64CatalogRolloutConfigsV1(legacySnapshot, legacySnapshot))
      .toEqual({ killSwitch: false, defaultMode: 'catalog', contextGraphModes: {} });
  });

  it('keeps public compatibility, unions disjoint blocks, and rejects overlap conflicts', () => {
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const publicCatalog = {
      bootstrap: {
        acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
        retryIntervalMs: 1_000,
      },
    } as const;
    const union = resolveRfc64CatalogActivationsV1({
      catalog: privateActivation(),
      publicCatalog,
    }, chainIdentity);
    expect(union.catalog.selectedContextGraphs).toEqual([PUBLIC_CG, PRIVATE_CG]);
    expect(union.publicCatalog.selectedContextGraphs).toEqual([PUBLIC_CG]);

    const conflictingPublic = {
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: policyEnvelope(policy(PRIVATE_CG, 0)),
          targets: [],
        }],
        retryIntervalMs: 1_000,
      },
    } as const;
    expect(() => resolveRfc64CatalogActivationsV1({
      catalog: privateActivation(),
      publicCatalog: conflictingPublic,
    }, chainIdentity)).toThrow(/conflict for selected graph/u);
  });

  it('rejects rollout-mode conflicts for identical overlapping manifests', () => {
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const accepted = { policyEnvelope: publicEnvelope, targets: [] } as const;
    const publicCatalog = {
      bootstrap: {
        acceptedPublicPolicies: [accepted],
        retryIntervalMs: 1_000,
      },
    } as const;

    expect(() => resolveRfc64CatalogActivationsV1({
      catalog: {
        rollout: { contextGraphModes: { [PUBLIC_CG]: 'shadow' } },
        bootstrap: { acceptedPolicies: [accepted], retryIntervalMs: 1_000 },
      },
      publicCatalog,
    }, chainIdentity)).toThrow(
      /rfc64Catalog and rfc64PublicCatalog rollout modes conflict for selected graph/u,
    );

    const matching = resolveRfc64CatalogActivationsV1({
      catalog: {
        rollout: { contextGraphModes: { [PUBLIC_CG]: 'catalog' } },
        bootstrap: { acceptedPolicies: [accepted], retryIntervalMs: 1_000 },
      },
      publicCatalog,
    }, chainIdentity);
    expect(rfc64CatalogRolloutModeForContextGraphV1(matching.catalog, PUBLIC_CG))
      .toBe('catalog');
  });

  it('lets the unified rollback suppress every deprecated public selection', () => {
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const rollback = resolveRfc64CatalogActivationsV1({
      catalog: { enabled: false },
      publicCatalog: {
        enabled: true,
        bootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
          retryIntervalMs: 1_000,
        },
      },
    }, chainIdentity);

    expect(rollback.catalog).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
      selectedPublicContextGraphs: [],
      selectedPrivateContextGraphs: [],
    });
    expect(rollback.publicCatalog).toMatchObject({ enabled: false, selectedContextGraphs: [] });
    expect(rollback.catalog.bootstrap).toBeUndefined();
    expect(rollback.publicCatalog.bootstrap).toBeUndefined();
    expect(rollback.selectedCatalogAuthoringControls).toEqual([]);
  });

  it('normalizes the deprecated disabled switch into the same full rollback', () => {
    const rollback = resolveRfc64CatalogActivationsV1({
      publicCatalog: { enabled: false },
    }, chainIdentity);

    expect(rollback.catalog).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
      selectedPublicContextGraphs: [],
      selectedPrivateContextGraphs: [],
      rollout: {
        killSwitch: false,
        defaultMode: 'catalog',
        contextGraphModes: {},
      },
    });
    expect(rollback.publicCatalog).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
    });
    expect(rollback.selectedCatalogAuthoringControls).toEqual([]);
  });

  it('unions disjoint rollout modes and lets either block engage the shared kill switch', () => {
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const union = resolveRfc64CatalogActivationsV1({
      catalog: {
        ...privateActivation(),
        rollout: { contextGraphModes: { [PRIVATE_CG]: 'catalog' } },
      },
      publicCatalog: {
        rollout: {
          killSwitch: true,
          contextGraphModes: { [PUBLIC_CG]: 'shadow' },
        },
        bootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
          retryIntervalMs: 1_000,
        },
      },
    }, chainIdentity);

    expect(rfc64CatalogRolloutModeForContextGraphV1(union.catalog, PRIVATE_CG))
      .toBe('catalog');
    expect(rfc64CatalogRolloutModeForContextGraphV1(union.catalog, PUBLIC_CG))
      .toBe('shadow');
    expect(rfc64CatalogKillSwitchActiveV1(union.catalog)).toBe(true);
  });

  it('keeps a deprecated public manifest on its catalog default without fabricating overrides', () => {
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const resolved = resolveRfc64CatalogActivationsV1({
      catalog: { rollout: { defaultMode: 'legacy' } },
      publicCatalog: {
        bootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
        },
      },
    }, chainIdentity).catalog;

    expect(resolved.rollout).toEqual({
      killSwitch: false,
      defaultMode: 'legacy',
      contextGraphModes: {},
    });
    expect(resolved.selectedContextGraphModes).toEqual({ [PUBLIC_CG]: 'catalog' });
    expect(rfc64CatalogRolloutModeForContextGraphV1(resolved, PUBLIC_CG)).toBe('catalog');
  });

  it('enforces aggregate policy and target limits across additive and compatibility blocks', () => {
    const additivePolicies = Array.from({ length: 32 }, (_, index) => (
      publicBootstrapPolicy(index)
    ));
    const compatibilityPolicies = Array.from({ length: 33 }, (_, index) => (
      publicBootstrapPolicy(index + additivePolicies.length)
    ));
    expect(() => resolveRfc64CatalogActivationsV1({
      catalog: {
        bootstrap: { acceptedPolicies: additivePolicies, retryIntervalMs: 1_000 },
      },
      publicCatalog: {
        bootstrap: {
          acceptedPublicPolicies: compatibilityPolicies,
          retryIntervalMs: 1_000,
        },
      },
    }, chainIdentity)).toThrow(/acceptedPolicies must contain at most 64 policies/u);

    expect(() => resolveRfc64CatalogActivationsV1({
      catalog: {
        bootstrap: {
          acceptedPolicies: [publicBootstrapPolicy(0, 128)],
          retryIntervalMs: 1_000,
        },
      },
      publicCatalog: {
        bootstrap: {
          acceptedPublicPolicies: [publicBootstrapPolicy(1, 129)],
          retryIntervalMs: 1_000,
        },
      },
    }, chainIdentity)).toThrow(/targets must contain at most 256 catalogs/u);
  });

  it('merges additive private bootstrap with legacy public bootstrap without dropping either', () => {
    const privateBootstrap = privateActivation().bootstrap;
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const legacyPublic = {
      acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
      retryIntervalMs: 1_000,
    } as const;

    const merged = mergeRfc64CatalogBootstrapsV1(privateBootstrap, legacyPublic);
    expect(merged?.acceptedPolicies.map(({ policyEnvelope: envelope }) => (
      envelope.payload.contextGraphId
    ))).toEqual([PRIVATE_CG, PUBLIC_CG]);
    expect(merged?.retryIntervalMs).toBe(1_000);
    expect(() => mergeRfc64CatalogBootstrapsV1(privateBootstrap, {
      ...legacyPublic,
      acceptedPublicPolicies: [{
        policyEnvelope: privateBootstrap.acceptedPolicies[0]!.policyEnvelope,
        targets: [],
      }],
    })).toThrow(/configured twice/u);
  });

  it('enforces aggregate limits in the daemon bootstrap merge', () => {
    const catalogByPolicy = snapshotRfc64CatalogBootstrapConfigV1({
      acceptedPolicies: Array.from({ length: 32 }, (_, index) => (
        publicBootstrapPolicy(index)
      )),
      retryIntervalMs: 1_000,
    })!;
    const publicByPolicy = snapshotRfc64PublicCatalogBootstrapConfigV1({
      acceptedPublicPolicies: Array.from({ length: 33 }, (_, index) => (
        publicBootstrapPolicy(index + 32)
      )),
      retryIntervalMs: 1_000,
    })!;
    expect(() => mergeRfc64CatalogBootstrapsV1(catalogByPolicy, publicByPolicy))
      .toThrow(/acceptedPolicies must contain at most 64 policies/u);

    const catalogByTarget = snapshotRfc64CatalogBootstrapConfigV1({
      acceptedPolicies: [publicBootstrapPolicy(0, 128)],
      retryIntervalMs: 1_000,
    })!;
    const publicByTarget = snapshotRfc64PublicCatalogBootstrapConfigV1({
      acceptedPublicPolicies: [publicBootstrapPolicy(1, 129)],
      retryIntervalMs: 1_000,
    })!;
    expect(() => mergeRfc64CatalogBootstrapsV1(catalogByTarget, publicByTarget))
      .toThrow(/targets must contain at most 256 catalogs/u);
  });
});
