// SPDX-License-Identifier: Apache-2.0

import {
  type FinalizedRuntimeV1,
  type ProbeRuntimeV1,
  type Rfc64PrivateRuntimeV1,
} from './agent-runtime.ts';
import type { Rfc64PrivateFinalizedAgentConfigV1 } from './agent-runtime-factory.ts';
import { waitForBootstrapV1 } from './catalog-evidence-handlers.mjs';
import { publishCatalogBaselineV1 } from './catalog-publication-handlers.mjs';

declare const probeRuntime: ProbeRuntimeV1;
declare const finalizedRuntime: FinalizedRuntimeV1;
// @ts-expect-error Probe runtimes expose only the real agent capability.
void probeRuntime.faultProfile;
// @ts-expect-error Finalized runtimes expose resolved capabilities, not test strategies.
void finalizedRuntime.faultProfile;

declare const finalizedAgentConfig: Rfc64PrivateFinalizedAgentConfigV1;
const exactFinalizedChainConfig: Rfc64PrivateFinalizedAgentConfigV1 = finalizedAgentConfig;
void exactFinalizedChainConfig;

const missingFinalizedChainConfig: Rfc64PrivateFinalizedAgentConfigV1 = {
  ...finalizedAgentConfig,
  // @ts-expect-error The finalized agent boundary requires canonical chainConfig.
  chainConfig: undefined,
};
void missingFinalizedChainConfig;

const misspelledFinalizedChainConfig: Rfc64PrivateFinalizedAgentConfigV1 = {
  ...finalizedAgentConfig,
  // @ts-expect-error A misspelled chain field is not part of the finalized config.
  chainConfg: finalizedAgentConfig.chainConfig,
};
void misspelledFinalizedChainConfig;

declare const runtime: Rfc64PrivateRuntimeV1;
void waitForBootstrapV1(runtime, { timeoutMs: 1_000 });
void publishCatalogBaselineV1(runtime);

// @ts-expect-error Handler contexts must be the canonical runtime union.
void waitForBootstrapV1({ kind: 'run', role: 'receiver' }, { timeoutMs: 1_000 });

// @ts-expect-error Publication handlers reject structurally incomplete owner contexts.
void publishCatalogBaselineV1({ kind: 'run', role: 'owner', publication: null });
