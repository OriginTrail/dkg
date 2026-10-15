// SPDX-License-Identifier: Apache-2.0

/**
 * The peers of a catalog-head replay: a peer that asks this node to replay a
 * graph's catalog heads, and a peer this node asked that gave no answer.
 */

import { createOperationContext, type Logger } from '@origintrail-official/dkg-core';
import {
  noteCatalogHeadReplayFollower,
  type SharedMemoryFollowers,
} from '../swm/shared-memory-followers.js';
import type { Rfc64PublicCatalogHeadReplayRequestV1 } from '../rfc64/public-catalog-transport-v1.js';

/** What queueing one replay for a peer answers. */
export type Rfc64CatalogHeadReplayQueueAdmissionV1 = Readonly<{
  status: 'admitted';
  /** True only for the request that created the queued replay. */
  newlyQueued: boolean;
  completion: Promise<Readonly<{ announced: number }>>;
}> | Readonly<{ status: 'busy' }>;

/**
 * Answer a peer's request to replay a graph's catalog heads. The request
 * reaches here only once this node's policy check admitted it: the peer
 * named the policy this node holds for the graph, so it follows the graph.
 * That is recorded first, whether or not this node can serve the replay now,
 * so a peer answered busy, or one whose replay fails, is still among the
 * graph's followers, the peers a share into the graph goes to directly.
 */
export function answerRfc64CatalogHeadReplayRequestV1<
  Admission extends Rfc64CatalogHeadReplayQueueAdmissionV1,
>(input: {
  readonly request: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>;
  readonly remotePeerId: string;
  readonly followers: SharedMemoryFollowers;
  /** The digest of the policy this node holds for the request's graph, if any. */
  readonly acceptedPolicyDigest: string | undefined;
  /** Queue the replay, or answer busy. */
  readonly queue: () => Admission;
  readonly log: Readonly<{ info(message: string): void; warn(message: string): void }>;
}): Admission {
  noteCatalogHeadReplayFollower(
    input.followers,
    input.acceptedPolicyDigest,
    input.request,
    input.remotePeerId,
  );
  const admission = input.queue();
  if (admission.status === 'busy' || !admission.newlyQueued) return admission;
  const peer = input.remotePeerId.slice(-8);
  void admission.completion
    .then((result) => {
      if (result.announced > 0) {
        input.log.info(`Replayed ${result.announced} RFC-64 catalog head(s) to ${peer}`);
      }
    })
    .catch((error: unknown) => {
      input.log.warn(`RFC-64 catalog head replay failed for ${peer}: ${
        error instanceof Error ? error.message : String(error)
      }`);
    });
  return admission;
}

/**
 * `error`, logged at debug first: a request to replay a graph's catalog heads
 * from `remotePeerId` got no usable answer. The line says why (the peer stayed
 * busy, did not answer in time, could not finish, or the stream failed), which
 * the summary of the replay run does not. Returns `error` for the caller to
 * throw.
 */
export function rfc64CatalogReplayPeerFailureV1(
  log: Pick<Logger, 'debug'>,
  contextGraphId: string,
  remotePeerId: string,
  error: unknown,
): unknown {
  log.debug(
    createOperationContext('system'),
    `RFC-64 catalog replay from ${remotePeerId.slice(-8)} for "${contextGraphId}" got no answer: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  return error;
}
