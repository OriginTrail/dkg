// SPDX-License-Identifier: Apache-2.0

import {
  assertNever,
  type NormalizedCanaryRpcUsageV1,
  type RawCanaryRpcUsageV1,
  type RemoteCanaryDependenciesV1,
} from './domain-contract.js';

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
// @ts-expect-error Normalized file evidence always has an explicit minimum sample count.
const normalizedFileEvidence: NormalizedCanaryRpcUsageV1 = rawFileEvidence;
// @ts-expect-error Evidence modes are a closed discriminated union.
const unknownEvidence: RawCanaryRpcUsageV1 = { kind: 'provider-api' };

void [rpcSource, dependencies, normalizedFileEvidence, unknownEvidence];
