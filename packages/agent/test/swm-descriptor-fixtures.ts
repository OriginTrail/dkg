/**
 * Shared graph-scoped SWM share fixtures (#2050).
 *
 * Extracted from `swm-snapshot-materializer.test.ts` so the throw-path row in
 * `sync-requester-progress.test.ts` can build DESCRIPTOR-shaped metadata rather
 * than hand-rolling a fourth one.
 *
 * Why sharing matters more than the duplication it saves: materialization is
 * gated on `snapshotDescriptorsByRef.size > 0`, which is populated by
 * `parseGraphScopedSwmRecoveryDescriptors`. Metadata that carries only
 * `publicQuadsDigest`/`publicQuadsCount` is `collectPublicSnapshotMetadata`
 * shape — enough to enumerate refs, NOT enough to produce a descriptor. A
 * fixture in that shape leaves the map empty, so nothing materializes and
 * `snapshotsResolved` stays 0 for a reason that has nothing to do with the code
 * under test.
 *
 * Worse, getting it subtly wrong does not error: `validateOperationRows` throws
 * on a `kaUal`/`assertionVersion` mismatch, `runSharedMemorySync` catches it and
 * calls `snapshotDescriptorsByRef.clear()`, and materialization is SILENTLY
 * disabled for the whole Context Graph. A wrong fixture stops testing rather
 * than failing.
 *
 * These builders are known-good by provenance: the partial-round row built on
 * them failed on the pre-fix tree with `expected [] to deeply equal [ …(2) ]`
 * against a real `OxigraphStore`, which is only reachable if the descriptors
 * they produce are real.
 */
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphWorkspaceMetaGraphUri,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  generateKnowledgeAssetShareMetadata,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';

const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

export interface ShareOptions {
  version: number;
  operationId: string;
  marker: string;
  ual: string;
  /**
   * Payload size. Distinct sizes across a manifest make a KA materialized in
   * place of another visible in the counters instead of cancelling out.
   */
  payloadCount?: number;
}

export type SwmShare = ReturnType<ReturnType<typeof swmFixtures>['share']>;

/**
 * Builders bound to one Context Graph id. Bound rather than passed per call so
 * a fixture cannot accidentally mix graphs — the meta graph URI, the operation
 * subject and the assertion graph must all agree or the parser rejects the KA.
 */
export function swmFixtures(contextGraphId: string) {
  const metaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);

  /** One complete graph-scoped share: head rows, operation rows, payload, digest. */
  function share(opts: ShareOptions) {
    const scope = createGraphKnowledgeAssetScope(opts.ual, opts.version);
    const assertionGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const operationSubject = `urn:dkg:share:${contextGraphId}:${opts.operationId}`;
    const headSubject = `${opts.ual}#dkg-swm-head`;
    const payload: Quad[] = Array.from({ length: opts.payloadCount ?? 2 }, (_, i) => ({
      subject: `urn:snap:${opts.marker}:${i}`,
      predicate: 'http://schema.org/status',
      object: `"${opts.marker}"`,
      graph: '',
    }));
    const digest = workspacePublicQuadsDigest(payload);
    const meta: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId: opts.operationId,
        contextGraphId,
        kaUal: opts.ual,
        assertionVersion: opts.version,
        publicTripleCount: payload.length,
        privateTripleCount: 0,
        publisherPeerId: 'peer-source',
        // Production share paths always stamp the effective policy row (see
        // the async-lift options default); a policy-less op is the
        // OLD-metadata interop shape, constructed per-row where a test needs
        // it — the preserve gate refuses winners without the explicit row.
        accessPolicy: 'public',
        timestamp: new Date(0),
      }, metaGraph),
      { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: metaGraph },
      { subject: operationSubject, predicate: `${DKG}publicSnapshotRef`, object: `"${digest}"`, graph: metaGraph },
      { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: metaGraph },
      { subject: headSubject, predicate: `${DKG}kaUal`, object: opts.ual, graph: metaGraph },
      { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"${opts.version}"^^<${XSD_INTEGER}>`, graph: metaGraph },
      { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: metaGraph },
      { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${opts.operationId}"`, graph: metaGraph },
    ];
    return {
      version: opts.version, operationId: opts.operationId, operationSubject,
      headSubject, assertionGraph, payload, digest, meta,
    };
  }

  /**
   * N independent KAs — distinct UAL, operation and payload size each.
   *
   * Distinct operations are not cosmetic: two descriptors cannot share an
   * operation subject, because `validateOperationRows` pins it to exactly one
   * `kaUal` at one `assertionVersion`.
   */
  function manifest(count: number, ualPrefix = 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') {
    return Array.from({ length: count }, (_, i) => share({
      version: 1,
      operationId: `op-ka-${i + 1}`,
      marker: `ka-${i + 1}`,
      ual: `${ualPrefix}/${i + 1}`,
      payloadCount: 2 + i,
    }));
  }

  return { metaGraph, share, manifest };
}
