import React from 'react';
import type { MemoryData } from '../hooks/useMemoryEntities.js';

/** A continuation surface for views that consume the bounded memory preview. */
export function MemoryReadStatus({ memory }: { memory: MemoryData }) {
  if (!memory.partial && !memory.pageError) return null;
  return <div className="v10-stale-banner" role="status">
    <span>{memory.pageError ?? memory.limitMessage ?? 'Only loaded memory is shown. Counts are lower bounds; recent entries are from this preview.'}</span>
    {(memory.hasMore || !memory.limitMessage) && <button type="button" className="v10-retry-btn" disabled={memory.loading}
      onClick={memory.hasMore ? memory.loadMore : memory.refresh}>
      {memory.loading ? 'Loading…' : memory.hasMore ? 'Load more graph data' : 'Retry memory read'}
    </button>}
  </div>;
}
