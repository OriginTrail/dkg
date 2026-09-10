// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import type { AdmittedSharedMemoryMetadata } from './shared-memory-metadata-admission.js';
import {
  swmRecordKey, swmRecordSourceIndices,
  type AdmittedGraphSwmOperation, type AdmittedSwmHead, type SharedMemoryContextScope,
} from './shared-memory-metadata-records.js';

/** Replay source positions, preserving duplicates and order without quad identity. */
export function projectSwmPersistence(model: AdmittedSharedMemoryMetadata): Quad[] {
  const selected = new Set(model.records.flatMap(record => [...swmRecordSourceIndices(record)]));
  return model.sourceQuads.filter((_row, index) => selected.has(index));
}

export interface LegacySwmHydration {
  readonly legacyRoots: ReadonlyMap<string, ReadonlySet<string>>;
  readonly ownership: Array<{ dataGraph: string; entity: string; creator: string }>;
}
export function projectLegacySwmHydration(model: AdmittedSharedMemoryMetadata): LegacySwmHydration {
  const members = model.records.flatMap(record => record.role === 'legacyOperation' && record.published
    ? record.members.map(member => ({ ...member, dataGraph: record.dataGraph, creator: record.creator })) : []);
  // The first published membership in wire order owns a root, even when records
  // are interleaved or decoded in a different order from their member rows.
  members.sort((a, b) => a.sourceIndex - b.sourceIndex);
  const legacyRoots = new Map<string, Set<string>>();
  const ownership = new Map<string, { dataGraph: string; entity: string; creator: string }>();
  for (const { root, dataGraph, creator } of members) {
    let allowed = legacyRoots.get(dataGraph);
    if (!allowed) { allowed = new Set(); legacyRoots.set(dataGraph, allowed); }
    allowed.add(root);
    const key = swmRecordKey(dataGraph, root);
    if (creator && !ownership.has(key)) ownership.set(key, { dataGraph, entity: root, creator });
  }
  return { legacyRoots, ownership: [...ownership.values()] };
}

/** Recovery must name one context and its admitted lanes; broad input is invalid. */
export function projectStrictSwmRecovery(model: AdmittedSharedMemoryMetadata<SharedMemoryContextScope>): {
  heads: AdmittedSwmHead[]; graphOperations: ReadonlyMap<string, AdmittedGraphSwmOperation>;
} {
  for (const rejection of model.rejections) {
    if (rejection.recordRole !== 'head') continue;
    if (rejection.reason === 'outOfScope') {
      throw new Error(`Graph-scoped SWM head ${rejection.subject} is in an unregistered metadata graph ${rejection.metaGraph}`);
    }
    throw new Error(`Graph-scoped SWM head ${rejection.subject} has a non-canonical or mismatched kaUal`);
  }
  const heads: AdmittedSwmHead[] = [];
  const graphOperations = new Map<string, AdmittedGraphSwmOperation>();
  for (const record of model.records) {
    if (record.role === 'head') heads.push(record);
    else if (record.role === 'graphOperation') graphOperations.set(swmRecordKey(record.metaGraph, record.subject), record);
  }
  return { heads, graphOperations };
}
