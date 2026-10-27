// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from './graph-scoped-swm-recovery.js';
import { stripMetadataLiteral } from './metadata-literal.js';

export const SWM_HEAD_SUFFIX = '#dkg-swm-head';
export const SWM_SHARE_OPERATION_ID = 'http://dkg.io/ontology/shareOperationId';
export interface HeadOperationReference {
  readonly shareOperationId: string;
  readonly operationSubject: string;
}
export interface SwmRecoveryHead {
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly headRows: readonly Quad[];
  readonly operationReferences: readonly HeadOperationReference[];
}
export interface SetAsideGraphScopedSwmHead {
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly operationSubjects: readonly string[];
  readonly error: Error;
}

export function parseGraphScopedSwmHeads(
  params: { readonly contextGraphId: string; readonly metaQuads: readonly Quad[] },
  mode: 'strict' | 'set-aside',
  decode: (head: SwmRecoveryHead, index: ReadonlyMap<string, readonly Quad[]>) => GraphScopedSwmRecoveryDescriptor,
): { descriptors: GraphScopedSwmRecoveryDescriptor[]; setAside: SetAsideGraphScopedSwmHead[] } {
  const index = new Map<string, Quad[]>();
  for (const quad of params.metaQuads) {
    const key = `${quad.graph}\u0000${quad.subject}`;
    const rows = index.get(key);
    if (rows) rows.push(quad); else index.set(key, [quad]);
  }
  const descriptors: GraphScopedSwmRecoveryDescriptor[] = [];
  const setAside: SetAsideGraphScopedSwmHead[] = [];
  for (const [key, headRows] of index) {
    const separator = key.indexOf('\u0000');
    const metaGraph = key.slice(0, separator);
    const headSubject = key.slice(separator + 1);
    if (!headSubject.endsWith(SWM_HEAD_SUFFIX)) continue;
    const operationReferences = [...new Set(headRows.filter(row => row.predicate === SWM_SHARE_OPERATION_ID)
      .map(row => stripMetadataLiteral(row.object).trim()))]
      .map(shareOperationId => ({ shareOperationId, operationSubject: `urn:dkg:share:${params.contextGraphId}:${shareOperationId}` }));
    try {
      descriptors.push(decode({ metaGraph, headSubject, headRows, operationReferences }, index));
    } catch (error) {
      if (mode === 'strict') throw error;
      setAside.push({
        metaGraph, headSubject,
        operationSubjects: operationReferences.filter(ref => ref.shareOperationId.length > 0).map(ref => ref.operationSubject),
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  // Cross-head ownership conflicts always reject the generation, even after isolated failures.
  const owners = new Map<string, string>();
  for (const descriptor of descriptors) {
    const owner = owners.get(descriptor.assertionGraph);
    if (owner && owner !== descriptor.kaUal) {
      throw new Error(`Graph-scoped SWM assertion graph ${descriptor.assertionGraph} has multiple UAL owners`);
    }
    owners.set(descriptor.assertionGraph, descriptor.kaUal);
  }
  return { descriptors, setAside };
}
