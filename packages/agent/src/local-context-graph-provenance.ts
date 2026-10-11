// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphMembershipRecord,
  ContextGraphMembershipSource,
  LocalContextGraphOriginRecord,
  LocalContextGraphOriginSource,
} from './dkg-agent-types.js';

export type { LocalContextGraphOriginSource } from './dkg-agent-types.js';

export type LocalContextGraphOriginMembershipRecord = ContextGraphMembershipRecord & {
  readonly principalType: 'agent';
  readonly status: 'active';
  readonly source: LocalContextGraphOriginSource;
};

export function createLocalContextGraphOriginMembershipRecord(
  input: Omit<
    LocalContextGraphOriginMembershipRecord,
    'principalType' | 'status'
  >,
): LocalContextGraphOriginMembershipRecord {
  return {
    ...input,
    principalType: 'agent',
    status: 'active',
  };
}

export function isLocalContextGraphOriginSource(
  source: ContextGraphMembershipSource | undefined,
): source is LocalContextGraphOriginSource {
  return source === 'local-create' || source === 'implicit-swm-write';
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

  /** Restore the independent, graph-keyed durable origin journal. */
  restoreOriginRecords(
    records: Iterable<Pick<LocalContextGraphOriginRecord,
      'contextGraphId' | 'source'>>,
  ): void {
    for (const record of records) {
      if (isLocalContextGraphOriginSource(record.source)) {
        this.recordLocalCreate(record.contextGraphId);
      }
    }
  }

  /**
   * Compatibility restoration for custom/older stores that have not adopted
   * the independent graph-origin journal yet.
   */
  restoreMembershipRecords(
    records: Iterable<Pick<ContextGraphMembershipRecord,
      'contextGraphId' | 'principalType' | 'status' | 'source'>>,
  ): void {
    for (const record of records) {
      if (
        record.principalType === 'agent'
        && record.status === 'active'
        && isLocalContextGraphOriginSource(record.source)
      ) {
        this.recordLocalCreate(record.contextGraphId);
      }
    }
  }
}
