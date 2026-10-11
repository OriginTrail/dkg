// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphMetaProjection } from '../context-graph-meta-projection.js';
import type { StoreMutationObserver } from './store-mutation.js';

/** How the agent's store wrapper tells the metadata projection what a write is about to change and did change. */
export function createProjectionMutationObserver(
  getProjection: () => ContextGraphMetaProjection | undefined,
): StoreMutationObserver {
  return {
    begin(mutation) {
      const projection = getProjection();
      const release = projection?.recipientKeyRouteFence.begin(mutation);
      let settled = false;
      return (outcome) => {
        if (settled) return;
        settled = true;
        try {
          if (outcome !== 'unchanged' && projection) projection.invalidateStoreMutation(mutation);
        } finally {
          release?.(outcome);
        }
      };
    },
  };
}
