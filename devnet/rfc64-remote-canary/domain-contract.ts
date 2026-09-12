// SPDX-License-Identifier: Apache-2.0

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

export interface CanaryCommandV1 {
  readonly argv: readonly string[];
}

export type RawCanaryAuthenticationV1 =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'bearer-file'; secretFile: string }>;

export interface RawCanaryNodeV1 {
  readonly id: string;
  readonly role: 'source' | 'receiver' | 'observer';
  readonly baseUrl: string;
  readonly allowTailscaleHttp?: boolean;
  readonly auth: RawCanaryAuthenticationV1;
}

export interface NormalizedCanaryNodeV1 extends RawCanaryNodeV1 {
  readonly nodeRef: string;
}

export interface RawCanaryContextGraphV1 {
  readonly id: string;
  readonly expectedMode: 'catalog';
  readonly sourceNodeId: string;
  readonly receiverNodeId: string;
  readonly vmAskSparql?: string;
  readonly catalogSwmAskSparql?: string;
}

export interface NormalizedCanaryContextGraphV1 extends RawCanaryContextGraphV1 {
  readonly source: NormalizedCanaryNodeV1;
  readonly receiver: NormalizedCanaryNodeV1;
  readonly contextGraphRef: string;
}

export interface RawCanaryLifecycleV1 {
  readonly receiverNodeId: string;
  readonly stop: CanaryCommandV1;
  readonly start: CanaryCommandV1;
  readonly commandTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
}

export interface NormalizedCanaryLifecycleV1 {
  readonly receiverNodeId: string;
  readonly receiver: NormalizedCanaryNodeV1;
  readonly stop: CanaryCommandV1;
  readonly start: CanaryCommandV1;
  readonly commandTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly readyTimeoutMs: number;
}

export type RawCanaryAuthorizationCheckV1 =
  | Readonly<{
      kind: 'not-exposed';
      reasonCode: 'catalog-protocol-api-not-exposed' | 'revocation-api-not-exposed';
    }>
  | Readonly<{
      kind: 'http';
      nodeId: string;
      method: 'GET' | 'POST';
      path: string;
      authentication: 'none' | 'node';
      body?: Readonly<{ [key: string]: JsonValue }>;
      expectedStatuses: readonly (401 | 403 | 404)[];
      bodyCodePointer: string;
      notFoundControlNodeId?: string;
      expectedCodes: readonly string[];
    }>;

export type NormalizedCanaryAuthorizationCheckV1 =
  | Extract<RawCanaryAuthorizationCheckV1, { kind: 'not-exposed' }>
  | Readonly<Extract<RawCanaryAuthorizationCheckV1, { kind: 'http' }> & {
      node: NormalizedCanaryNodeV1;
      notFoundControlNode?: NormalizedCanaryNodeV1;
    }>;

export type RawCanaryRpcUsageV1 =
  | Readonly<{ kind: 'required' }>
  | Readonly<{ kind: 'evidence-file'; path: string; minimumSamples?: number }>
  | Readonly<{
      kind: 'command';
      command: CanaryCommandV1;
      minimumSamples?: number;
      commandTimeoutMs?: number;
    }>;

export type NormalizedCanaryRpcUsageV1 =
  | Readonly<{ kind: 'required' }>
  | Readonly<{ kind: 'evidence-file'; path: string; minimumSamples: number }>
  | Readonly<{
      kind: 'command';
      command: CanaryCommandV1;
      minimumSamples: number;
      commandTimeoutMs: number;
    }>;

export interface RawCanaryTimingV1 {
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly propagationTimeoutMs?: number;
  readonly catchupTimeoutMs?: number;
  readonly parityTimeoutMs?: number;
}

export interface NormalizedCanaryTimingV1 {
  readonly requestTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly propagationTimeoutMs: number;
  readonly catchupTimeoutMs: number;
  readonly parityTimeoutMs: number;
}

export interface RawRemoteCanaryConfigV1 {
  readonly schema: 'dkg-rfc64-remote-canary-config-v1';
  readonly expectedCommit: string;
  readonly nodes: readonly RawCanaryNodeV1[];
  readonly contextGraphs: readonly RawCanaryContextGraphV1[];
  readonly lifecycle?: RawCanaryLifecycleV1 | null;
  readonly authorizationChecks: Readonly<{
    unauthorized: RawCanaryAuthorizationCheckV1;
    revoked: RawCanaryAuthorizationCheckV1;
  }>;
  readonly rpcUsage: RawCanaryRpcUsageV1;
  readonly timing?: RawCanaryTimingV1;
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
