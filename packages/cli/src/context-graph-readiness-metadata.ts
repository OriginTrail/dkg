// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphReadinessMetadataV1 } from '@origintrail-official/dkg-agent';

export type ContextGraphCatchupMetadataInput =
  | { metadata: ContextGraphReadinessMetadataV1; hasConfirmedMeta?: never; isPrivate?: never }
  | { metadata?: never; hasConfirmedMeta: boolean | undefined; isPrivate: boolean };

/** Keep legacy classifier inputs compatible while the completion owner uses tagged facts. */
export function contextGraphCatchupMetadataState(
  input: ContextGraphCatchupMetadataInput,
): ContextGraphReadinessMetadataV1 {
  if (input.metadata !== undefined) return input.metadata;
  if (input.hasConfirmedMeta === undefined) return { kind: 'unchecked' };
  if (!input.hasConfirmedMeta) return { kind: 'absent' };
  return { kind: 'confirmed', accessPolicy: input.isPrivate ? 'private' : 'public' };
}
