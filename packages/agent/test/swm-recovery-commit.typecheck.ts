// SPDX-License-Identifier: Apache-2.0
import { commitRecoveredSwmAsset } from '../src/internal/swm-recovery/swm-recovery-commit.js';

declare const admitted: Parameters<typeof commitRecoveredSwmAsset>[0];
void commitRecoveredSwmAsset({ ...admitted, mutationAttribution: {
  graphSource: 'agent.test.recovery.graph', metadataSource: 'agent.test.recovery.metadata',
} });
void commitRecoveredSwmAsset({
  ...admitted,
  // @ts-expect-error The materializer exclusively owns graph replacement effects.
  replaceGraph: async () => undefined,
});
void commitRecoveredSwmAsset({
  ...admitted,
  // @ts-expect-error The materializer exclusively owns head replacement effects.
  replaceMetadata: async () => undefined,
});
void admitted.materializer.replaceGraph('urn:test:graph', [], {
  // @ts-expect-error Attribution cannot replace the materializer's store priority policy.
  priority: 'interactive',
});
