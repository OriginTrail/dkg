import { assertSafeIri } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ENTITY_SHARE_METADATA_PREDICATES as F } from './entity-share-metadata.js';
import {
  clearDischargedStorageAckCopies, noDischargedStorageAckCopies, planDischargedStorageAckCopies,
  type DischargedStorageAckCopies,
} from './storage-ack-copy-cleanup.js';
import { withClientDeadline, type WorkspaceSnapshotLifecycle } from './workspace-snapshot-lifecycle.js';

const RETIREMENT_LOOKUP_TIMEOUT_MS = 2_000;
/** The whole StorageACK copy plan (boundary query plus every page), not one round trip. */
const STORAGE_ACK_COPY_PLAN_BUDGET_MS = 10_000;

/** Schedule only at the durable publication boundary, before removing SWM refs. */
export class PublishedSnapshotRetirement {
  constructor(private readonly store: TripleStore, private readonly lifecycle?: WorkspaceSnapshotLifecycle) {}

  async schedule(metaGraph: string, operationSubjects: readonly string[], warn: (message: string) => void): Promise<void> {
    if (!this.lifecycle?.finalizedCleanupEnabled || operationSubjects.length === 0) return;
    try {
      // The wait is bounded here, not by an abort signal passed into the store.
      const result = await withClientDeadline(this.store.query(`SELECT DISTINCT ?ref WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          VALUES ?operation { ${operationSubjects.map(subject => `<${assertSafeIri(subject)}>`).join(' ')} }
          VALUES ?predicate { <${F.publicSnapshotRef}> <${F.publicQuadsDigest}> }
          ?operation ?predicate ?ref .
          FILTER NOT EXISTS { ?operation <${F.publicSnapshotGraph}> ?graph }
        }
      } LIMIT 64`), RETIREMENT_LOOKUP_TIMEOUT_MS, 'Snapshot retirement lookup timed out');
      if (result.type !== 'bindings') throw new Error('Snapshot retirement lookup did not return bindings');
      const refs = result.bindings.map(row => row.ref === undefined ? undefined : parseRdfLiteralTerm(row.ref)?.value)
        .filter((ref): ref is string => ref !== undefined && /^(?:sha256:)?[a-fA-F0-9]{64}$/.test(ref));
      await this.lifecycle.markPublished(refs);
    } catch (error) {
      // File cleanup must not report an already durable publication as failed.
      warn(`Could not schedule finalized snapshot cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Once the asset is durable in VM and its SWM graph is dropped, the StorageACK copies of it
   * that a core signed only keep the snapshot referenced until the SWM TTL. This asks the
   * StorageACK layer which copies the cleanup discharges (see storage-ack-copy-cleanup.ts for
   * the rule); call it before the asset's own operation rows are deleted, which is where the
   * version boundary is read from. A failure or timeout plans nothing, which keeps the file
   * (the safe direction).
   */
  async findDischargedStorageAckCopies(
    metaGraph: string,
    kaUal: string,
    cleanedOperations: readonly string[],
    warn: (message: string) => void,
  ): Promise<DischargedStorageAckCopies> {
    if (!this.lifecycle?.finalizedCleanupEnabled || cleanedOperations.length === 0) {
      return noDischargedStorageAckCopies(metaGraph);
    }
    try {
      // Each store round trip is bounded here, not by an abort signal passed into the store.
      const plan = await planDischargedStorageAckCopies({
        query: sparql => withClientDeadline(this.store.query(sparql), RETIREMENT_LOOKUP_TIMEOUT_MS,
          'Storage ACK copy lookup timed out'),
      }, { metaGraph, kaUal, cleanedOperations }, { deadlineAt: Date.now() + STORAGE_ACK_COPY_PLAN_BUDGET_MS });
      if (plan.truncated) warn(`Storage ACK copy cleanup reached its page or time limit; ${plan.operations.length} copies are planned for removal and any others stay`);
      return plan;
    } catch (error) {
      warn(`Could not look up storage ACK copy metadata for cleanup: ${error instanceof Error ? error.message : String(error)}`);
      return noDischargedStorageAckCopies(metaGraph);
    }
  }

  /** Remove the copies {@link findDischargedStorageAckCopies} planned, in one store update. */
  async clearStorageAckCopies(plan: DischargedStorageAckCopies, warn: (message: string) => void): Promise<void> {
    try {
      await clearDischargedStorageAckCopies(this.store, plan);
    } catch (error) {
      warn(`Could not clear storage ACK copy metadata after publication: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
