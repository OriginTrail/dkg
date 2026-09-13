// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphMembershipRecord } from './dkg-agent-types.js';

/**
 * Process-local projection of the durable facts that prove a Context Graph
 * originated on this node.
 *
 * The projection records origin, not registration state. Policy callers must
 * still pair it with the durable registration marker and the absence of an
 * authoritative on-chain binding before taking the local-first path.
 */
export class LocalContextGraphProvenance {
  readonly #createdContextGraphIds = new Set<string>();

  recordLocalCreate(contextGraphId: string): void {
    this.#createdContextGraphIds.add(contextGraphId);
  }

  hasLocalCreate(contextGraphId: string): boolean {
    return this.#createdContextGraphIds.has(contextGraphId);
  }

  /** Restore only explicit active local-creation facts from the node-local store. */
  restoreMembershipRecords(
    records: Iterable<Pick<ContextGraphMembershipRecord,
      'contextGraphId' | 'principalType' | 'status' | 'source'>>,
  ): void {
    for (const record of records) {
      if (
        record.principalType === 'agent'
        && record.status === 'active'
        && (record.source === 'local-create' || record.source === 'implicit-swm-write')
      ) {
        this.recordLocalCreate(record.contextGraphId);
      }
    }
  }
}
