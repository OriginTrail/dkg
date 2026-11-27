// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter, OnChainPublishResult } from '@origintrail-official/dkg-chain';
import type { FinalizedPublisherPlan } from './publisher-planning.js';

/** Receipt evidence decides whether a discount was used; planning only supplies diagnostic eligibility. */
export async function warnPcaFallthrough(
  chain: ChainAdapter, plan: FinalizedPublisherPlan, explicitEpochs: number | undefined,
  result: OnChainPublishResult, warn: (message: string) => void,
): Promise<void> {
  if (plan.kind !== 'on-chain' || result.convictionCostCovered) return;
  let candidate = plan.pcaCandidate;
  // Explicit lifetimes intentionally skip PCA pricing. Only this case needs an extra
  // best-effort observation; default publishes reuse the selected signer's plan.
  if (!candidate && explicitEpochs !== undefined && chain.getConvictionAgentAccountId) {
    try {
      const accountId = await chain.getConvictionAgentAccountId(plan.publisherAddress);
      if (accountId > 0n) {
        const lockDurationEpochs = await chain.getConvictionAccountLockDurationEpochs?.(accountId);
        candidate = { accountId, lockDurationEpochs };
      }
    } catch { return; }
  }
  if (!candidate || candidate.accountId <= 0n) return;
  const lock = candidate.lockDurationEpochs;
  const reason = explicitEpochs !== undefined && lock !== undefined && lock > 0 && plan.publishEpochs !== lock
    ? `the explicit publish lifetime (publishEpochs=${plan.publishEpochs}) does not match the account's lock duration (lockDurationEpochs=${lock}) — the PCA discount requires an exact epoch match`
    : `the account could not cover this publish's cost (underfunded, expired, or misconfigured lock)`;
  warn(`PCA discount NOT applied: signer ${plan.publisherAddress} is a registered PCA agent ` +
    `(accountId=${candidate.accountId}) but this publish paid FULL price via direct wallet spend ` +
    `(no CostCovered event) — ${reason}. Omit the explicit lifetime (or match the lock duration) to use the discount.`);
}
