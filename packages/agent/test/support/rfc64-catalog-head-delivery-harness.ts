/**
 * GH#3081 — a catalog head delivery over a simulated head transport, shared by the delivery
 * suites.
 */
import type { SendOptions } from '@origintrail-official/dkg-core';
import { vi } from 'vitest';

import {
  Rfc64CatalogHeadDeliveryV1,
  type Rfc64CatalogHeadDeliveryOptionsV1,
  type Rfc64CatalogHeadDeliveryOutcomeV1,
} from '../../src/rfc64/public-catalog-head-delivery-v1.js';
import {
  Rfc64PublicCatalogTransportErrorV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../../src/rfc64/public-catalog-transport-v1.js';

export const BUDGET_MS = 10_000;
export const AUTHOR = `0x${'a1'.repeat(20)}`;
export const POLICY_DIGEST = `0x${'2e'.repeat(32)}`;

export function head(
  version: string,
  authorAddress = AUTHOR,
  policyDigest = POLICY_DIGEST,
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return {
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/head-delivery',
    subGraphName: null,
    authorAddress,
    catalogEra: '0',
    catalogVersion: version,
    policyDigest,
    catalogHeadObjectDigest: `0x${'aa'.repeat(32)}`,
    signatureVariantDigest: `0x${'bb'.repeat(32)}`,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

export function author(index: number): string {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

export function peers(count: number, prefix = 'peer'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`);
}

export type PeerBehaviour = 'ack' | 'stall' | 'remote-denial' | 'unreachable';

export interface RecordedSend {
  readonly peerId: string;
  readonly version: string;
  readonly author: string;
  readonly options: SendOptions;
}

/**
 * A delivery over a simulated transport. `send` behaves as the head transport does: it asks the
 * policy immediately before the send and refuses with the typed denial, sending nothing. The
 * policy decision is the transport's own, so one `refused` set answers both.
 */
export function harness(overrides: Partial<Rfc64CatalogHeadDeliveryOptionsV1> = {}) {
  const sends: RecordedSend[] = [];
  /** Every peer the transport was asked to send to, including those its own check then refused. */
  const transportCalls: string[] = [];
  const outcomes: Rfc64CatalogHeadDeliveryOutcomeV1[] = [];
  const behaviour = new Map<string, PeerBehaviour>();
  const refused = new Set<string>();
  /** Every peer the policy was asked about without a send, in order. */
  const decisions: string[] = [];
  const inFlightByAuthor = new Map<string, number>();
  const mostInFlightByAuthor = new Map<string, number>();
  const isPeerAuthorized: Rfc64CatalogHeadDeliveryOptionsV1['isPeerAuthorized'] = async (peerId) => {
    decisions.push(peerId);
    return !refused.has(peerId);
  };
  const send: Rfc64CatalogHeadDeliveryOptionsV1['send'] = async (peerId, announcement, options) => {
    transportCalls.push(peerId);
    if (refused.has(peerId)) {
      throw new Rfc64PublicCatalogTransportErrorV1(
        'catalog-transport-policy-denied',
        'catalog operation is not access-policy authorized',
      );
    }
    sends.push({
      peerId,
      version: announcement.catalogVersion,
      author: announcement.authorAddress,
      options,
    });
    const key = announcement.authorAddress;
    const inFlight = (inFlightByAuthor.get(key) ?? 0) + 1;
    inFlightByAuthor.set(key, inFlight);
    mostInFlightByAuthor.set(key, Math.max(mostInFlightByAuthor.get(key) ?? 0, inFlight));
    try {
      switch (behaviour.get(peerId) ?? 'ack') {
        case 'ack':
          return;
        case 'remote-denial':
          throw new Rfc64PublicCatalogTransportErrorV1(
            'catalog-transport-policy-denied',
            'remote peer denied the catalog-head announcement',
          );
        case 'unreachable':
          throw new Error('all multiaddr dials failed');
        case 'stall':
          await new Promise<void>((_resolve, reject) => {
            const signal = options.signal!;
            const onAbort = (): void => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
      }
    } finally {
      inFlightByAuthor.set(key, (inFlightByAuthor.get(key) ?? 1) - 1);
    }
  };
  const delivery = new Rfc64CatalogHeadDeliveryV1({
    send,
    isPeerAuthorized,
    assertDeliverable: () => undefined,
    fanoutBudgetMs: BUDGET_MS,
    onDelivered: (outcome) => { outcomes.push(outcome); },
    now: () => Date.now(),
    ...overrides,
  });
  return {
    delivery, sends, transportCalls, outcomes, behaviour, refused, decisions, mostInFlightByAuthor,
  };
}

/** Run every microtask and timer that is due now, without moving the clock. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
