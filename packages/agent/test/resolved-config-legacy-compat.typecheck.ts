import type { DKGAgentConfig } from '@origintrail-official/dkg-agent';
import type { ResolvedDKGAgentConfig as LegacyResolvedConfig } from '@origintrail-official/dkg-agent/dist/dkg-agent-types.js';
import type { ResolvedDKGAgentConfig } from '@origintrail-official/dkg-agent/dist/resolved-agent-config.js';
import type { SyncReconcilerTiming } from '@origintrail-official/dkg-agent/dist/sync/reconciler-timing.js';

// The resolved-config declaration that dist/dkg-agent-types.js published before
// resource ownership moved into `resourcePolicy`. A consumer compiled against
// it must keep compiling against the compatibility export and keep reading the
// same properties; the fields it shares with today's model are taken from the
// canonical type because they did not change.
type PreviousResolvedDKGAgentConfig =
  Omit<
    DKGAgentConfig,
    | 'storageAckTiming'
    | 'ackHandlerDeadlineMs'
    | 'ackSendTimeoutMs'
    | 'syncReconcilerIntervalMs'
    | 'syncStalenessThresholdMs'
    | 'syncBackoffBaseMs'
    | 'syncBackoffMaxMs'
    | 'syncBackoffJitter'
    | 'rfc64CatalogActivation'
    | 'rfc64CatalogActivations'
    | 'rfc64PublicCatalogActivation'
    | 'rfc64PublicCatalogAutoPublish'
    | 'rfc64PublicCatalogBootstrap'
    | 'rfc64CatalogDeploymentProfile'
    | 'contextGraphSubscriptionRehydrationEnabled'
  > & Pick<
    ResolvedDKGAgentConfig,
    | 'storageAckTiming'
    | 'rfc64CatalogDeploymentProfile'
    | 'rfc64CatalogBootstrap'
    | 'rfc64CatalogExecutionPlan'
    | 'rfc64CatalogAuthoringPolicy'
    | 'rfc64PublicCatalogBootstrap'
  > & {
    contextGraphSubscriptionRehydrationEnabled: boolean;
    syncReconcilerTiming: SyncReconcilerTiming;
  };

declare const legacy: LegacyResolvedConfig;
const previous: PreviousResolvedDKGAgentConfig = legacy;
const intervalMs: number = legacy.syncReconcilerTiming.intervalMs;
const inflight: number | undefined = legacy.syncGlobalMaxInflight;
const globalLimit: number | undefined = legacy.syncGlobalLimit;
const queueLimit: number | undefined = legacy.syncGlobalQueueLimit;
const admissionMode: 'shared' | 'partitioned' | undefined = legacy.syncAdmission?.mode;
const snapshotRows: number | undefined = legacy.syncResponderSnapshotLimits?.local?.rows;

// The compatibility export is a strict superset of the canonical runtime model.
const canonical: ResolvedDKGAgentConfig = legacy;
declare const lean: ResolvedDKGAgentConfig;
// @ts-expect-error Deprecated projections exist only on the compatibility export.
const widened: LegacyResolvedConfig = lean;

void [previous, intervalMs, inflight, globalLimit, queueLimit, admissionMode, snapshotRows, canonical, widened];
