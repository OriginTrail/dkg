// SPDX-License-Identifier: Apache-2.0

import type { ExecutedRuntimeManifestV1, RuntimeProcessProvenanceV2 } from
  '../../../../devnet/rfc64-runtime-provenance.mts';
import type { Digest32V1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import {
  RFC64_PRIVATE_RUNTIME_ROLES_V1,
  RFC64_PRIVATE_SCENARIO_PROCESS_IDS_V1,
  type Rfc64PrivateRuntimeRoleV1,
  type Rfc64PrivateScenarioProcessIdV1,
} from './scenario-actors.ts';

export type Rfc64PrivateDigestV1 = Digest32V1;
export type Rfc64PrivateAddressV1 = EvmAddressV1;

export interface Rfc64PrivatePublishedCatalogV1 {
  readonly catalogVersion: string;
  readonly headObjectDigest: Rfc64PrivateDigestV1;
  readonly inventoryRowCount: string;
  readonly policyDigest: Rfc64PrivateDigestV1;
  readonly scopeDigest: Rfc64PrivateDigestV1;
}

export interface Rfc64PrivateBootstrapEvidenceV1 {
  readonly appliedHeadDigest: Rfc64PrivateDigestV1;
  readonly appliedTransferProviderPeerId: string | null;
  readonly attempts: number;
  readonly catalogVersion: string;
  readonly inventoryRowCount: string;
  readonly outcome: 'applied' | 'already-applied';
  readonly providerPeerId: string | null;
}

export interface Rfc64PrivateLayerHeadEvidenceV1 {
  readonly assertionGraph: string;
  readonly assertionVersion: string;
}

export type Rfc64PrivateSwmProofV1 = Readonly<
  | { readonly kind: 'absent' }
  | {
    readonly assertionGraph: string;
    readonly assertionVersion: string;
    readonly kind: 'workspace-head';
    readonly shareOperationId: string;
  }
  | {
    readonly assertionVersion: string;
    readonly catalogHeadDigest: Rfc64PrivateDigestV1;
    readonly kaId: string;
    readonly kind: 'catalog-row';
    readonly projectionDigest: string;
  }
>;

export interface Rfc64PrivateMemoryRowEvidenceV1 {
  readonly kaNumber: number;
  readonly kaUal: string;
  readonly swm: number;
  readonly swmDigest: string;
  readonly swmGraph: string;
  readonly swmProof: Rfc64PrivateSwmProofV1;
  readonly vm: number;
  readonly vmDigest: string;
  readonly vmGraph: string;
  readonly vmHead: Readonly<Rfc64PrivateLayerHeadEvidenceV1> | null;
}

export type Rfc64PrivateRpcMethodV1 =
  | 'eth_blockNumber'
  | 'eth_call'
  | 'eth_chainId'
  | 'eth_getBlockByNumber'
  | 'eth_getCode';

export type Rfc64PrivateRpcCallCountsV1 = Readonly<
  Partial<Record<Rfc64PrivateRpcMethodV1, number>>
>;

export interface Rfc64PrivateGraphCountEvidenceV1 {
  readonly kaNumber: number;
  readonly swm: number;
  readonly vm: number;
}

export interface Rfc64PrivateCatalogInspectionStateV1 {
  readonly appliedHeadDigest: Rfc64PrivateDigestV1 | null;
  readonly catalogScopeDigest: Rfc64PrivateDigestV1;
  readonly catalogVersion: string | null;
  readonly exactExpectedHead: boolean | null;
  readonly graphCounts: readonly Readonly<Rfc64PrivateGraphCountEvidenceV1>[];
  readonly inventoryRowCount: string | null;
  readonly outsiderVisibleVmBindings: number | null;
  readonly receiverStats: Readonly<{ readonly applied: number; readonly failed: number }> | null;
  readonly rpcCallCounts: Rfc64PrivateRpcCallCountsV1;
  readonly rpcCalls: number;
}

export interface Rfc64PrivateCatalogStateV1
  extends Rfc64PrivateCatalogInspectionStateV1 {
  readonly graphCounts: readonly Readonly<Rfc64PrivateMemoryRowEvidenceV1>[];
}

export interface Rfc64PrivateDenialEvidenceV1 {
  readonly applied: false;
  readonly denied: true;
  readonly failureClass:
    | 'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1'
    | 'Rfc64PublicCatalogNativeTransportErrorV1';
  readonly failureCode:
    | 'catalog-discovery-policy-denied'
    | 'catalog-native-policy-denied';
}

export interface Rfc64PrivateOwnerRevocationEvidenceV1 {
  readonly chainRosterVersion: string;
  readonly policyDigest: Rfc64PrivateDigestV1;
  readonly previousChainRosterVersion: string;
  readonly revokedAgentAddress: Rfc64PrivateAddressV1;
}

export interface Rfc64PrivateProviderRevocationEvidenceV1
  extends Rfc64PrivateOwnerRevocationEvidenceV1 {
  readonly curatorMetadataRefreshed: true;
  readonly effectiveRosterVersion: string;
  readonly localRosterVersion: string;
  readonly providerMutationDenied: true;
}

export interface Rfc64PrivateReadyEvidenceV1 {
  readonly agentClass: 'DKGAgent';
  readonly catalogServiceStarted: boolean;
  readonly event: 'ready';
  readonly peerId: string;
  readonly role: Rfc64PrivateRuntimeRoleV1;
  readonly runtimeBuildManifestDigest?: Rfc64PrivateDigestV1;
  readonly multiaddr?: string;
  readonly requestId?: string;
  readonly authoritySource?: 'finalized-chain';
  readonly authorityPolicyDigest?: Rfc64PrivateDigestV1;
  readonly authorityRosterVersion?: string;
  readonly authorityMembers?: readonly Rfc64PrivateAddressV1[];
}

export interface Rfc64PrivateProcessExitEvidenceV1 {
  readonly code: number | null;
  readonly error: null;
  readonly exitedAt: string;
  readonly signal: NodeJS.Signals | null;
}

export interface Rfc64PrivateShutdownEvidenceV1 {
  readonly executedRuntimeManifest: Readonly<ExecutedRuntimeManifestV1>;
  readonly exit: Readonly<Rfc64PrivateProcessExitEvidenceV1>;
  readonly rpcCallCounts: Rfc64PrivateRpcCallCountsV1;
}

export interface Rfc64PrivateProcessEvidenceV1 {
  readonly exitSequence: number;
  readonly processId: Rfc64PrivateScenarioProcessIdV1;
  readonly ready: Readonly<Rfc64PrivateReadyEvidenceV1>;
  readonly role: Rfc64PrivateRuntimeRoleV1;
  readonly shutdown: Readonly<Rfc64PrivateShutdownEvidenceV1>;
  readonly spawnedAt: string;
  readonly spawnSequence: number;
}

export type Rfc64PrivatePeerIdMapV1 = Readonly<
  Record<Rfc64PrivateRuntimeRoleV1, string>
>;

export type Rfc64PrivateProcessEvidenceMapV1 = Readonly<{
  [ProcessId in Rfc64PrivateScenarioProcessIdV1]: Readonly<Rfc64PrivateProcessEvidenceV1>;
}>;

export type Rfc64PrivateRuntimeProvenanceEvidenceV2 = Readonly<
  RuntimeProcessProvenanceV2<
    Rfc64PrivateScenarioProcessIdV1,
    'dkg-rfc64-private-runtime-provenance-v2'
  >
>;

export interface Rfc64PrivateBaselineResultV1 {
  readonly baseline: Readonly<Rfc64PrivatePublishedCatalogV1>;
  readonly ownerSourceState: Readonly<Rfc64PrivateCatalogStateV1>;
  readonly provider2Bootstrap: Readonly<Rfc64PrivateBootstrapEvidenceV1>;
  readonly provider2State: Readonly<Rfc64PrivateCatalogStateV1>;
  readonly published: Readonly<Rfc64PrivatePublishedCatalogV1>;
  readonly receiverSeedBootstrap: Readonly<Rfc64PrivateBootstrapEvidenceV1>;
  readonly receiverSeedState: Readonly<Rfc64PrivateCatalogStateV1>;
}

export interface Rfc64PrivateFailoverResultV1 {
  readonly ownerListenerClosed: boolean;
  readonly provider2ListenerDialable: boolean;
  readonly provider2StateAfterOwnerExit: Readonly<Rfc64PrivateCatalogStateV1>;
  readonly receiverBootstrap: Readonly<Rfc64PrivateBootstrapEvidenceV1>;
  readonly receiverState: Readonly<Rfc64PrivateCatalogStateV1>;
}

export interface Rfc64PrivateRevocationResultV1 {
  readonly outsiderDenial: Readonly<Rfc64PrivateDenialEvidenceV1>;
  readonly outsiderState: Readonly<Rfc64PrivateCatalogInspectionStateV1>;
  readonly ownerRevocation: Readonly<Rfc64PrivateOwnerRevocationEvidenceV1>;
  readonly provider2StateAfterRevocation: Readonly<Rfc64PrivateCatalogStateV1>;
  readonly providerAccessState: Readonly<Rfc64PrivateCatalogStateV1>;
  readonly receiverRevocation: Readonly<Rfc64PrivateProviderRevocationEvidenceV1>;
  readonly receiverStateAfterRevocation: Readonly<Rfc64PrivateCatalogStateV1>;
  readonly revokedReceiverDenial: Readonly<Rfc64PrivateDenialEvidenceV1>;
}

export interface Rfc64PrivateRestartResultV1 {
  readonly restartState: Readonly<Rfc64PrivateCatalogStateV1>;
}

export interface Rfc64PrivateScenarioPhasesV1 {
  readonly baseline: Readonly<Rfc64PrivateBaselineResultV1>;
  readonly failover: Readonly<Rfc64PrivateFailoverResultV1>;
  readonly restart: Readonly<Rfc64PrivateRestartResultV1>;
  readonly revocation: Readonly<Rfc64PrivateRevocationResultV1>;
}

export interface Rfc64PrivateScenarioResultV1 {
  readonly peerIds: Rfc64PrivatePeerIdMapV1;
  readonly phases: Readonly<Rfc64PrivateScenarioPhasesV1>;
  readonly processes: Rfc64PrivateProcessEvidenceMapV1;
  readonly runtimeProvenance: Rfc64PrivateRuntimeProvenanceEvidenceV2;
}

/** Parent commands and their typed child results form the live scenario producer boundary. */
export type Rfc64PrivateChildCommandV1 = Readonly<
  | { readonly cmd: 'dial'; readonly multiaddr: string; readonly peerId: string }
  | { readonly cmd: 'publish' | 'publish-update' }
  | {
    readonly cmd: 'wait-bootstrap';
    readonly expectedHeadDigest: Rfc64PrivateDigestV1;
    readonly expectedMemory?: 'finalized-vm-v1';
    readonly timeoutMs: number;
  }
  | {
    readonly cmd: 'inspect' | 'inspect-persisted';
    readonly expectedHeadDigest?: Rfc64PrivateDigestV1;
  }
  | { readonly cmd: 'sync-denied'; readonly providerPeerIds: readonly string[] }
  | { readonly cmd: 'revoke-receiver' | 'observe-receiver-revocation' | 'stop' }
>;

export interface Rfc64PrivateStoppingEventV1 {
  readonly event: 'stopping';
  readonly executedRuntimeManifest: Readonly<ExecutedRuntimeManifestV1>;
  readonly requestId: string;
  readonly rpcCallCounts: Rfc64PrivateRpcCallCountsV1;
}

export type Rfc64PrivateChildResultV1<
  Command extends Rfc64PrivateChildCommandV1['cmd'],
> = Command extends 'publish' | 'publish-update'
  ? Readonly<Rfc64PrivatePublishedCatalogV1>
  : Command extends 'wait-bootstrap'
    ? Readonly<Rfc64PrivateBootstrapEvidenceV1>
    : Command extends 'inspect' | 'inspect-persisted'
      ? Readonly<Rfc64PrivateCatalogStateV1>
      : Command extends 'sync-denied'
        ? Readonly<Rfc64PrivateDenialEvidenceV1>
        : Command extends 'revoke-receiver'
          ? Readonly<Rfc64PrivateOwnerRevocationEvidenceV1>
          : Command extends 'observe-receiver-revocation'
            ? Readonly<Rfc64PrivateProviderRevocationEvidenceV1>
            : Command extends 'stop'
              ? Readonly<Rfc64PrivateStoppingEventV1>
              : Readonly<Record<string, unknown>>;

const PHASE_FIELDS = Object.freeze({
  baseline: Object.freeze([
    'baseline',
    'ownerSourceState',
    'provider2Bootstrap',
    'provider2State',
    'published',
    'receiverSeedBootstrap',
    'receiverSeedState',
  ]),
  failover: Object.freeze([
    'ownerListenerClosed',
    'provider2ListenerDialable',
    'provider2StateAfterOwnerExit',
    'receiverBootstrap',
    'receiverState',
  ]),
  restart: Object.freeze(['restartState']),
  revocation: Object.freeze([
    'outsiderDenial',
    'outsiderState',
    'ownerRevocation',
    'provider2StateAfterRevocation',
    'providerAccessState',
    'receiverRevocation',
    'receiverStateAfterRevocation',
    'revokedReceiverDenial',
  ]),
} as const);

/** Seal the scenario's one typed, named result instead of an open string-key bag. */
export function composeRfc64PrivateScenarioResultV1(
  input: Readonly<Rfc64PrivateScenarioResultV1>,
): Readonly<Rfc64PrivateScenarioResultV1> {
  assertExactKeys(
    input.peerIds,
    RFC64_PRIVATE_RUNTIME_ROLES_V1,
    'private scenario peer identities',
  );
  assertExactKeys(input.phases, Object.keys(PHASE_FIELDS), 'private scenario phases');
  for (const [phase, fields] of Object.entries(PHASE_FIELDS)) {
    const value = input.phases[phase as keyof Rfc64PrivateScenarioPhasesV1];
    assertExactKeys(value, fields, `private scenario ${phase} result`);
  }
  assertExactKeys(
    input.processes,
    RFC64_PRIVATE_SCENARIO_PROCESS_IDS_V1,
    'private scenario processes',
  );
  for (const processId of RFC64_PRIVATE_SCENARIO_PROCESS_IDS_V1) {
    if (input.processes[processId].processId !== processId) {
      throw new TypeError(`private scenario process ${processId} has a mismatched identity`);
    }
  }
  return Object.freeze({
    peerIds: Object.freeze({ ...input.peerIds }),
    phases: Object.freeze({ ...input.phases }),
    processes: Object.freeze({ ...input.processes }),
    runtimeProvenance: input.runtimeProvenance,
  });
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (keys.length !== canonicalExpected.length
    || keys.some((key, index) => key !== canonicalExpected[index])) {
    throw new TypeError(`${label} must contain exactly ${canonicalExpected.join(', ')}`);
  }
}
