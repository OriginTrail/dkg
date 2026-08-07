// SPDX-License-Identifier: Apache-2.0

import type {
  Digest32V1,
  SystemRecordObjectKindV1,
} from '@origintrail-official/dkg-core/system-record-v1';

export interface SystemRecordArtifactV1 {
  readonly objectKind: SystemRecordObjectKindV1;
  readonly objectDigest: Digest32V1;
  readonly canonicalBytes: Uint8Array;
}

export function systemRecordArtifactKeyV1(
  artifact: Pick<SystemRecordArtifactV1, 'objectKind' | 'objectDigest'>,
): string {
  return `${artifact.objectKind}:${artifact.objectDigest}`;
}

export function cloneSystemRecordArtifactV1(
  artifact: SystemRecordArtifactV1,
): SystemRecordArtifactV1 {
  return Object.freeze({
    objectKind: artifact.objectKind,
    objectDigest: artifact.objectDigest,
    canonicalBytes: Uint8Array.from(artifact.canonicalBytes),
  });
}

export type SystemRecordArtifactLookupV1 =
  | Readonly<{ type: 'root' }>
  | Readonly<{
    type: 'object';
    objectKind: SystemRecordObjectKindV1;
    objectDigest: Digest32V1;
  }>
  | Readonly<{
    type: 'inventory-object';
    rootDescriptorDigest: Digest32V1;
    path: readonly number[];
    objectKind: 'inventory-internal' | 'inventory-leaf';
    objectDigest: Digest32V1;
  }>;

export interface SystemRecordArtifactRepositoryV1 {
  resolve(
    lookup: SystemRecordArtifactLookupV1,
    signal: AbortSignal,
  ): Promise<SystemRecordArtifactV1 | null>;
}
