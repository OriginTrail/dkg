import React from 'react';
import type { MemoryData } from '../hooks/useMemoryEntities.js';

/** A continuation surface for views that consume the bounded memory preview. */
export function MemoryReadStatus({ memory }: { memory: MemoryData }) {
  if (!memory.partial && !memory.pageError) return null;
  return <div className="v10-stale-banner" role="status">
    <span>{memory.pageError ?? memory.limitMessage ?? 'Only loaded memory is shown. Per-layer counts may change as more memory loads; recent entries are from this preview.'}</span>
    {memory.hasMore && <button type="button" className="v10-retry-btn" disabled={memory.loading} onClick={memory.loadMore}>
      {memory.loading ? 'Loading…' : 'Load more graph data'}
    </button>}
    {memory.canRetry && <button type="button" className="v10-retry-btn" disabled={memory.loading} onClick={memory.refresh}>
      {memory.loading ? 'Loading…' : 'Retry memory read'}
    </button>}
  </div>;
}
