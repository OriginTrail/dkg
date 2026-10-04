// SPDX-License-Identifier: Apache-2.0
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { hexlify } from 'ethers';
import type { ConfirmedNamedKaVmPublication } from './named-ka-vm-lifecycle-recovery-error.js';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';

export interface ConfirmedNamedKaVmCoordinates {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly priorMerkleRoot?: string;
  /** The already resolved graph-scoped identity takes precedence over receipt fallbacks. */
  readonly packedKaId?: bigint;
}

/** Derive repair evidence once from the admitted confirmation, never from a second root/version description. */
export function confirmedNamedKaVmLifecycleInput(
  publication: ConfirmedNamedKaVmPublication,
  coordinates: ConfirmedNamedKaVmCoordinates,
): ConfirmedNamedKaVmLifecycleInput {
  const { seal } = publication;
  if (publication.status !== 'confirmed' || seal.kaUal === undefined || seal.assertionVersion === undefined) {
    throw Object.assign(new Error('Confirmed named KA repair requires a validated graph-scoped publication'), {
      code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY',
    });
  }
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const packedKaId = coordinates.packedKaId ?? publication.onChainResult?.kaId ?? publication.kaId;
  return Object.freeze({
    contextGraphId: coordinates.contextGraphId, name: coordinates.name, agentAddress: coordinates.agentAddress,
    ...(coordinates.subGraphName === undefined ? {} : { subGraphName: coordinates.subGraphName }),
    ...(coordinates.priorMerkleRoot === undefined ? {} : { priorMerkleRoot: coordinates.priorMerkleRoot }),
    ...(packedKaId === undefined ? {} : { packedKaId }),
    publishedUal: publication.ual, merkleRoot: hexlify(seal.merkleRoot), assertionVersion: scope.assertionVersion,
    publicationDeployment: Object.freeze({ chainId: seal.chainId.toString(), lifecycleAddress: seal.kav10Address }),
  });
}
