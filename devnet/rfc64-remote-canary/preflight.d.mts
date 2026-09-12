import type { NormalizedRemoteCanaryConfigV1 } from './domain-contract.js';

export interface PreflightRequestV1 {
  json(node: unknown, method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface PreflightResultV1 {
  readonly networkKey: string;
  readonly nodeIdentities: ReadonlyMap<string, string>;
  readonly nodes: readonly unknown[];
}

export function preflightAllNodesV1(input: {
  readonly config: NormalizedRemoteCanaryConfigV1;
  readonly request: PreflightRequestV1;
  readonly expectedNetworkKey?: string;
  readonly expectedNodeIdentities?: ReadonlyMap<string, string>;
}): Promise<PreflightResultV1>;
