// SPDX-License-Identifier: Apache-2.0
import type { KnowledgeAssetReadInput, KnowledgeAssetReadTarget } from '@origintrail-official/dkg-agent/dist/knowledge-asset-read-resolution.js';
import { requireKnowledgeAssetRead } from './context-graph-read-authority.js';
import type { RequestContext } from './context.js';

export { classifyKaIdentifier, type KnowledgeAssetReadTarget } from '@origintrail-official/dkg-agent/dist/knowledge-asset-read-resolution.js';

/** The daemon maps the KA owner's combined admission and resource resolution. */
export async function resolveKnowledgeAssetReadTarget(
  ctx: RequestContext,
  input: KnowledgeAssetReadInput,
): Promise<KnowledgeAssetReadTarget | null> {
  return requireKnowledgeAssetRead(ctx, input);
}
