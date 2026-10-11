/**
 * GH#3081 — a catalog head delivery over a simulated head transport, shared by the delivery
 * suites.
 */
import type { SendOptions } from '@origintrail-official/dkg-core';
import { vi } from 'vitest';

import { noteRfc64CatalogPolicyUndecidedV1 } from '../../src/rfc64/catalog-policy-decision-probe-v1.js';
import { withCurrentRfc64CatalogPolicyV1 } from '../../src/rfc64/catalog-transport-authorization-v1.js';
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

/**
 * What a peer does with an announcement. `lapse` acknowledges it, and this node's policy stops
 * authorizing the peer while the send is under way.
 */
export type PeerBehaviour = 'ack' | 'stall' | 'remote-denial' | 'unreachable' | 'lapse';

export interface RecordedSend {
  readonly peerId: string;
  readonly version: string;
  readonly author: string;
  readonly options: SendOptions;
  /** `Date.now()` when the send started. */
  readonly at: number;
}

function policyDenied(message: string): Rfc64PublicCatalogTransportErrorV1 {
  return new Rfc64PublicCatalogTransportErrorV1('catalog-transport-policy-denied', message);
}

/**
 * A delivery over a simulated transport. `send` behaves as the head transport does: it runs the
 * send inside the real policy wrapper, which asks this node's policy immediately before and
 * after it, and it reads the peer's own denial from the reply afterwards.
 *
 * The policy is the two sets: a peer in `refused` gets a plain no, and for a peer in
 * `undecidable` the decision cannot be made, as when an identity lookup fails. For a peer in
 * `hungChecks` the transport's own check before the send never answers.
 */
export function harness(
  overrides: Partial<Rfc64CatalogHeadDeliveryOptionsV1> & { readonly ackDelayMs?: number } = {},
) {
  const { ackDelayMs = 0, ...options } = overrides;
  const sends: RecordedSend[] = [];
  /** Every peer the transport was asked to send to, including those its own check then refused. */
  const transportCalls: string[] = [];
  const outcomes: Rfc64CatalogHeadDeliveryOutcomeV1[] = [];
  const behaviour = new Map<string, PeerBehaviour>();
  const refused = new Set<string>();
  const undecidable = new Set<string>();
  const hungChecks = new Set<string>();
  /** Every peer the policy was asked about without a send, in order. */
  const decisions: string[] = [];
  const inFlightByAuthor = new Map<string, number>();
  const mostInFlightByAuthor = new Map<string, number>();
  const authorizes = (peerId: string): boolean => {
    if (undecidable.has(peerId)) noteRfc64CatalogPolicyUndecidedV1();
    return !undecidable.has(peerId) && !refused.has(peerId);
  };
  const isPeerAuthorized: Rfc64CatalogHeadDeliveryOptionsV1['isPeerAuthorized'] = async (peerId) => {
    decisions.push(peerId);
    return authorizes(peerId);
  };
  const exchange = async (
    peerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    sendOptions: SendOptions,
  ): Promise<'ack' | 'denied'> => {
    sends.push({
      peerId,
      version: announcement.catalogVersion,
      author: announcement.authorAddress,
      options: sendOptions,
      at: Date.now(),
    });
    const key = announcement.authorAddress;
    const inFlight = (inFlightByAuthor.get(key) ?? 0) + 1;
    inFlightByAuthor.set(key, inFlight);
    mostInFlightByAuthor.set(key, Math.max(mostInFlightByAuthor.get(key) ?? 0, inFlight));
    try {
      switch (behaviour.get(peerId) ?? 'ack') {
        case 'remote-denial':
          return 'denied';
        case 'unreachable':
          throw new Error('all multiaddr dials failed');
        case 'stall':
          return await new Promise<never>((_resolve, reject) => {
            const signal = sendOptions.signal!;
            const onAbort = (): void => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        case 'lapse':
          refused.add(peerId);
          return 'ack';
        default:
          if (ackDelayMs > 0) await new Promise((resolve) => { setTimeout(resolve, ackDelayMs); });
          return 'ack';
      }
    } finally {
      inFlightByAuthor.set(key, (inFlightByAuthor.get(key) ?? 1) - 1);
    }
  };
  const send: Rfc64CatalogHeadDeliveryOptionsV1['send'] = async (peerId, announcement, sendOptions) => {
    transportCalls.push(peerId);
    const reply = await withCurrentRfc64CatalogPolicyV1(
      async () => {
        if (hungChecks.has(peerId)) await new Promise(() => undefined);
        if (!authorizes(peerId)) throw policyDenied('catalog operation is not access-policy authorized');
      },
      () => exchange(peerId, announcement, sendOptions),
    );
    if (reply === 'denied') throw policyDenied('remote peer denied the catalog-head announcement');
  };
  const delivery = new Rfc64CatalogHeadDeliveryV1({
    send,
    isPeerAuthorized,
    assertDeliverable: () => undefined,
    fanoutBudgetMs: BUDGET_MS,
    onDelivered: (outcome) => { outcomes.push(outcome); },
    now: () => Date.now(),
    ...options,
  });
  return {
    delivery,
    sends,
    transportCalls,
    outcomes,
    behaviour,
    refused,
    undecidable,
    hungChecks,
    decisions,
    mostInFlightByAuthor,
  };
}

/** Run every microtask and timer that is due now, without moving the clock. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
