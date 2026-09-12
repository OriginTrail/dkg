// SPDX-License-Identifier: Apache-2.0

import type { FromSchema } from 'json-schema-to-ts';
import type {
  REMOTE_CANARY_DRY_RUN_CERTIFICATE_SCHEMA_V1,
  REMOTE_CANARY_EVIDENCE_GAPS_V1,
  REMOTE_CANARY_ERROR_CATEGORIES_V1,
  REMOTE_CANARY_ERROR_CODES_V1,
  REMOTE_CANARY_FAILED_CERTIFICATE_SCHEMA_V1,
  REMOTE_CANARY_INCOMPLETE_CHECKS_SCHEMA_V1,
  REMOTE_CANARY_INCOMPLETE_CERTIFICATE_SCHEMA_V1,
  REMOTE_CANARY_PASS_CERTIFICATE_SCHEMA_V1,
  REMOTE_CANARY_PHASES_V1,
  REMOTE_CANARY_STARTING_CERTIFICATE_SCHEMA_V1,
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

/** The executable certificate schemas are the sole source for persisted artifact types. */
export type StartingRemoteCanaryCertificateV1 = DeepReadonly<FromSchema<
  typeof REMOTE_CANARY_STARTING_CERTIFICATE_SCHEMA_V1
>>;
export type RemoteCanaryDryRunCertificateV1 = DeepReadonly<FromSchema<
  typeof REMOTE_CANARY_DRY_RUN_CERTIFICATE_SCHEMA_V1
>>;
type DerivedCompletedRemoteCanaryCertificateV1 = DeepReadonly<FromSchema<
  typeof REMOTE_CANARY_PASS_CERTIFICATE_SCHEMA_V1
>>;
export type CompletedRemoteCanaryCertificateV1 = Omit<
  DerivedCompletedRemoteCanaryCertificateV1,
  'evidenceRequired'
> & Readonly<{ evidenceRequired: readonly [] }>;
type DerivedIncompleteRemoteCanaryCertificateV1 = DeepReadonly<FromSchema<
  typeof REMOTE_CANARY_INCOMPLETE_CERTIFICATE_SCHEMA_V1
>>;
export type RemoteCanaryEvidenceGapV1 = typeof REMOTE_CANARY_EVIDENCE_GAPS_V1[number];
export type IncompleteRemoteCanaryCertificateV1 = Omit<
  DerivedIncompleteRemoteCanaryCertificateV1,
  'checks' | 'evidenceRequired'
> & Readonly<{
  checks: DerivedIncompleteRemoteCanaryCertificateV1['checks'] & DeepReadonly<FromSchema<
    typeof REMOTE_CANARY_INCOMPLETE_CHECKS_SCHEMA_V1
  >>;
  evidenceRequired: readonly [RemoteCanaryEvidenceGapV1, ...RemoteCanaryEvidenceGapV1[]];
}>;
export type FailedRemoteCanaryCertificateV1 = DeepReadonly<FromSchema<
  typeof REMOTE_CANARY_FAILED_CERTIFICATE_SCHEMA_V1
>>;
export type RemoteCanaryCertificateV1 =
  | StartingRemoteCanaryCertificateV1
  | RemoteCanaryDryRunCertificateV1
  | CompletedRemoteCanaryCertificateV1
  | IncompleteRemoteCanaryCertificateV1
  | FailedRemoteCanaryCertificateV1;
type EvidenceBearingRemoteCanaryCertificateV1 =
  | CompletedRemoteCanaryCertificateV1
  | IncompleteRemoteCanaryCertificateV1;
export type RemoteCanaryTopologyV1 = RemoteCanaryDryRunCertificateV1['topology'];
export type RemoteCanaryDryRunPlanV1 = RemoteCanaryDryRunCertificateV1['plan'];
export type RemoteCanaryChecksV1 = EvidenceBearingRemoteCanaryCertificateV1['checks'];
export type RemoteCanaryPassChecksV1 = CompletedRemoteCanaryCertificateV1['checks'];
export type RemoteCanaryLiveSwmResultV1 = RemoteCanaryChecksV1['liveSwmPropagation'];
export type RemoteCanaryOfflineCatchupResultV1 = RemoteCanaryChecksV1['offlineCatchup'];
export type RemoteCanaryVmParityResultV1 = RemoteCanaryChecksV1['vmParity'];
export type RemoteCanaryCatalogSwmResultV1 = RemoteCanaryChecksV1['catalogSwm'];
export type RemoteCanaryAuthorizationResultV1 = RemoteCanaryChecksV1['authorization'];
export type RemoteCanaryAuthorizationCheckResultV1 =
  RemoteCanaryAuthorizationResultV1['unauthorized'];
export type RemoteCanaryPrivateGateEvidenceResultV1 = NonNullable<
  RemoteCanaryAuthorizationResultV1['companionEvidence']
>;
export type RemoteCanaryRpcUsageResultV1 = RemoteCanaryChecksV1['rpcUsage'];
export type RemoteCanaryPreflightEvidenceV1 =
  EvidenceBearingRemoteCanaryCertificateV1['preflight'];

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
export type RawCanaryPrivateGateEvidenceV1 = Readonly<NonNullable<
  RawRemoteCanaryConfigV1['authorizationChecks']['companionEvidence']
>>;
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

export type NormalizedCanaryPrivateGateEvidenceV1 = Readonly<
  Omit<RawCanaryPrivateGateEvidenceV1, 'maxAgeMinutes'> & {
    readonly maxAgeMinutes: number;
  }
>;

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
    companionEvidence: NormalizedCanaryPrivateGateEvidenceV1 | null;
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
