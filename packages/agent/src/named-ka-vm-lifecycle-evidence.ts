// SPDX-License-Identifier: Apache-2.0
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { hexlify } from 'ethers';
import type { ConfirmedNamedKaVmPublication } from './named-ka-vm-lifecycle-recovery-error.js';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';

import { confirmedLifecycleMaterialization, type ConfirmedLifecyclePublicSnapshot } from './named-ka-vm-lifecycle-materialization.js';

export interface ConfirmedNamedKaVmCoordinates {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly priorMerkleRoot?: string;
  /** The authoritative graph-scoped identity resolved by the caller. */
  readonly packedKaId: bigint;
}

/** Derive repair evidence once from the admitted confirmation, never from a second root/version description. */
export function confirmedNamedKaVmLifecycleInput(
  publication: ConfirmedNamedKaVmPublication,
  coordinates: ConfirmedNamedKaVmCoordinates,
  snapshot?: ConfirmedLifecyclePublicSnapshot,
): ConfirmedNamedKaVmLifecycleInput {
  const { seal } = publication;
  if (publication.status !== 'confirmed' || seal.kaUal === undefined || seal.assertionVersion === undefined) {
    throw new NamedKaVmLifecycleIntegrityError('Confirmed named KA repair requires a validated graph-scoped publication');
  }
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const input: ConfirmedNamedKaVmLifecycleInput = {
    contextGraphId: coordinates.contextGraphId, name: coordinates.name, agentAddress: coordinates.agentAddress,
    ...(coordinates.subGraphName === undefined ? {} : { subGraphName: coordinates.subGraphName }),
    ...(coordinates.priorMerkleRoot === undefined ? {} : { priorMerkleRoot: coordinates.priorMerkleRoot }),
    packedKaId: coordinates.packedKaId,
    publishedUal: publication.ual, merkleRoot: hexlify(seal.merkleRoot), assertionVersion: scope.assertionVersion,
    publicationDeployment: Object.freeze({ chainId: seal.chainId.toString(), lifecycleAddress: seal.kav10Address }),
  };
  return Object.freeze({ ...input, ...(snapshot === undefined ? {} : { materialization: confirmedLifecycleMaterialization(input, publication, snapshot) }) });
}
