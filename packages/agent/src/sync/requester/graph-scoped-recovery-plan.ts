import type { Quad } from '@origintrail-official/dkg-storage';
import {
  canonicalGraphScopedSnapshotManifestQuads,
  canonicalizeGraphScopedSwmHeadRows,
  parseGraphScopedSwmRecoveryHeadResults,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';
import type { GraphScopedSwmRecoveryParseInput } from '../graph-scoped-swm-head-parser.js';
import { collectPublicSnapshotManifest } from './public-snapshot-manifest.js';
import { setAsideHeadsMayOwnRef } from '../graph-scoped-swm-set-aside.js';

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
        for (const ref of sources.keys()) {
          if (setAsideHeadsMayOwnRef(result.setAside, ref, sources)) blockedRefs.add(ref);
        }
        const first = result.setAside[0]!;
        diagnostic = `set aside ${result.setAside.length} graph-scoped head(s) and kept ${descriptors.length}: ${first.headSubject}: ${first.error.message}`;
      }
      verifiedMetaForInsert = canonicalizeGraphScopedSwmHeadRows({ metaQuads: originalMetadata, descriptors });
      manifestMetadata = canonicalGraphScopedSnapshotManifestQuads(originalMetadata, descriptors);
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
      byRef.set(ref, [...(byRef.get(ref) ?? []), descriptor]);
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
