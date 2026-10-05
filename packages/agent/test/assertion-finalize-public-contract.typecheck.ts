// SPDX-License-Identifier: Apache-2.0
import type { AssertionFinalizeOptions, AssertionFinalizeResult, DKGAgent } from '@origintrail-official/dkg-agent';

declare const agent: DKGAgent;
// @ts-expect-error Finalization cannot bypass lifecycle and artifact ownership.
agent._assertionFinalizeUnlocked('cg', 'asset', '0x1111111111111111111111111111111111111111');

declare const options: AssertionFinalizeOptions;
const finalized: Promise<AssertionFinalizeResult> = agent.assertionFinalize(
  'cg', 'asset', '0x1111111111111111111111111111111111111111', options,
);
void finalized;
