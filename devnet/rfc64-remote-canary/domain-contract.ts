// SPDX-License-Identifier: Apache-2.0

import type { FromSchema } from 'json-schema-to-ts';
import type {
  REMOTE_CANARY_ERROR_CATEGORIES_V1,
  REMOTE_CANARY_ERROR_CODES_V1,
  REMOTE_CANARY_PHASES_V1,
} from './artifact-contract.mjs';
import type {
  REMOTE_CANARY_CONFIG_SCHEMA_V1,
  RPC_USAGE_EVIDENCE_SCHEMA_V1,
} from './schemas.mjs';

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type RawRemoteCanaryConfigV1 = DeepReadonly<FromSchema<
  typeof REMOTE_CANARY_CONFIG_SCHEMA_V1
>>;
export type RpcUsageEvidenceV1 = DeepReadonly<FromSchema<
  typeof RPC_USAGE_EVIDENCE_SCHEMA_V1
>>;
export type RpcUsageSampleV1 = Readonly<RpcUsageEvidenceV1['samples'][number]>;
export type RemoteCanaryErrorCodeV1 = typeof REMOTE_CANARY_ERROR_CODES_V1[number];
export type RemoteCanaryErrorCategoryV1 = typeof REMOTE_CANARY_ERROR_CATEGORIES_V1[number];
export type RemoteCanaryPhaseV1 = typeof REMOTE_CANARY_PHASES_V1[number];

export interface RemoteCanaryTopologyV1 {
  readonly nodeCount: number;
  readonly nodes: readonly Readonly<{
    nodeRef: string;
    role: 'source' | 'receiver' | 'observer';
    authentication: 'none' | 'bearer-file';
  }>[];
  readonly contextGraphs: readonly Readonly<{
    contextGraphRef: string;
    sourceNodeRef: string;
    receiverNodeRef: string;
    expectedMode: 'catalog';
  }>[];
}

export interface RemoteCanaryDryRunPlanV1 {
  readonly preflight: 'exact-build-network-sync-and-catalog-mode';
  readonly liveSwmPropagationChecks: number;
  readonly offlineCatchup: 'PLANNED' | 'EVIDENCE_REQUIRED';
  readonly vmParityChecks: number;
  readonly vmParityEvidence: 'PLANNED' | 'EVIDENCE_REQUIRED';
  readonly catalogSwmEvidence: 'PLANNED' | 'EVIDENCE_REQUIRED';
  readonly authorization: Readonly<{
    unauthorized: 'PLANNED' | 'EVIDENCE_REQUIRED';
    revoked: 'PLANNED' | 'EVIDENCE_REQUIRED';
  }>;
  readonly rpcUsage: 'PLANNED' | 'EVIDENCE_REQUIRED';
}

export type RemoteCanaryLiveSwmResultV1 = readonly Readonly<{
  contextGraphRef: string;
  markerRef: string;
  status: 'PASS';
}>[];
export type RemoteCanaryOfflineCatchupResultV1 =
  | Readonly<{ status: 'EVIDENCE_REQUIRED'; requirement: 'single-receiver-stop-start' }>
  | Readonly<{
      status: 'PASS';
      receiverCount: 1;
      contextGraphs: RemoteCanaryLiveSwmResultV1;
    }>;
export type RemoteCanaryVmParityResultV1 = readonly (
  | Readonly<{
      contextGraphRef: string;
      status: 'PASS';
      statusParity: 'PASS';
      cursorPresent: true;
      digestParity: true;
      rowCountParity: true;
      vmQueryChecked: true;
    }>
  | Readonly<{
      contextGraphRef: string;
      status: 'EVIDENCE_REQUIRED';
      statusParity: 'PASS';
      cursorPresent: true;
      digestParity: true;
      rowCountParity: true;
      vmQueryChecked: false;
      requirement: 'vm-ask-query';
    }>
)[];
export type RemoteCanaryCatalogSwmResultV1 = readonly (
  | Readonly<{
      contextGraphRef: string;
      status: 'PASS';
      queryChecked: true;
      sourceQueryPassed: true;
      receiverQueryPassed: true;
    }>
  | Readonly<{
      contextGraphRef: string;
      status: 'EVIDENCE_REQUIRED';
      requirement: 'known-catalog-swm-ask-query';
      queryChecked: false;
    }>
)[];
export type RemoteCanaryAuthorizationCheckResultV1 =
  | Readonly<{ status: 'PASS'; denialObserved: true }>
  | Readonly<{
      status: 'EVIDENCE_REQUIRED';
      reasonCode: 'catalog-protocol-api-not-exposed' | 'revocation-api-not-exposed';
    }>;
export interface RemoteCanaryAuthorizationResultV1 {
  readonly unauthorized: RemoteCanaryAuthorizationCheckResultV1;
  readonly revoked: RemoteCanaryAuthorizationCheckResultV1;
}
export type RemoteCanaryRpcUsageResultV1 =
  | Readonly<{
      status: 'EVIDENCE_REQUIRED';
      requirement: 'dkg-rpc-usage-minutes-v1';
      acceptedSources: readonly ['evidence-file', 'command'];
    }>
  | Readonly<{
      status: 'PASS';
      source: 'evidence-file' | 'command';
      cohortRef: string;
      windowStartedAt: string;
      windowEndedAt: string;
      sampleCount: number;
      measuredSeconds: number;
      total: number;
      requestsPerMinute: number;
      byMethod: Readonly<Record<string, number>>;
    }>;
export interface RemoteCanaryChecksV1 {
  readonly liveSwmPropagation: RemoteCanaryLiveSwmResultV1;
  readonly offlineCatchup: RemoteCanaryOfflineCatchupResultV1;
  readonly vmParity: RemoteCanaryVmParityResultV1;
  readonly catalogSwm: RemoteCanaryCatalogSwmResultV1;
  readonly authorization: RemoteCanaryAuthorizationResultV1;
  readonly rpcUsage: RemoteCanaryRpcUsageResultV1;
}
export type RemoteCanaryPassChecksV1 = Readonly<{
  liveSwmPropagation: RemoteCanaryLiveSwmResultV1;
  offlineCatchup: Extract<RemoteCanaryOfflineCatchupResultV1, { status: 'PASS' }>;
  vmParity: readonly Extract<RemoteCanaryVmParityResultV1[number], { status: 'PASS' }>[];
  catalogSwm: readonly Extract<RemoteCanaryCatalogSwmResultV1[number], { status: 'PASS' }>[];
  authorization: Readonly<{
    unauthorized: Extract<RemoteCanaryAuthorizationCheckResultV1, { status: 'PASS' }>;
    revoked: Extract<RemoteCanaryAuthorizationCheckResultV1, { status: 'PASS' }>;
  }>;
  rpcUsage: Extract<RemoteCanaryRpcUsageResultV1, { status: 'PASS' }>;
}>;
export interface RemoteCanaryPreflightEvidenceV1 {
  readonly status: 'PASS';
  readonly nodes: readonly Readonly<{
    nodeRef: string;
    role: 'source' | 'receiver' | 'observer';
    commit: string;
    chainId: string;
    syncReconcilerEnabled: true;
    catalogServiceEnabled: true;
    contextGraphs: readonly Readonly<{
      contextGraphRef: string;
      mode: 'catalog';
      legacySyncAllowed: false;
    }>[];
  }>[];
}

interface RemoteCanaryCompletedCertificateBaseV1<
  Checks extends RemoteCanaryChecksV1 = RemoteCanaryChecksV1,
> {
  readonly schema: 'dkg-rfc64-remote-canary-certificate-v1';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly expectedCommit: string;
  readonly cohortRef: string;
  readonly topology: RemoteCanaryTopologyV1;
  readonly preflight: RemoteCanaryPreflightEvidenceV1;
  readonly checks: Checks;
}
export type CompletedRemoteCanaryCertificateV1 =
  RemoteCanaryCompletedCertificateBaseV1<RemoteCanaryPassChecksV1> & Readonly<{
    status: 'PASS';
    phase: 'complete';
  }>;
export type IncompleteRemoteCanaryCertificateV1 =
  RemoteCanaryCompletedCertificateBaseV1 & Readonly<{
    status: 'INCOMPLETE';
    phase: 'evidence-required';
  }>;
export interface RemoteCanaryDryRunCertificateV1 {
  readonly schema: 'dkg-rfc64-remote-canary-certificate-v1';
  readonly status: 'DRY_RUN';
  readonly phase: 'planned';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly expectedCommit: string;
  readonly cohortRef: string;
  readonly topology: RemoteCanaryTopologyV1;
  readonly plan: RemoteCanaryDryRunPlanV1;
}
export interface StartingRemoteCanaryCertificateV1 {
  readonly schema: 'dkg-rfc64-remote-canary-certificate-v1';
  readonly status: 'INCOMPLETE';
  readonly phase: 'starting';
  readonly startedAt: string;
}
export interface FailedRemoteCanaryCertificateV1 {
  readonly schema: 'dkg-rfc64-remote-canary-certificate-v1';
  readonly status: 'FAIL';
  readonly phase: RemoteCanaryPhaseV1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly failure: Readonly<{ code: RemoteCanaryErrorCodeV1 }>;
}
export type RemoteCanaryCertificateV1 =
  | StartingRemoteCanaryCertificateV1
  | RemoteCanaryDryRunCertificateV1
  | CompletedRemoteCanaryCertificateV1
  | IncompleteRemoteCanaryCertificateV1
  | FailedRemoteCanaryCertificateV1;

export type RawCanaryNodeV1 = Readonly<RawRemoteCanaryConfigV1['nodes'][number]>;
export type RawCanaryAuthenticationV1 = Readonly<RawCanaryNodeV1['auth']>;
export type RawCanaryContextGraphV1 = Readonly<
  RawRemoteCanaryConfigV1['contextGraphs'][number]
>;
export type RawCanaryLifecycleV1 = Readonly<NonNullable<
  RawRemoteCanaryConfigV1['lifecycle']
>>;
export type RawCanaryAuthorizationCheckV1 = Readonly<
  RawRemoteCanaryConfigV1['authorizationChecks']['unauthorized']
>;
export type RawCanaryRpcUsageV1 = Readonly<RawRemoteCanaryConfigV1['rpcUsage']>;
export type RawCanaryTimingV1 = Readonly<NonNullable<RawRemoteCanaryConfigV1['timing']>>;
export type CanaryCommandV1 = Readonly<RawCanaryLifecycleV1['stop']>;

export type NormalizedCanaryNodeV1 = Readonly<RawCanaryNodeV1 & {
  readonly nodeRef: string;
}>;

export type NormalizedCanaryContextGraphV1 = Readonly<RawCanaryContextGraphV1 & {
  readonly source: NormalizedCanaryNodeV1;
  readonly receiver: NormalizedCanaryNodeV1;
  readonly contextGraphRef: string;
}>;

export interface NormalizedCanaryLifecycleV1 {
  readonly receiverNodeId: string;
  readonly receiver: NormalizedCanaryNodeV1;
  readonly stop: CanaryCommandV1;
  readonly start: CanaryCommandV1;
  readonly commandTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly readyTimeoutMs: number;
}

export type NormalizedCanaryAuthorizationCheckV1 =
  | Extract<RawCanaryAuthorizationCheckV1, { kind: 'not-exposed' }>
  | Readonly<Omit<Extract<RawCanaryAuthorizationCheckV1, { kind: 'http' }>, 'body'> & {
      readonly body?: Readonly<{ [key: string]: JsonValue }>;
      node: NormalizedCanaryNodeV1;
      notFoundControlNode?: NormalizedCanaryNodeV1;
    }>;

export type NormalizedCanaryRpcUsageV1 =
  | Extract<RawCanaryRpcUsageV1, { kind: 'required' }>
  | Readonly<Omit<Extract<RawCanaryRpcUsageV1, { kind: 'evidence-file' }>, 'minimumSamples'> & {
      readonly minimumSamples: number;
    }>
  | Readonly<Omit<
      Extract<RawCanaryRpcUsageV1, { kind: 'command' }>,
      'minimumSamples' | 'commandTimeoutMs'
    > & {
      readonly minimumSamples: number;
      readonly commandTimeoutMs: number;
    }>;

export interface NormalizedCanaryTimingV1 {
  readonly requestTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly propagationTimeoutMs: number;
  readonly catchupTimeoutMs: number;
  readonly parityTimeoutMs: number;
}

export interface NormalizedRemoteCanaryConfigV1 {
  readonly schema: 'dkg-rfc64-remote-canary-config-v1';
  readonly expectedCommit: string;
  readonly nodes: readonly NormalizedCanaryNodeV1[];
  readonly contextGraphs: readonly NormalizedCanaryContextGraphV1[];
  readonly lifecycle: NormalizedCanaryLifecycleV1 | null;
  readonly authorizationChecks: Readonly<{
    unauthorized: NormalizedCanaryAuthorizationCheckV1;
    revoked: NormalizedCanaryAuthorizationCheckV1;
  }>;
  readonly rpcUsage: NormalizedCanaryRpcUsageV1;
  readonly timing: NormalizedCanaryTimingV1;
}

export interface CanaryCommandResultV1 {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
}

export interface CanaryHttpResponseV1 {
  readonly status: number;
  readonly text: string;
}

export interface CanaryRequesterV1 {
  raw(
    node: NormalizedCanaryNodeV1,
    method: string,
    path: string,
    body?: unknown,
    authentication?: 'node' | 'none',
  ): Promise<CanaryHttpResponseV1>;
  json(
    node: NormalizedCanaryNodeV1,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown>;
  reachable(node: NormalizedCanaryNodeV1): Promise<boolean>;
}

export interface CanaryAskQueryV1 {
  readonly contextGraphId: string;
  readonly sparql: string;
  readonly view: 'shared-working-memory' | 'verifiable-memory';
}

export interface CanarySwmMarkerShareV1 {
  readonly contextGraphId: string;
  readonly name: string;
  readonly quads: readonly Readonly<{
    subject: string;
    predicate: string;
    object: string;
  }>[];
  readonly alsoShareSwm: true;
}

export interface CanaryAuthorizationProbeV1 {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Readonly<{ [key: string]: JsonValue }>;
  readonly authentication: 'node' | 'none';
}

export interface CanaryAuthorizationProbeResponseV1 {
  readonly status: number;
  readonly body: unknown;
}

export interface CanaryNodeClientV1 {
  readCertificationStatus(
    node: NormalizedCanaryNodeV1,
  ): Promise<Readonly<import('@origintrail-official/dkg-agent').Rfc64DaemonCertificationStatusV1>>;
  askQuery(node: NormalizedCanaryNodeV1, query: CanaryAskQueryV1): Promise<boolean>;
  shareSwmMarker(
    node: NormalizedCanaryNodeV1,
    marker: CanarySwmMarkerShareV1,
  ): Promise<boolean>;
  reachable(node: NormalizedCanaryNodeV1): Promise<boolean>;
  probeAuthorization(
    node: NormalizedCanaryNodeV1,
    probe: CanaryAuthorizationProbeV1,
  ): Promise<Readonly<CanaryAuthorizationProbeResponseV1>>;
  probeAuthorizationControl(
    node: NormalizedCanaryNodeV1,
    probe: CanaryAuthorizationProbeV1,
  ): Promise<number>;
}

export interface RemoteCanaryDependenciesV1 {
  readonly fetchFn?: typeof fetch;
  readonly readFileFn?: (path: string, encoding: BufferEncoding) => Promise<string>;
  readonly runCommand?: (
    command: CanaryCommandV1,
    timeoutMs?: number,
  ) => Promise<CanaryCommandResultV1>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
}

export function assertNever(value: never): never {
  throw new TypeError(`Unhandled RFC-64 canary discriminant: ${String(value)}`);
}
