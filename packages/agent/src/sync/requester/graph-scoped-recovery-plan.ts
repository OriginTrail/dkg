import { quarantineUnusableSwmHistory } from './swm-history-admission.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  canonicalGraphScopedSnapshotManifestQuads,
  canonicalizeGraphScopedSwmHeadRows,
  parseGraphScopedSwmRecoveryHeadResults,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';
import type { GraphScopedSwmRecoveryParseInput } from '../graph-scoped-swm-head-parser.js';
import { collectPublicSnapshotManifest } from './public-snapshot-manifest.js';

/** One round owns the original evidence, accepted descriptors and ref exclusions together. */
export function createGraphScopedRecoveryPlan(input: GraphScopedSwmRecoveryParseInput, parse: boolean) {
  const originalMetadata = Object.freeze(input.metaQuads.map(row => Object.freeze({ ...row })));
  let descriptors: GraphScopedSwmRecoveryDescriptor[] = [];
  let verifiedMetaForInsert: readonly Quad[] = originalMetadata;
  let manifestMetadata: readonly Quad[] = originalMetadata;
  let descriptorsAuthoritative = true;
  let diagnostic: string | undefined;
  const blockedRefs = new Set<string>();
  let blocksEveryRef = false;
  if (parse) {
    try {
      const result = parseGraphScopedSwmRecoveryHeadResults({ ...input, metaQuads: originalMetadata });
      descriptors = result.descriptors;
      descriptorsAuthoritative = result.setAside.length === 0;
      if (result.setAside.length > 0) {
        const sources = collectPublicSnapshotManifest(originalMetadata).sourceSubjectsByRef;
        blocksEveryRef = result.setAside.some(head => head.operationSubjects.length === 0);
        const rejectedSubjects = new Set(result.setAside.flatMap(head => head.operationSubjects));
        for (const [ref, subjects] of sources) {
          for (const subject of subjects) if (rejectedSubjects.has(subject)) { blockedRefs.add(ref); break; }
        }
        const first = result.setAside[0]!;
        diagnostic = `set aside ${result.setAside.length} graph-scoped head(s) and kept ${descriptors.length}: ${first.headSubject}: ${first.error.message}`;
      }
      const referenced = [...descriptors.flatMap(d => d.equivalentOperationSubjects.map(subject => ({ graph: d.metaGraph, subject }))),
        ...result.setAside.flatMap(h => h.operationSubjects.map(subject => ({ graph: h.metaGraph, subject })))];
      const admitted = quarantineUnusableSwmHistory(originalMetadata, referenced);
      verifiedMetaForInsert = canonicalizeGraphScopedSwmHeadRows({ metaQuads: admitted, descriptors });
      manifestMetadata = canonicalGraphScopedSnapshotManifestQuads(admitted, descriptors);
    } catch (error) {
      descriptors = [];
      descriptorsAuthoritative = false;
      blocksEveryRef = true;
      diagnostic = `could not parse graph-scoped snapshot descriptors: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const byRef = new Map<string, GraphScopedSwmRecoveryDescriptor[]>();
  const graphBackedDescriptors: GraphScopedSwmRecoveryDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.snapshotSource.locator.kind === 'graph') graphBackedDescriptors.push(descriptor);
    else {
      const ref = descriptor.snapshotSource.locator.ref;
      let bucket = byRef.get(ref);
      if (bucket === undefined) { bucket = []; byRef.set(ref, bucket); }
      bucket.push(descriptor);
    }
  }
  const snapshotDescriptorsByRef: ReadonlyMap<string, readonly GraphScopedSwmRecoveryDescriptor[]> =
    new Map([...byRef].map(([ref, values]) => [ref, Object.freeze(values)]));
  return Object.freeze({
    originalMetadata,
    verifiedMetaForInsert: Object.freeze([...verifiedMetaForInsert]),
    manifestMetadata: Object.freeze([...manifestMetadata]),
    manifest: collectPublicSnapshotManifest(manifestMetadata),
    graphBackedDescriptors: Object.freeze(graphBackedDescriptors),
    snapshotDescriptorsByRef,
    descriptorsAuthoritative,
    diagnostic,
    blocksRef: (ref: string) => blocksEveryRef || blockedRefs.has(ref),
  });
}
