// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphMembershipRecord,
  ContextGraphMembershipStore,
} from './dkg-agent-types.js';

export type LocalContextGraphProvenanceMembershipSnapshot = Array<
  ContextGraphMembershipRecord & { firstSeenAt?: number; updatedAt: number }
>;

export interface LocalContextGraphProvenanceRestoreInput {
  readonly membershipStore?: ContextGraphMembershipStore;
  readonly warn: (message: string) => void;
}

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

  /**
   * Restore origin from both durable compatibility sources.
   *
   * Only the node-local membership journal may establish local origin.
   * Replicated RDF is intentionally excluded: creator/status triples can be
   * supplied by peers and are therefore not authentication evidence. Older
   * custom stores without `loadAll`, and failed journal reads, retain the
   * normal fail-closed chain path. The returned snapshot can be reused by
   * subscription bootstrap without coupling it to provenance persistence.
   */
  async restoreFromDurableSources(
    input: LocalContextGraphProvenanceRestoreInput,
  ): Promise<LocalContextGraphProvenanceMembershipSnapshot | null> {
    let membershipRows: LocalContextGraphProvenanceMembershipSnapshot | null = null;
    if (input.membershipStore?.loadAll === undefined) {
      input.warn(
        'Node-local membership provenance cannot be restored: loadAll is unavailable',
      );
      return null;
    }
    try {
      membershipRows = await input.membershipStore.loadAll();
      this.restoreMembershipRecords(membershipRows);
    } catch (error) {
      input.warn(
        `Failed to load node-local membership provenance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return membershipRows;
  }
}
