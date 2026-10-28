// SPDX-License-Identifier: Apache-2.0
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import type { FinalizedAssertionReservation } from './finalized-assertion-reservation.js';
import { resolveConfirmedGraphScopedVm } from '../confirmed-graph-scoped-vm-resolver.js';
const refused = (message: string) => Object.assign(new Error(message), { code: 'KA_MINT_RECONCILE_REFUSED' });

/** Verify the exact local mint under the materialization lock immediately before completion. */
export async function verifyNamedMintRecord(store: TripleStore, reservation: FinalizedAssertionReservation,
  target: { contextGraphId: string; name: string; subGraphName?: string }, mint: OnChainPublishResult): Promise<void> {
  const { seal, scope, kaId } = reservation;
  const record = await resolveConfirmedGraphScopedVm(store, {
    contextGraphId: target.contextGraphId,
    ual: scope.ual,
    assertionVersion: BigInt(scope.assertionVersion),
    merkleRoot: seal.merkleRoot,
    kaId,
    batchId: kaId,
    subGraphName: target.subGraphName,
  });
  const envelope = record.status === 'verified' ? record.envelope : undefined;
  if (!envelope || envelope.publicTripleCount !== seal.publicTripleCount
    || envelope.privateTripleCount !== (seal.privateTripleCount ?? 0)) {
    throw refused(
      `This node holds no verified record for "${target.name}" of the sealed content ` +
        `(${record.status === 'invalid' ? record.reason : record.status}), so there is nothing to complete.`,
    );
  }
  if (envelope.transactionHash !== undefined && envelope.transactionHash.toLowerCase() !== mint.txHash.toLowerCase()) {
    throw refused(`The local record of "${target.name}" names transaction ${envelope.transactionHash}, not the mint ${mint.txHash}.`);
  }
}
