// SPDX-License-Identifier: Apache-2.0

import {
  type Rfc64PrivateFaultProfileV1,
  type Rfc64PrivateRuntimeV1,
} from './agent-runtime.ts';
import type { Rfc64PrivateFinalizedAgentConfigV1 } from './agent-runtime-factory.ts';
import { waitForBootstrapV1 } from './catalog-evidence-handlers.mjs';
import { publishCatalogBaselineV1 } from './catalog-publication-handlers.mjs';

// @ts-expect-error An authority strategy must transform the concrete finalized fixture.
const malformedAuthorityStrategy: Rfc64PrivateFaultProfileV1['authority'] = {
  adapterOptions: () => ({
    authorityStatePath: undefined,
    participantRemovalAlsoRemoves: undefined,
    participantRemovalNoop: false,
  }),
};
void malformedAuthorityStrategy;

// @ts-expect-error A proof strategy cannot omit its canonical inputs transformer.
const malformedProofStrategy: Rfc64PrivateFaultProfileV1['proof'] = {};
void malformedProofStrategy;

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
