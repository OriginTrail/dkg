// SPDX-License-Identifier: Apache-2.0

import {
  assertNever,
  type CanaryNodeClientV1,
  type NormalizedRemoteCanaryConfigV1,
  type NormalizedCanaryRpcUsageV1,
  type RawCanaryRpcUsageV1,
  type RawRemoteCanaryConfigV1,
  type RemoteCanaryDependenciesV1,
  type RpcUsageEvidenceV1,
} from './domain-contract.js';
import { preflightAllNodesV1 } from './preflight.mjs';
import {
  createRemoteCanaryDryRunArtifactFromNormalizedV1,
  executeRemoteCanaryCertificationFromNormalizedV1,
} from './phases.mjs';

function rpcSource(value: RawCanaryRpcUsageV1): string {
  switch (value.kind) {
    case 'required': return value.kind;
    case 'evidence-file': return value.path;
    case 'command': return value.command.argv[0] ?? '';
    default: return assertNever(value);
  }
}

const dependencies = {
  fetchFn: globalThis.fetch,
  readFileFn: async (_path: string, _encoding: BufferEncoding) => '',
  runCommand: async () => ({ code: 0, signal: null, stdout: '' }),
  sleep: async (_milliseconds: number) => undefined,
  now: () => new Date(0),
} satisfies RemoteCanaryDependenciesV1;

declare const rawFileEvidence: Extract<RawCanaryRpcUsageV1, { kind: 'evidence-file' }>;
declare const normalizedConfig: NormalizedRemoteCanaryConfigV1;
declare const client: CanaryNodeClientV1;

void createRemoteCanaryDryRunArtifactFromNormalizedV1(normalizedConfig);
void executeRemoteCanaryCertificationFromNormalizedV1(normalizedConfig, dependencies);
void preflightAllNodesV1({ mode: 'initial', config: normalizedConfig, client });
// @ts-expect-error Final preflight requires the complete baseline as one state.
void preflightAllNodesV1({ mode: 'final', config: normalizedConfig, client });
void preflightAllNodesV1({
  mode: 'initial',
  config: normalizedConfig,
  client,
  // @ts-expect-error Initial preflight cannot admit a hybrid final baseline.
  baseline: {
    networkKey: 'otp-testnet-2160:2160',
    nodeIdentities: new Map(),
    operationalCertificationByNodeId: new Map(),
  },
});
// @ts-expect-error Normalized file evidence always has an explicit minimum sample count.
const normalizedFileEvidence: NormalizedCanaryRpcUsageV1 = rawFileEvidence;
// @ts-expect-error Evidence modes are a closed discriminated union.
const unknownEvidence: RawCanaryRpcUsageV1 = { kind: 'provider-api' };

const configSchemaDiscriminant: RawRemoteCanaryConfigV1['schema'] =
  'dkg-rfc64-remote-canary-config-v1';
// @ts-expect-error Configuration discriminants are derived from the canonical schema.
const staleConfigSchemaDiscriminant: RawRemoteCanaryConfigV1['schema'] =
  'dkg-rfc64-remote-canary-config-v2';
const typedRpcEvidence = {
  schema: 'dkg-rpc-usage-minutes-v1',
  scope: 'certified-cohort',
  expectedCommit: 'a'.repeat(40),
  cohortRef: 'cohort:00000000000000000000',
  samples: [{
    windowStartedAt: '2026-09-11T00:00:00.000Z',
    windowEndedAt: '2026-09-11T00:01:00.000Z',
    total: 1,
    byMethod: { eth_call: 1 },
  }],
} satisfies RpcUsageEvidenceV1;
const staleRpcEvidence = {
  ...typedRpcEvidence,
  // @ts-expect-error RPC evidence discriminants are derived from the canonical schema.
  scope: 'unbound-cohort',
} satisfies RpcUsageEvidenceV1;

void [
  rpcSource,
  dependencies,
  normalizedFileEvidence,
  unknownEvidence,
  configSchemaDiscriminant,
  staleConfigSchemaDiscriminant,
  typedRpcEvidence,
  staleRpcEvidence,
];
