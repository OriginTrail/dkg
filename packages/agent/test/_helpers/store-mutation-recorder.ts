// SPDX-License-Identifier: Apache-2.0

import type { StoreMutation, StoreMutationObserver } from '../../src/internal/store-mutation.js';

/** Records what a decorated store reports: every mutation announced, and how each one settled. */
export function recordingObserver() {
  const began: StoreMutation[] = [];
  const committed: StoreMutation[] = [];
  const unchanged: StoreMutation[] = [];
  const indeterminate: StoreMutation[] = [];
  const observer: StoreMutationObserver = {
    begin(mutation) {
      began.push(mutation);
      return (outcome) => {
        (outcome === 'unchanged' ? unchanged : committed).push(mutation);
        if (outcome === 'indeterminate') indeterminate.push(mutation);
      };
    },
  };
  return { observer, began, committed, unchanged, indeterminate };
}
