// SPDX-License-Identifier: Apache-2.0
import type { RequestContext } from './context.js';
import { isConfirmedNamedKaVmLifecycleRecoveryError } from '@origintrail-official/dkg-agent';
import { storageAckPeerIdsFromPublishResult } from './storage-ack-peers.js';
const hex = (bytes: Uint8Array): string => '0x' + Buffer.from(bytes).toString('hex');

export type FinalizedPublishResult = Awaited<
  ReturnType<RequestContext["agent"]["publishFromFinalizedAssertion"]>
> & {
  /** Backward-compatible response aliases still accepted by the HTTP route. */
  authorAddress?: string;
  kas?: unknown[];
};

/** The same sealed-to-minted projection is used after normal completion and failed local admission. */
export function vmPublishResponseBody(pub: FinalizedPublishResult, reason?: string): Record<string, unknown> {
  const storageAckPeerIds = storageAckPeerIdsFromPublishResult(pub);
  return {
    kaId: pub?.kaId,
    status: pub?.status,
    ...(pub?.lifecycleRepairPending ? { lifecycleRepairPending: true } : {}),
    ual: pub?.ual,
    txHash: pub?.onChainResult?.txHash,
    ...(pub?.assertionUri !== undefined ? { assertionUri: pub.assertionUri } : {}),
    ...(pub?.seal?.authorAddress ?? pub?.authorAddress ? { authorAddress: pub?.seal?.authorAddress ?? pub?.authorAddress } : {}),
    ...(pub?.merkleRoot !== undefined
      ? { merkleRoot: typeof pub.merkleRoot === "string" ? pub.merkleRoot : hex(pub.merkleRoot) }
      : {}),
    ...(Array.isArray(pub?.kas) ? { kas: pub.kas } : {}),
    ...(pub?.onChainResult?.blockNumber !== undefined ? { blockNumber: pub.onChainResult.blockNumber } : {}),
    ...(pub?.onChainResult?.convictionCostCovered ? { convictionCostCovered: pub.onChainResult.convictionCostCovered } : {}),
    ...(typeof pub?.contextGraphError === "string" ? { contextGraphError: pub.contextGraphError } : {}),
    ...(storageAckPeerIds.length > 0 ? { storageAckPeerIds } : {}),
    ...(reason ? { error: reason } : {}),
  };
}

/** Confirmation survives a failed write-ahead admission; publication must never be retried. */
export function confirmedVmRecoveryRequiredResponse(error: unknown): Record<string, unknown> | undefined {
  if (!isConfirmedNamedKaVmLifecycleRecoveryError(error)) return undefined;
  return {
    ...vmPublishResponseBody(error.confirmedPublication),
    onChainResult: error.confirmedPublication.onChainResult,
    code: error.code,
    error: 'Publication confirmed, but local lifecycle recovery was not admitted. Restore local persistence and recover the confirmed publication.',
    lifecycleRecoveryRequired: true, lifecycleRepairAdmitted: false, lifecycleRepairPending: false,
    recovery: error.lifecycleRecovery,
  };
}
