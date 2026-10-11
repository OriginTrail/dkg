// SPDX-License-Identifier: Apache-2.0

import type { OnChainPublishResult } from './chain-adapter.js';
import { getPcaLogicInterface } from './evm-adapter-errors.js';

/**
 * B8 — decode the `CostCovered` event from a publish receipt's logs via the
 * PublishingConviction LOGIC ABI (the event is emitted by the logic contract, a
 * different address than KA storage, so the KA-storage receipt loop skips it).
 * Returns the discount detail (cost fields bigint → decimal strings via the
 * daemon's JSON replacer; `epoch` a number) when a publish drew on a Publishing
 * Conviction Account, else `undefined`. `coverPublishingCost` runs once per
 * publish tx, so a (batch) publish emits ONE CostCovered covering the batch's
 * total draw — this returns that single event (the "discount applied" badge is
 * tx-level; a precise per-KA breakdown would be a future enhancement). Exported
 * for unit testing.
 */
export function decodeConvictionCostCovered(
  logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }>,
): OnChainPublishResult['convictionCostCovered'] {
  const pcaLogic = getPcaLogicInterface();
  for (const log of logs) {
    try {
      const parsed = pcaLogic.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'CostCovered') {
        return {
          accountId: BigInt(parsed.args.accountId),
          epoch: Number(parsed.args.epoch),
          baseCost: BigInt(parsed.args.baseCost),
          discountedCost: BigInt(parsed.args.discountedCost),
          drawnFromEpoch: BigInt(parsed.args.drawnFromEpoch),
          drawnFromTopUp: BigInt(parsed.args.drawnFromTopUp),
        };
      }
    } catch { /* not a PublishingConviction event */ }
  }
  return undefined;
}
