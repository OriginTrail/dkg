// SPDX-License-Identifier: Apache-2.0

import { completeVerifiedVmMarkerRetirement } from '../../src/internal/finalized-swm-retirement-completion.js';
import type { FinalizedSwmTwinReconciliationResult } from '../../src/sync/requester/finalized-swm-twin-reconciliation.js';

export async function completeSettledSwmRetirement(
  result: FinalizedSwmTwinReconciliationResult,
  ports: Omit<Parameters<typeof completeVerifiedVmMarkerRetirement>[0], 'evidence'>,
): Promise<FinalizedSwmTwinReconciliationResult> {
  if ('retirement' in result) {
    await completeVerifiedVmMarkerRetirement({ ...ports, evidence: result.retirement });
  }
  return result;
}
