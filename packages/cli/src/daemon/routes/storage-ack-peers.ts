import type { PublishResult } from '@origintrail-official/dkg-publisher';

type StorageAckPublishResult = Pick<PublishResult, 'status' | 'v10ACKs'>;

/**
 * Return the distinct Core peer IDs that actually backed a confirmed publish.
 * Signatures and node identities intentionally stay inside the daemon.
 */
export function storageAckPeerIdsFromPublishResult(
  result: StorageAckPublishResult | null | undefined,
): string[] {
  if (result?.status !== 'confirmed') return [];

  return [
    ...new Set(
      (result.v10ACKs ?? [])
        .map(({ peerId }) => (typeof peerId === 'string' ? peerId.trim() : ''))
        .filter(Boolean),
    ),
  ];
}
