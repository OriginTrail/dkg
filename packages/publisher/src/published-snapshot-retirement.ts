import { assertSafeIri } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ENTITY_SHARE_METADATA_PREDICATES as F } from './entity-share-metadata.js';
import { clearDischargedStorageAckCopies } from './storage-ack-copy-cleanup.js';
import { assertWorkspaceSnapshotLifecycle, withClientDeadline, type WorkspaceSnapshotLifecycle } from './workspace-snapshot-lifecycle.js';

const RETIREMENT_LOOKUP_TIMEOUT_MS = 2_000;
/** The StorageACK copy cleanup is one store update, which may remove many rows: it gets a longer bound than a lookup. */
const STORAGE_ACK_COPY_UPDATE_TIMEOUT_MS = 10_000;

/** Schedule only at the durable publication boundary, before removing SWM refs. */
export class PublishedSnapshotRetirement {
  constructor(private readonly store: TripleStore, private readonly lifecycle?: WorkspaceSnapshotLifecycle) {
    // The publisher builds this when it starts, so a lifecycle that breaks the contract fails there, loudly,
    // and not at the first publication.
    assertWorkspaceSnapshotLifecycle(lifecycle);
  }

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
   * that a core signed only keep the snapshot referenced until the SWM TTL. This removes the ones
   * the cleanup discharges, in one store update (see storage-ack-copy-cleanup.ts for the rule).
   * Call it before the asset's own operation rows are deleted: the update reads its version
   * boundary from them. Failures never fail the publication: a failed or timed-out update is
   * reported through `warn` and leaves the rows (and so the file referenced) in place. The wait is
   * bounded here on the client side, without an abort signal into the store; an update that is
   * still running when the bound passes finds no boundary once the operation rows are gone, so it
   * cannot remove anything the cleanup did not discharge.
   */
  async clearStorageAckCopies(
    metaGraph: string,
    kaUal: string,
    cleanedOperations: readonly string[],
    warn: (message: string) => void,
  ): Promise<void> {
    if (!this.lifecycle?.finalizedCleanupEnabled || cleanedOperations.length === 0) return;
    try {
      await withClientDeadline(
        clearDischargedStorageAckCopies(this.store, { metaGraph, kaUal, cleanedOperations }),
        STORAGE_ACK_COPY_UPDATE_TIMEOUT_MS,
        'Storage ACK copy cleanup timed out',
      );
    } catch (error) {
      warn(`Could not clear storage ACK copy metadata after publication: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
