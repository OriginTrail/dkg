// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  sanitizeRfc64CatalogShadowExecutionStatusV1,
} from '@origintrail-official/dkg-agent';
import {
  rfc64CatalogKillSwitchActiveV1,
  rfc64CatalogRolloutModeForContextGraphV1,
} from '@origintrail-official/dkg-agent/rfc64/public-catalog-activation-config-v1';

import type {
  DkgConfig,
  ResolvedRfc64CatalogActivationConfig,
  ResolvedRfc64PublicCatalogActivationConfig,
} from '../../config.js';

/** Narrow read-only agent capability used by the public RFC-64 status facade. */
export interface Rfc64StatusReaderV1 {
  readonly rfc64PublicCatalogStatsV1?:
    OmitThisParameter<DKGAgent['rfc64PublicCatalogStatsV1']>;
  readonly readRfc64PublicCatalogBootstrapStatusV1?:
    OmitThisParameter<DKGAgent['readRfc64PublicCatalogBootstrapStatusV1']>;
  readonly readRfc64CatalogRuntimeSelectionV1?:
    OmitThisParameter<DKGAgent['readRfc64CatalogRuntimeSelectionV1']>;
  readonly readRfc64CatalogExecutionSelectionV1:
    OmitThisParameter<DKGAgent['readRfc64CatalogExecutionSelectionV1']>;
  readonly readRfc64CatalogResponsibilitiesV1?:
    OmitThisParameter<DKGAgent['readRfc64CatalogResponsibilitiesV1']>;
  readonly readRfc64AuthorityRpcCircuitSnapshotV1?:
    OmitThisParameter<DKGAgent['readRfc64AuthorityRpcCircuitSnapshotV1']>;
  readonly readRfc64CatalogOperationalStatusV1?:
    OmitThisParameter<DKGAgent['readRfc64CatalogOperationalStatusV1']>;
  readonly readRfc64CatalogShadowExecutionStatusV1?:
    OmitThisParameter<DKGAgent['readRfc64CatalogShadowExecutionStatusV1']>;
}

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

/**
 * Privacy-safe attestation of the startup controls that selected RFC-64.
 * Private graph ids and policy material participate in the digest but never
 * leave the node; a release harness can still prove the clean omission case.
 */
export function buildRfc64CatalogConfigurationEvidenceV1(
  config: Pick<DkgConfig, 'rfc64Catalog' | 'rfc64PublicCatalog'>,
  effectiveRollout: Readonly<{
    killSwitch: boolean;
    defaultMode?: 'legacy' | 'shadow' | 'catalog';
    contextGraphModes: Readonly<Record<string, 'legacy' | 'shadow' | 'catalog'>>;
  }>,
  executionSelection: Readonly<{
    activationSource: Rfc64CatalogConfigurationEvidenceV1['source'];
    responsibilityDefaultMode: 'legacy' | 'shadow' | 'catalog';
  }>,
): Rfc64CatalogConfigurationEvidenceV1 {
  const catalogControlPresent = config.rfc64Catalog !== undefined;
  const deprecatedPublicControlPresent = config.rfc64PublicCatalog !== undefined;
  const catalog = config.rfc64Catalog;
  const publicCatalog = config.rfc64PublicCatalog;
  const deprecatedDisabledOverride = catalog?.enabled === false
    || (catalog === undefined && publicCatalog?.enabled === false);
  const activationManifestPresent = catalog?.bootstrap !== undefined
    || publicCatalog?.bootstrap !== undefined;
  const modes = Object.entries(effectiveRollout.contextGraphModes)
    .sort(([left], [right]) => left.localeCompare(right));
  const defaultMode = executionSelection.responsibilityDefaultMode;
  const source = executionSelection.activationSource;
  const digestPayload = {
    schemaVersion: 1,
    catalogControlPresent,
    deprecatedPublicControlPresent,
    activationManifestPresent,
    deprecatedDisabledOverride,
    killSwitch: effectiveRollout.killSwitch,
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
    killSwitch: effectiveRollout.killSwitch,
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

/**
 * Collect and project both RFC-64 status surfaces behind one compatibility and
 * privacy boundary. HTTP routes insert these completed blocks without probing
 * feature-specific agent methods or forwarding provider-owned objects.
 */
export async function buildRfc64StatusBlocksV1(input: Readonly<{
  config: Pick<DkgConfig, 'rfc64Catalog' | 'rfc64PublicCatalog'>;
  catalogActivation?: ResolvedRfc64CatalogActivationConfig;
  publicCatalogActivation: ResolvedRfc64PublicCatalogActivationConfig;
  agent: Rfc64StatusReaderV1;
}>) {
  const {
    config,
    publicCatalogActivation,
    agent,
  } = input;
  const catalogActivation = input.catalogActivation ?? {
    enabled: publicCatalogActivation.enabled,
    selectedContextGraphs: publicCatalogActivation.selectedContextGraphs,
    selectedPublicContextGraphs: publicCatalogActivation.selectedContextGraphs,
    selectedPrivateContextGraphs: [],
    selectedCatalogAuthoringControls: [],
    accessPolicyAuthority: undefined,
    bootstrap: undefined,
    autoPublish: publicCatalogActivation.autoPublish,
    rollout: publicCatalogActivation.rollout,
  };
  const rollout = catalogActivation.rollout ?? {
    // Compatibility for older direct JS embedders that supply the pre-rollout
    // resolved shape at the package boundary.
    killSwitch: rfc64CatalogKillSwitchActiveV1(catalogActivation),
    defaultMode: 'catalog' as const,
    contextGraphModes: Object.fromEntries(
      catalogActivation.selectedContextGraphs.map((contextGraphId) => [
        contextGraphId,
        rfc64CatalogRolloutModeForContextGraphV1(catalogActivation, contextGraphId),
      ]),
    ),
  };
  const configuration = buildRfc64CatalogConfigurationEvidenceV1(
    config,
    rollout,
    agent.readRfc64CatalogExecutionSelectionV1(),
  );
  const service = catalogActivation.enabled
    && typeof agent.rfc64PublicCatalogStatsV1 === 'function'
    ? agent.rfc64PublicCatalogStatsV1()
    : null;
  const bootstrapStatus = catalogActivation.enabled
    && typeof agent.readRfc64PublicCatalogBootstrapStatusV1 === 'function'
    ? agent.readRfc64PublicCatalogBootstrapStatusV1()
    : null;
  const runtimeSelection = typeof agent.readRfc64CatalogRuntimeSelectionV1 === 'function'
    ? agent.readRfc64CatalogRuntimeSelectionV1()
    : {
        subscriptionDriven: false,
        eligibleContextGraphs: catalogActivation.selectedContextGraphs,
        selectedContextGraphs: catalogActivation.selectedContextGraphs,
      };
  const responsibilities = typeof agent.readRfc64CatalogResponsibilitiesV1 === 'function'
    ? agent.readRfc64CatalogResponsibilitiesV1()
    : [];
  const authorityRpcCircuit =
    typeof agent.readRfc64AuthorityRpcCircuitSnapshotV1 === 'function'
      ? sanitizeRfc64AuthorityRpcCircuitSnapshotV1(
          agent.readRfc64AuthorityRpcCircuitSnapshotV1(),
        )
      : null;
  const contextGraphs = typeof agent.readRfc64CatalogOperationalStatusV1 === 'function'
    ? await agent.readRfc64CatalogOperationalStatusV1()
    : [];
  const shadowExecution = catalogActivation.enabled
    && typeof agent.readRfc64CatalogShadowExecutionStatusV1 === 'function'
    ? sanitizeRfc64CatalogShadowExecutionStatusV1(
        agent.readRfc64CatalogShadowExecutionStatusV1(),
      )
    : null;
  const selectedPublicContextGraphs = new Set(
    catalogActivation.selectedPublicContextGraphs,
  );
  const publicBootstrap = publicCatalogActivation.enabled && bootstrapStatus !== null
    ? {
        ...bootstrapStatus,
        // Keep the compatibility surface public-only. The shared runtime
        // status also contains private targets and provider identities.
        targets: bootstrapStatus.targets.filter(
          ({ scope }) => selectedPublicContextGraphs.has(scope.contextGraphId),
        ),
      }
    : null;
  const privateRecovery = catalogActivation.selectedPrivateContextGraphs.map(
    (contextGraphId) => {
      const targets = bootstrapStatus?.targets.filter(
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
      const accepted = catalogActivation.bootstrap?.acceptedPolicies.find(
        ({ policyEnvelope }) => policyEnvelope.payload.contextGraphId === contextGraphId,
      );
      return {
        contextGraphId,
        mode: rfc64CatalogRolloutModeForContextGraphV1(
          catalogActivation,
          contextGraphId,
        ),
        accessPolicy: accepted?.policyEnvelope.payload.accessPolicy,
        publishPolicy: accepted?.policyEnvelope.payload.publishPolicy,
        vmRequired:
          accepted?.policyEnvelope.payload.accessPolicy === 1
          && accepted.policyEnvelope.payload.source.kind === 'finalized-chain',
        targetCount: targets.length,
        outcomeCounts,
        completionReasons,
      };
    },
  );
  const completeSwmProviders = publicCatalogActivation.enabled
    ? (publicCatalogActivation.bootstrap?.acceptedPublicPolicies ?? [])
      .filter((accepted) => (accepted.completeSwmProviders?.length ?? 0) > 0)
      .map((accepted) => ({
        contextGraphId: accepted.policyEnvelope.payload.contextGraphId,
        accessPolicy: accepted.policyEnvelope.payload.accessPolicy,
        publishPolicy: accepted.policyEnvelope.payload.publishPolicy,
        providers: accepted.completeSwmProviders,
      }))
    : [];

  return Object.freeze({
    rfc64PublicCatalog: Object.freeze({
      enabled: publicCatalogActivation.enabled,
      selectedContextGraphs: publicCatalogActivation.selectedContextGraphs,
      runtimeSelection: {
        subscriptionDriven: runtimeSelection.subscriptionDriven,
        selectedContextGraphs: runtimeSelection.selectedContextGraphs.filter(
          (contextGraphId) => selectedPublicContextGraphs.has(contextGraphId),
        ),
      },
      rollout: {
        killSwitch: rollout.killSwitch,
        contextGraphModes: Object.fromEntries(
          publicCatalogActivation.selectedContextGraphs.map((contextGraphId) => [
            contextGraphId,
            rfc64CatalogRolloutModeForContextGraphV1(catalogActivation, contextGraphId),
          ]),
        ),
      },
      autoPublishEnabled: publicCatalogActivation.autoPublish !== undefined,
      completeSwmProviders,
      service,
      bootstrap: publicBootstrap,
    }),
    // Local operator projection only. Never expose roster members, peer-to-
    // wallet bindings, or private provider identities through status.
    rfc64Catalog: Object.freeze({
      enabled: catalogActivation.enabled,
      selectedContextGraphs: catalogActivation.selectedContextGraphs,
      selectedPublicContextGraphs: catalogActivation.selectedPublicContextGraphs,
      selectedPrivateContextGraphs: catalogActivation.selectedPrivateContextGraphs,
      runtimeSelection,
      responsibilities,
      authorityRpcCircuit,
      contextGraphs,
      shadowExecution,
      configuration,
      autoPublishEnabled: catalogActivation.autoPublish !== undefined,
      rollout,
      privateAuthorityConfigured: catalogActivation.accessPolicyAuthority !== undefined,
      privateRecovery,
      resourceTelemetry:
        catalogActivation.selectedPrivateContextGraphs.length === 0 || service === null
          ? null
          : {
              providerAttempts: service.receiver.providerAttempts,
              providerSwitches: service.receiver.providerSwitches,
              providerSuccesses: service.receiver.providerSuccesses,
              providerBackoffMs: service.receiver.providerBackoffMs,
              controlObjectCacheHits: service.nativeReceiver?.controlObjectCacheHits ?? 0,
              controlObjectNetworkFetches:
                service.nativeReceiver?.controlObjectNetworkFetches ?? 0,
              kaBundleCacheHits: service.nativeReceiver?.kaBundleCacheHits ?? 0,
              kaBundleNetworkFetches: service.nativeReceiver?.kaBundleNetworkFetches ?? 0,
              kaBundleCacheBytes: service.nativeReceiver?.kaBundleCacheBytes ?? 0,
              kaBundleNetworkBytes: service.nativeReceiver?.kaBundleNetworkBytes ?? 0,
            },
    }),
  });
}

const RFC64_AUTHORITY_RPC_CIRCUIT_STATES_V1 = new Set([
  'closed',
  'open',
  'half-open',
]);

/** Allow-list the public circuit DTO so version-skew cannot leak provider data. */
export function sanitizeRfc64AuthorityRpcCircuitSnapshotV1(
  input: unknown,
): Readonly<{
  state: 'closed' | 'open' | 'half-open';
  consecutiveExhaustions: number;
  retryAtMs: number | null;
}> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!RFC64_AUTHORITY_RPC_CIRCUIT_STATES_V1.has(value.state as string)) return null;
  if (
    !Number.isSafeInteger(value.consecutiveExhaustions)
    || (value.consecutiveExhaustions as number) < 0
  ) return null;
  if (
    value.retryAtMs !== null
    && (
      !Number.isSafeInteger(value.retryAtMs)
      || (value.retryAtMs as number) < 0
    )
  ) return null;
  return Object.freeze({
    state: value.state as 'closed' | 'open' | 'half-open',
    consecutiveExhaustions: value.consecutiveExhaustions as number,
    retryAtMs: value.retryAtMs as number | null,
  });
}
