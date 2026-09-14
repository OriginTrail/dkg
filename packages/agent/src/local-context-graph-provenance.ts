// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphMembershipRecord,
  ContextGraphMembershipSource,
} from './dkg-agent-types.js';

export type LocalContextGraphOriginSource =
  | 'local-create'
  | 'implicit-swm-write';

const localOriginByMembershipSource = Object.freeze({
  'local-create': true,
  'implicit-swm-write': true,
  'allowed-peer': false,
  'allowed-agent': false,
  'participant-agent': false,
  'on-chain-registration': false,
  'join-approved': false,
  'join-rejected': false,
  'join-request': false,
  'join-request-outbox-response': false,
  'subscription': false,
  'rehydrated-subscription': false,
  'pre-existing': false,
} satisfies Record<ContextGraphMembershipSource, boolean>);

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
  return source !== undefined && localOriginByMembershipSource[source];
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
        && isLocalContextGraphOriginSource(record.source)
      ) {
        this.recordLocalCreate(record.contextGraphId);
      }
    }
  }
}
