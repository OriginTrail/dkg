import { createHash } from 'node:crypto';
import type { KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';

export type KnowledgeAssetVmPublishIntent = Omit<KnowledgeAssetVmPublishRequest, 'intentKey'>;

/** Bind the queue deduplication key to the complete executable request. */
export function computeKnowledgeAssetVmPublishIntentKey(
  request: KnowledgeAssetVmPublishIntent,
): string {
  const canonical = JSON.stringify(stabilize(request));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function stabilize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stabilize(entry)]),
    );
  }
  return value;
}
