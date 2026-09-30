import { assertSafeIri } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { deleteByPatternWithoutCount, type TripleStore } from '@origintrail-official/dkg-storage';
import { ENTITY_SHARE_METADATA_PREDICATES as F } from './entity-share-metadata.js';
import { withClientDeadline, type WorkspaceSnapshotLifecycle } from './workspace-snapshot-lifecycle.js';

const RETIREMENT_LOOKUP_TIMEOUT_MS = 2_000;
const DKG = 'http://dkg.io/ontology/';
/** `dkg:shareOperationId` prefix of every operation a StorageACK persisted (see storage-ack-ledger.ts). */
const STORAGE_ACK_SHARE_OPERATION_ID_PREFIX = 'storage-ack-';
const STORAGE_ACK_COPY_LOOKUP_LIMIT = 64;

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
   * A core that signed a StorageACK for this asset keeps that copy's operation row beside the
   * publisher's own, carrying the same snapshot digest. Once the asset is durable in VM and its
   * SWM graph is dropped, that row describes data that no longer exists, yet it would keep the
   * snapshot referenced until the SWM TTL. This finds the rows of copies at or below the version
   * being cleaned up (call it before the asset's own operation rows are deleted, which is where
   * that version is read from). A later version's copy, another asset's copy and every other
   * kind of operation are not returned, so anything that could still need the bytes keeps
   * counting as a reference. A failure returns nothing, which keeps the file (the safe direction).
   */
  async findDischargedStorageAckCopies(
    metaGraph: string,
    kaUal: string,
    cleanedOperations: readonly string[],
    warn: (message: string) => void,
  ): Promise<string[]> {
    if (!this.lifecycle?.finalizedCleanupEnabled || cleanedOperations.length === 0) return [];
    try {
      const result = await withClientDeadline(this.store.query(`SELECT DISTINCT ?operation ?shareId ?version WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          ?operation <${F.type}> <${DKG}WorkspaceOperation> ;
            <${F.shareOperationId}> ?shareId ;
            <${DKG}kaUal> <${assertSafeIri(kaUal)}> ;
            <${DKG}assertionVersion> ?version .
        }
      } LIMIT ${STORAGE_ACK_COPY_LOOKUP_LIMIT}`), RETIREMENT_LOOKUP_TIMEOUT_MS, 'Storage ACK copy lookup timed out');
      if (result.type !== 'bindings') throw new Error('Storage ACK copy lookup did not return bindings');
      const cleaned = new Set(cleanedOperations);
      const rows = result.bindings.flatMap(row => {
        const operation = row['operation'];
        const shareId = row['shareId'] === undefined ? undefined : parseRdfLiteralTerm(row['shareId'])?.value;
        const version = Number(row['version'] === undefined ? Number.NaN : parseRdfLiteralTerm(row['version'])?.value);
        return operation === undefined || shareId === undefined || !Number.isSafeInteger(version)
          ? [] : [{ operation, shareId, version }];
      });
      const cleanedVersion = Math.max(-1, ...rows.filter(row => cleaned.has(row.operation)).map(row => row.version));
      if (cleanedVersion < 0) return [];
      return rows.filter(row => !cleaned.has(row.operation) && row.version <= cleanedVersion
        && row.shareId.startsWith(STORAGE_ACK_SHARE_OPERATION_ID_PREFIX)).map(row => row.operation);
    } catch (error) {
      warn(`Could not look up storage ACK copy metadata for cleanup: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** Remove the operation rows {@link findDischargedStorageAckCopies} returned. */
  async clearStorageAckCopies(metaGraph: string, operations: readonly string[], warn: (message: string) => void): Promise<void> {
    for (const operation of operations) {
      try {
        await deleteByPatternWithoutCount(this.store, { graph: metaGraph, subject: assertSafeIri(operation) });
      } catch (error) {
        warn(`Could not clear storage ACK copy metadata after publication: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }
}
