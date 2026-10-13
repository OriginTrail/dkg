// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import {
  decodeSwmHead, decodeSwmOperation, decodeSwmOwnership, decodeSwmPublicSlice, indexSwmMetadata, swmRecordKey,
  type AdmittedLegacySwmOperation, type DecodedSwmRecord, type SharedMemoryAdmissionScope, type SwmRecordRejection,
} from './shared-memory-metadata-records.js';

export type { SharedMemoryAdmissionScope } from './shared-memory-metadata-records.js';
export interface AdmittedSharedMemoryMetadata<Scope extends SharedMemoryAdmissionScope = SharedMemoryAdmissionScope> {
  readonly scope: Scope;
  readonly sourceQuads: readonly Quad[];
  readonly records: readonly DecodedSwmRecord[];
  readonly rejections: readonly SwmRecordRejection[];
}

/**
 * Decode protocol shape, not writer authority. Operations establish legacy root
 * membership; dependent slices and ownership can only use those decoded records.
 * Consumers choose their own projection from this source-indexed record model.
 */
export function admitSharedMemoryMetadata<Scope extends SharedMemoryAdmissionScope>(
  sourceQuads: readonly Quad[], scope: Scope,
): AdmittedSharedMemoryMetadata<Scope> {
  const { sources, rejections } = indexSwmMetadata(sourceQuads, scope);
  const records: DecodedSwmRecord[] = [];
  const operations = new Map<string, AdmittedLegacySwmOperation>();
  const roots = new Set<string>();
  const rootCreators = new Map<string, Set<string>>();
  const protocolSubjects = new Set<string>();
  for (const source of sources) {
    const operation = decodeSwmOperation(source, scope);
    const decoded = operation && operation.role !== 'rejected' ? operation : decodeSwmHead(source) ?? operation;
    if (!decoded) continue;
    const key = swmRecordKey(source.metaGraph, source.subject);
    protocolSubjects.add(key);
    if (decoded.role === 'rejected') { rejections.push(decoded); continue; }
    records.push(decoded);
    if (decoded.role === 'legacyOperation') {
      operations.set(key, decoded);
      for (const root of decoded.roots) {
        const rootKey = swmRecordKey(source.metaGraph, root);
        roots.add(rootKey);
        let creators = rootCreators.get(rootKey);
        if (!creators) { creators = new Set(); rootCreators.set(rootKey, creators); }
        if (decoded.creator) creators.add(decoded.creator);
      }
    }
  }
  for (const source of sources) {
    const key = swmRecordKey(source.metaGraph, source.subject);
    const protocolSubject = protocolSubjects.has(key);
    const slice = protocolSubject ? undefined : decodeSwmPublicSlice(source, operations, roots.has(key));
    if (slice) {
      if (slice.role === 'rejected') rejections.push(slice); else records.push(slice);
    }
    // A legitimate user root may also name a protocol record. Preserve its
    // durable owner only when an admitted same-lane operation names that peer.
    const ownership = decodeSwmOwnership(source, roots.has(key),
      protocolSubject || slice ? rootCreators.get(key) ?? new Set() : undefined);
    if (ownership) records.push(ownership);
  }
  return { scope, sourceQuads, records, rejections };
}
