import React from 'react';
import type { MemoryData } from '../hooks/useMemoryEntities.js';
import { MEMORY_RETRY_MESSAGE } from '../hooks/memory-graph-query.js';
import { RetryButton } from './ds/RetryButton.js';

/** A continuation surface for views that consume the bounded memory preview.
 *  A strip at the top of a view by default; `inset` makes it a note inside a card or
 *  column (DESIGN.md · Feedback states: notices). */
export function MemoryReadStatus({ memory, inset = false }: { memory: MemoryData; inset?: boolean }) {
  if (!memory.partial && !memory.pageError) return null;
  return <div className={inset ? 'v10-modal-warning ds-card-nested v10-inset-note' : 'v10-stale-banner'} role="status">
    <span>{memory.pageError ?? memory.limitMessage ?? (memory.canRetry ? MEMORY_RETRY_MESSAGE : 'Only part of this context graph’s memory is loaded, so the numbers and latest items may change as more loads.')}</span>
    {memory.hasMore && <button type="button" className="v10-retry-btn ds-btn ds-sm" disabled={memory.loading} onClick={memory.loadMore}>
      {memory.loading ? 'Loading…' : 'Load more'}
    </button>}
    {memory.canRetry && <RetryButton className="v10-retry-btn" disabled={memory.loading} onClick={memory.refresh} />}
  </div>;
}
