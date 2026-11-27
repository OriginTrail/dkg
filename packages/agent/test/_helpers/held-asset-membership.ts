import { readHeldGraphScopedAssets as readHeldEvidence } from '../../src/sync/requester/stored-graph-assets.js';

export async function readHeldGraphScopedAssets(...args: Parameters<typeof readHeldEvidence>): Promise<Set<string>> {
  return new Set((await readHeldEvidence(...args)).keys());
}
