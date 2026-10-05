// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { readConfirmedDraftVersion } from './confirmed-draft-version.js';

/** Number the draft from confirmed evidence; descriptor stamps alone are only a fallback. */
export async function resolveFinalizedDraftVersion(input: {
  chain: ChainAdapter;
  kaUal: string;
  persistedVersion?: string;
  vmPointerPresent: boolean;
  readLocalNextVersion: () => Promise<bigint | undefined>;
}): Promise<bigint> {
  const localNext = await input.readLocalNextVersion();
  if (input.chain.readKnowledgeAssetVersionSnapshot) {
    const confirmed = await readConfirmedDraftVersion(input.chain, input.kaUal);
    if (confirmed !== null) return confirmed + 1n;
    if (localNext !== undefined || input.vmPointerPresent) {
      throw Object.assign(new Error('Finalization awaits current coherent KA version evidence'), {
        code: 'KA_FINALIZE_VERSION_PROOF_UNAVAILABLE', retryable: true,
      });
    }
  }
  if (localNext !== undefined) return localNext;
  const prior = input.persistedVersion === undefined ? 1n : BigInt(input.persistedVersion);
  return input.vmPointerPresent ? prior + 1n : prior;
}
