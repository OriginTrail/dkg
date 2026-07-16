export interface ShareBatchQuad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export interface ShareBatchAsset {
  rootEntity: string;
  quads: ShareBatchQuad[];
}

export interface ShareBatch {
  assets: ShareBatchAsset[];
  roots: string[];
  quads: ShareBatchQuad[];
  estimatedBytes: number;
}

export const DEFAULT_MAX_SHARE_BATCH_BYTES = 450 * 1024;

export function groupAssetsByRootEntity(assets: readonly ShareBatchAsset[]): ShareBatchAsset[] {
  const grouped = new Map<string, ShareBatchQuad[]>();
  for (const asset of assets) {
    const current = grouped.get(asset.rootEntity) ?? [];
    grouped.set(asset.rootEntity, [...current, ...asset.quads.map((quad) => ({ ...quad, graph: quad.graph ?? '' }))]);
  }
  return Array.from(grouped.entries()).map(([rootEntity, quads]) => ({ rootEntity, quads }));
}

export function batchAssetsByEstimatedBytes(
  assets: readonly ShareBatchAsset[],
  maxBatchBytes = DEFAULT_MAX_SHARE_BATCH_BYTES,
): ShareBatch[] {
  const groupedAssets = groupAssetsByRootEntity(assets);
  const batches: ShareBatch[] = [];
  let current = emptyBatch();

  for (const asset of groupedAssets) {
    const assetRoots = [asset.rootEntity];
    const assetQuads = asset.quads.map((quad) => ({ ...quad, graph: quad.graph ?? '' }));
    const estimatedBytes = estimatePayloadBytes(assetQuads);

    if (estimatedBytes > maxBatchBytes) {
      batches.push({
        assets: [asset],
        roots: assetRoots,
        quads: assetQuads,
        estimatedBytes,
      });
      continue;
    }

    if (current.assets.length > 0 && current.estimatedBytes + estimatedBytes > maxBatchBytes) {
      batches.push(current);
      current = emptyBatch();
    }

    current = {
      assets: [...current.assets, asset],
      roots: [...current.roots, ...assetRoots],
      quads: [...current.quads, ...assetQuads],
      estimatedBytes: current.estimatedBytes + estimatedBytes,
    };
  }

  if (current.assets.length > 0) {
    batches.push(current);
  }

  return batches;
}

function emptyBatch(): ShareBatch {
  return {
    assets: [],
    roots: [],
    quads: [],
    estimatedBytes: 0,
  };
}

function estimatePayloadBytes(quads: readonly ShareBatchQuad[]): number {
  return Buffer.byteLength(JSON.stringify({ quads }), 'utf8');
}
