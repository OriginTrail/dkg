// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import type {
  Rfc64CatalogOperationalStatusV1,
  Rfc64CatalogRuntimeSelectionStatusV1,
} from '../dkg-agent-rfc64-catalog.js';
import type { Rfc64PublicCatalogBootstrapStatusV1 } from
  '../dkg-agent-rfc64-catalog-bootstrap.js';
import type { Rfc64AuthorityReadCoordinatorSnapshotV1 } from
  './authority-rpc-circuit-breaker-v1.js';
import type { Rfc64CatalogResponsibilitySelectionV1 } from
  './catalog-responsibility-registry-v1.js';
import type { Rfc64CatalogShadowExecutionStatusV1 } from
  './catalog-shadow-observability-v1.js';
import {
  rfc64CatalogRolloutModeForContextGraphV1,
  type Rfc64CatalogNormalizedActivationStateV1,
  type ResolvedRfc64CatalogActivationsV1,
} from './public-catalog-activation-config-v1.js';
import type { Rfc64PublicCatalogServiceStatsV1 } from
  './public-catalog-service-v1.js';

export interface Rfc64CatalogConfigurationEvidenceV1 {
  readonly schemaVersion: 1;
  readonly source:
    | 'default-omitted'
    | 'operator-override'
    | 'compatibility-seed'
    | 'explicit-disabled';
  readonly catalogControlPresent: boolean;
  readonly deprecatedPublicControlPresent: boolean;
  readonly activationManifestPresent: boolean;
  readonly deprecatedDisabledOverride: boolean;
  readonly killSwitch: boolean;
  readonly defaultMode: 'legacy' | 'shadow' | 'catalog';
  readonly legacyOverrideCount: number;
  readonly shadowOverrideCount: number;
  readonly digest: string;
}

export interface Rfc64CatalogStatusRuntimeV1 {
  readonly service: Readonly<Rfc64PublicCatalogServiceStatsV1> | null;
  readonly bootstrap: Readonly<Rfc64PublicCatalogBootstrapStatusV1> | null;
  readonly runtimeSelection: Readonly<Rfc64CatalogRuntimeSelectionStatusV1>;
  readonly responsibilities: readonly Readonly<Rfc64CatalogResponsibilitySelectionV1>[];
  readonly authorityRpcCircuit: Readonly<Rfc64AuthorityReadCoordinatorSnapshotV1>;
  readonly contextGraphs: readonly Readonly<Rfc64CatalogOperationalStatusV1>[];
  readonly shadowExecution: Readonly<Rfc64CatalogShadowExecutionStatusV1> | null;
}

/**
 * Privacy-safe attestation of the startup controls that selected RFC-64.
 * Private graph ids and policy material participate in the digest but never
 * leave the snapshot through this evidence block.
 */
export function buildRfc64CatalogConfigurationEvidenceV1(
  activationState: Rfc64CatalogNormalizedActivationStateV1,
): Rfc64CatalogConfigurationEvidenceV1 {
  const { configuration, execution } = activationState;
  const catalogControlPresent = configuration.source === 'unified';
  const deprecatedPublicControlPresent = configuration.source === 'deprecated-public'
    || (
      configuration.source === 'unified'
      && configuration.deprecatedPublicControlPresent
    );
  const activationManifestPresent = configuration.source === 'unified'
    || configuration.source === 'deprecated-public'
    ? configuration.activationManifestPresent
    : false;
  const deprecatedDisabledOverride = execution.mode === 'compatibility-rollback';
  const modes = Object.entries(execution.rollout.contextGraphModes)
    .sort(([left], [right]) => left.localeCompare(right));
  const defaultMode = execution.rollout.defaultMode;
  const source = deprecatedDisabledOverride
    ? 'explicit-disabled'
    : configuration.source === 'omitted'
      ? 'default-omitted'
      : activationManifestPresent
        ? 'compatibility-seed'
        : 'operator-override';
  const digestPayload = {
    schemaVersion: 1,
    catalogControlPresent,
    deprecatedPublicControlPresent,
    activationManifestPresent,
    deprecatedDisabledOverride,
    killSwitch: execution.rollout.killSwitch,
    defaultMode,
    contextGraphModes: modes,
  };
  return Object.freeze({
    schemaVersion: 1,
    source,
    catalogControlPresent,
    deprecatedPublicControlPresent,
    activationManifestPresent,
    deprecatedDisabledOverride,
    killSwitch: execution.rollout.killSwitch,
    defaultMode,
    legacyOverrideCount:
      defaultMode === 'legacy' ? 0 : modes.filter(([, mode]) => mode === 'legacy').length,
    shadowOverrideCount:
      defaultMode === 'shadow' ? 0 : modes.filter(([, mode]) => mode === 'shadow').length,
    digest: `sha256:${createHash('sha256')
      .update(JSON.stringify(digestPayload))
      .digest('hex')}`,
  });
}

/** Agent-owned composition boundary for both legacy HTTP RFC-64 blocks. */
export function buildRfc64CatalogStatusSnapshotV1(input: Readonly<{
  activations: ResolvedRfc64CatalogActivationsV1;
  runtime: Rfc64CatalogStatusRuntimeV1;
}>) {
  const { catalog, publicCatalog, activationState } = input.activations;
  const { runtime } = input;
  const rollout = activationState.execution.rollout;
  const configuration = buildRfc64CatalogConfigurationEvidenceV1(activationState);
  const selectedPublicContextGraphs = new Set(catalog.selectedPublicContextGraphs);
  const publicBootstrap = publicCatalog.enabled && runtime.bootstrap !== null
    ? Object.freeze({
        ...runtime.bootstrap,
        // Provider and author identities remain visible only for explicitly
        // public compatibility targets.
        targets: Object.freeze(runtime.bootstrap.targets.filter(
          ({ scope }) => selectedPublicContextGraphs.has(scope.contextGraphId),
        )),
      })
    : null;
  const privateRecovery = Object.freeze(catalog.selectedPrivateContextGraphs.map(
    (contextGraphId) => {
      const targets = runtime.bootstrap?.targets.filter(
        ({ scope }) => scope.contextGraphId === contextGraphId,
      ) ?? [];
      const outcomeCounts = Object.fromEntries(
        [...new Set(targets.map(({ outcome }) => outcome))]
          .sort()
          .map((outcome) => [
            outcome,
            targets.filter((target) => target.outcome === outcome).length,
          ]),
      );
      const completionReasons = [...new Set(targets.flatMap(
        ({ completionReason }) => completionReason === null ? [] : [completionReason],
      ))].sort();
      const accepted = catalog.bootstrap?.acceptedPolicies.find(
        ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId === contextGraphId,
      );
      return Object.freeze({
        contextGraphId,
        mode: rfc64CatalogRolloutModeForContextGraphV1(catalog, contextGraphId),
        accessPolicy: accepted?.policyEnvelope.payload.accessPolicy,
        publishPolicy: accepted?.policyEnvelope.payload.publishPolicy,
        vmRequired:
          accepted?.policyEnvelope.payload.accessPolicy === 1
          && accepted.policyEnvelope.payload.source.kind === 'finalized-chain',
        targetCount: targets.length,
        outcomeCounts: Object.freeze(outcomeCounts),
        completionReasons: Object.freeze(completionReasons),
      });
    },
  ));
  const completeSwmProviders = publicCatalog.enabled
    ? Object.freeze((publicCatalog.bootstrap?.acceptedPublicPolicies ?? [])
      .filter((accepted) => (accepted.completeSwmProviders?.length ?? 0) > 0)
      .map((accepted) => Object.freeze({
        contextGraphId: accepted.policyEnvelope.payload.contextGraphId,
        accessPolicy: accepted.policyEnvelope.payload.accessPolicy,
        publishPolicy: accepted.policyEnvelope.payload.publishPolicy,
        providers: accepted.completeSwmProviders,
      })))
    : Object.freeze([]);

  return Object.freeze({
    schemaVersion: 1 as const,
    rfc64PublicCatalog: Object.freeze({
      enabled: publicCatalog.enabled,
      selectedContextGraphs: publicCatalog.selectedContextGraphs,
      runtimeSelection: Object.freeze({
        subscriptionDriven: runtime.runtimeSelection.subscriptionDriven,
        selectedContextGraphs: Object.freeze(runtime.runtimeSelection.selectedContextGraphs.filter(
          (contextGraphId) => selectedPublicContextGraphs.has(contextGraphId),
        )),
      }),
      rollout: Object.freeze({
        killSwitch: rollout.killSwitch,
        contextGraphModes: Object.freeze(Object.fromEntries(
          publicCatalog.selectedContextGraphs.map((contextGraphId) => [
            contextGraphId,
            rfc64CatalogRolloutModeForContextGraphV1(catalog, contextGraphId),
          ]),
        )),
      }),
      autoPublishEnabled: publicCatalog.autoPublish !== undefined,
      completeSwmProviders,
      service: catalog.enabled ? runtime.service : null,
      bootstrap: publicBootstrap,
    }),
    // Local operator projection. Roster members, peer-to-wallet bindings,
    // private provider identities and private target errors are excluded.
    rfc64Catalog: Object.freeze({
      enabled: catalog.enabled,
      selectedContextGraphs: catalog.selectedContextGraphs,
      selectedPublicContextGraphs: catalog.selectedPublicContextGraphs,
      selectedPrivateContextGraphs: catalog.selectedPrivateContextGraphs,
      runtimeSelection: runtime.runtimeSelection,
      responsibilities: runtime.responsibilities,
      authorityRpcCircuit: runtime.authorityRpcCircuit,
      contextGraphs: runtime.contextGraphs,
      shadowExecution: catalog.enabled ? runtime.shadowExecution : null,
      configuration,
      autoPublishEnabled: catalog.autoPublish !== undefined,
      rollout,
      privateAuthorityConfigured: catalog.accessPolicyAuthority !== undefined,
      privateRecovery,
      resourceTelemetry:
        catalog.selectedPrivateContextGraphs.length === 0 || runtime.service === null
          ? null
          : Object.freeze({
              providerAttempts: runtime.service.receiver.providerAttempts,
              providerSwitches: runtime.service.receiver.providerSwitches,
              providerSuccesses: runtime.service.receiver.providerSuccesses,
              providerBackoffMs: runtime.service.receiver.providerBackoffMs,
              controlObjectCacheHits: runtime.service.nativeReceiver?.controlObjectCacheHits ?? 0,
              controlObjectNetworkFetches:
                runtime.service.nativeReceiver?.controlObjectNetworkFetches ?? 0,
              kaBundleCacheHits: runtime.service.nativeReceiver?.kaBundleCacheHits ?? 0,
              kaBundleNetworkFetches: runtime.service.nativeReceiver?.kaBundleNetworkFetches ?? 0,
              kaBundleCacheBytes: runtime.service.nativeReceiver?.kaBundleCacheBytes ?? 0,
              kaBundleNetworkBytes: runtime.service.nativeReceiver?.kaBundleNetworkBytes ?? 0,
            }),
    }),
  });
}

export type Rfc64CatalogStatusSnapshotV1 = Awaited<
  ReturnType<typeof buildRfc64CatalogStatusSnapshotV1>
>;
