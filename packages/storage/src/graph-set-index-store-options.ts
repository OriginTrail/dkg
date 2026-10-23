// SPDX-License-Identifier: Apache-2.0
import type { GraphSetMutationEvent } from './graph-set-index-store.js';

export interface GraphSetIndexStoreOptions {
  enabled?: boolean;
  /** Revalidate after this interval. Use 0 to revalidate on every read. */
  revalidateMs?: number;
  /**
   * Initial retry delay after a failed warm periodic revalidation.
   * Ignored when revalidateMs is 0.
   */
  revalidateFailureBackoffMs?: number;
  /**
   * Maximum exponential retry delay after failed warm periodic revalidations.
   * Ignored when revalidateMs is 0.
   */
  revalidateFailureMaxBackoffMs?: number;
  now?: () => number;
  onMutation?: (event: GraphSetMutationEvent) => void;
}
