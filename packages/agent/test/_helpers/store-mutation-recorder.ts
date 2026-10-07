// SPDX-License-Identifier: Apache-2.0

import type { StoreMutation, StoreMutationObserver } from '../../src/internal/store-mutation.js';

/** Records what a decorated store reports: every mutation announced, and how each one settled. */
export function recordingObserver() {
  const began: StoreMutation[] = [];
  const committed: StoreMutation[] = [];
  const unchanged: StoreMutation[] = [];
  const observer: StoreMutationObserver = {
    begin(mutation) {
      began.push(mutation);
      return (changed) => { (changed ? committed : unchanged).push(mutation); };
    },
  };
  return { observer, began, committed, unchanged };
}
