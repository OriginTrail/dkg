// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter, OnChainPublishResult } from '@origintrail-official/dkg-chain';
import type { FinalizedPublisherPlan } from './publisher-planning.js';

/** Total budget for optional post-confirmation observations, including both reads. */
export const PCA_DIAGNOSTIC_TIMEOUT_MS = 500;
async function observeCandidate(chain: ChainAdapter, publisher: string) {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observation = (async () => {
    const accountId = await chain.getConvictionAgentAccountId!(publisher);
    if (expired || accountId <= 0n) return undefined;
    const lockDurationEpochs = await chain.getConvictionAccountLockDurationEpochs?.(accountId);
    return expired ? undefined : { accountId, lockDurationEpochs };
  })();
  try {
    return await Promise.race([observation, new Promise<undefined>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(undefined); }, PCA_DIAGNOSTIC_TIMEOUT_MS);
      timer.unref?.();
    })]);
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

/** Receipt evidence states whether PCA coverage was reported, not which other source paid. */
export async function warnPcaFallthrough(
  chain: ChainAdapter, plan: FinalizedPublisherPlan, explicitEpochs: number | undefined,
  result: OnChainPublishResult, warn: (message: string) => void,
): Promise<void> {
  if (plan.kind !== 'on-chain' || result.convictionCostCovered) return;
  let candidate = plan.pcaCandidate;
  // Default publishes reuse the selected signer's plan. Explicit lifetimes skip
  // PCA planning; their optional observation must not hold finalization open.
  if (!candidate && explicitEpochs !== undefined && chain.getConvictionAgentAccountId) {
    candidate = await observeCandidate(chain, plan.publisherAddress);
  }
  if (!candidate || candidate.accountId <= 0n) return;
  const lock = candidate.lockDurationEpochs;
  const reason = explicitEpochs !== undefined && lock !== undefined && lock > 0 && plan.publishEpochs !== lock
    ? `the explicit publish lifetime (publishEpochs=${plan.publishEpochs}) does not match the account's lock duration (lockDurationEpochs=${lock}); PCA coverage requires an exact epoch match`
    : 'registration escrow may have funded this publish before PCA coverage was considered; this receipt alone does not establish a PCA funding failure';
  warn(`PCA coverage not reported: signer ${plan.publisherAddress} is a registered PCA agent ` +
    `(accountId=${candidate.accountId}), but the confirmed receipt has no CostCovered event — ${reason}.`);
}
