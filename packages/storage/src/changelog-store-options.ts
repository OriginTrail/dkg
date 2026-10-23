// SPDX-License-Identifier: Apache-2.0
import type { ChangeRecord, ChangelogEraGuard } from './changelog-store.js';

export interface ChangelogStoreOptions {
  enabled?: boolean;
  /**
   * Extra reserved graphs (besides {@link CHANGELOG_GRAPH}) to hide from
   * `listGraphs()` and never emit markers for — e.g. a future in-store catalog
   * graph. The changelog graph is always reserved.
   */
  reservedGraphs?: readonly string[];
  /** Observability hook fired after each marker is durably appended. */
  onAppend?: (record: ChangeRecord) => void;
  /**
   * Optional restore-detection guard. When provided, a seq rollback under the
   * same era rotates the era on seed (forcing peers to full-resync instead of
   * silently skipping). When absent, no restore detection runs — the historical
   * behavior — which is why enabling the changelog fleet-wide REQUIRES a durable
   * guard (OT-RFC-59 §6 P0).
   */
  eraGuard?: ChangelogEraGuard;
}
