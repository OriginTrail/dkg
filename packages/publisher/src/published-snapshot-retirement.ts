import { assertSafeIri } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ENTITY_SHARE_METADATA_PREDICATES as F } from './entity-share-metadata.js';
import type { WorkspaceSnapshotLifecycle } from './workspace-snapshot-lifecycle.js';

/** Schedule only at the durable publication boundary, before removing SWM refs. */
export class PublishedSnapshotRetirement {
  constructor(private readonly store: TripleStore, private readonly lifecycle?: WorkspaceSnapshotLifecycle) {}

  async schedule(metaGraph: string, operationSubjects: readonly string[], warn: (message: string) => void): Promise<void> {
    if (!this.lifecycle?.finalizedCleanupEnabled || operationSubjects.length === 0) return;
    try {
      const result = await this.store.query(`SELECT DISTINCT ?ref WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          VALUES ?operation { ${operationSubjects.map(subject => `<${assertSafeIri(subject)}>`).join(' ')} }
          VALUES ?predicate { <${F.publicSnapshotRef}> <${F.publicQuadsDigest}> }
          ?operation ?predicate ?ref .
          FILTER NOT EXISTS { ?operation <${F.publicSnapshotGraph}> ?graph }
        }
      } LIMIT 64`, { signal: AbortSignal.timeout(2_000) });
      if (result.type !== 'bindings') throw new Error('Snapshot retirement lookup did not return bindings');
      const refs = result.bindings.map(row => row.ref === undefined ? undefined : parseRdfLiteralTerm(row.ref)?.value)
        .filter((ref): ref is string => ref !== undefined && /^(?:sha256:)?[a-fA-F0-9]{64}$/.test(ref));
      await this.lifecycle.markPublished(refs);
    } catch (error) {
      // File cleanup must not report an already durable publication as failed.
      warn(`Could not schedule finalized snapshot cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
