// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  assertSafeIri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { strip, stripLiteral } from './dkg-agent-utils.js';
import type {
  ContextGraphMembershipRecord,
  ContextGraphMembershipStore,
} from './dkg-agent-types.js';

export type LocalContextGraphProvenanceMembershipSnapshot = Array<
  ContextGraphMembershipRecord & { firstSeenAt?: number; updatedAt: number }
>;

export interface LocalContextGraphProvenanceRestoreInput {
  readonly membershipStore?: ContextGraphMembershipStore;
  readonly store: Pick<TripleStore, 'query'>;
  readonly peerId: string;
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
   * Membership rows are the primary restart hint. Older/custom membership
   * stores may not implement `loadAll`, so the creator RDF fact is also read
   * as a compatibility fallback. Either source may fail independently; when
   * both are unavailable callers retain the normal fail-closed chain path.
   * The returned membership snapshot can be reused by subscription bootstrap
   * without coupling that bootstrap to provenance persistence details.
   */
  async restoreFromDurableSources(
    input: LocalContextGraphProvenanceRestoreInput,
  ): Promise<LocalContextGraphProvenanceMembershipSnapshot | null> {
    let membershipRows: LocalContextGraphProvenanceMembershipSnapshot | null = null;
    if (input.membershipStore?.loadAll) {
      try {
        membershipRows = await input.membershipStore.loadAll();
        this.restoreMembershipRecords(membershipRows);
      } catch (error) {
        input.warn(
          `Failed to load local-create membership provenance: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const contextGraphPrefix = 'did:dkg:context-graph:';
    const selfCreatorDid = assertSafeIri(`did:dkg:agent:${input.peerId}`);
    try {
      const result = await input.store.query(`
        SELECT DISTINCT ?contextGraph ?registrationGraph ?status WHERE {
          GRAPH ?definitionGraph {
            ?contextGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> ;
              <${DKG_ONTOLOGY.DKG_CREATOR}> <${selfCreatorDid}> .
          }
          GRAPH ?registrationGraph {
            ?contextGraph <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status .
          }
        }
      `, { source: 'agent.contextGraph.localCreateProvenance' });
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const contextGraphUri = strip(row['contextGraph'] ?? '');
          if (!contextGraphUri.startsWith(contextGraphPrefix)) continue;
          const contextGraphId = contextGraphUri.slice(contextGraphPrefix.length);
          if (!contextGraphId) continue;
          if (
            strip(row['registrationGraph'] ?? '')
              !== contextGraphMetaGraphUri(contextGraphId)
          ) {
            continue;
          }
          if (stripLiteral(row['status'] ?? '') !== 'unregistered') continue;
          this.recordLocalCreate(contextGraphId);
        }
      }
    } catch (error) {
      input.warn(
        `Failed to restore RDF local-create provenance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return membershipRows;
  }
}
