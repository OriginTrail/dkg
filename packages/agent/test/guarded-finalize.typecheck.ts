// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent, FinalizeGuard } from '../src/index.js';

export async function checkGuardedOutcome(agent: DKGAgent, guard: FinalizeGuard) {
  const publicSeal = await agent.assertion.finalize('graph', 'asset', { guard });
  const internalSeal = await agent.assertionFinalize('graph', 'asset', guard.expectedAuthorAddress, { guard });
  const outcomes: Array<'sealed' | 'already_sealed'> = [publicSeal.guardedOutcome, internalSeal.guardedOutcome];
  return outcomes;
}
