/**
 * The ONE decoder from the loose `ChainEvent` boundary to the typed
 * `KnowledgeAssetRootMutationEventV1` union (PR #2436 review r5).
 *
 * Every canonical judgement here is delegated to core — the layer that owns
 * the canonical model — rather than restated: a local `/^\d+$/` accepted
 * leading-zero decimals core rejects, and `Number.isInteger` accepted unsafe
 * integers `canonicalBlockNumber` refuses. One boundary, no drift.
 *
 * Failure is a STRUCTURED result, not a throw: the caller is a poller lane
 * whose no-swallow contract reserves rejection for "I could not take
 * responsibility for a valid event" (durable-store failure). A malformed
 * payload is not that — it is dropped with a reason, because a deterministic
 * throw would stall the lane behind one bad log forever.
 */
import {
  canonicalDigest32,
  canonicalEventPositionV1,
  canonicalNullableAuthorAddress,
  canonicalUnsignedDecimal,
  type KnowledgeAssetRootMutationKindV1,
} from '@origintrail-official/dkg-core';
import type { ChainEvent } from '@origintrail-official/dkg-chain';
import type { KnowledgeAssetRootMutationEventV1 } from './chain-event-poller.js';

/**
 * On-chain event name → the off-chain kind a consumer classifies it as.
 * A `Record` over the closed union makes an unmapped name a compile error
 * rather than a silently dropped event.
 */
export const KA_ROOT_MUTATION_KIND_BY_EVENT: Readonly<Record<string, KnowledgeAssetRootMutationKindV1>> =
  Object.freeze({
    KnowledgeAssetUpdated: 'lifecycle-update',
    KnowledgeAssetMerkleRootAdded: 'root-added',
    KnowledgeAssetMerkleRootsUpdated: 'roots-replaced',
    KnowledgeAssetMerkleRootRemoved: 'root-removed',
  });

export type KnowledgeAssetRootMutationDecodeFailure =
  | 'unknown-event-type'
  | 'noncanonical-ka-id'
  | 'noncanonical-position';

export type KnowledgeAssetRootMutationDecodeResult =
  | { ok: true; mutation: KnowledgeAssetRootMutationEventV1 }
  | { ok: false; reason: KnowledgeAssetRootMutationDecodeFailure };

/**
 * `author` is ADVISORY enrichment: a malformed spelling degrades to `null`
 * (the unattributed reading) rather than dropping an event whose identity
 * fields are sound. `parseLog` returns checksummed addresses while core's
 * canonical form is lowercase, so the lowercasing here is load-bearing.
 */
function degradeAuthor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return canonicalNullableAuthorAddress(value.toLowerCase());
  } catch {
    return null;
  }
}

/** A lowercase canonical 32-byte digest, or `undefined` for best-effort fields. */
function degradeDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return canonicalDigest32(value.toLowerCase());
  } catch {
    return undefined;
  }
}

export function decodeKnowledgeAssetRootMutationEvent(
  event: ChainEvent,
): KnowledgeAssetRootMutationDecodeResult {
  const kind = KA_ROOT_MUTATION_KIND_BY_EVENT[event.type];
  if (!kind) return { ok: false, reason: 'unknown-event-type' };

  const { data } = event;

  let kaId: string;
  try {
    // Core's canonical unsigned decimal: rejects leading zeros, signs,
    // non-digits and anything above u256 — the payload contract's exact words.
    kaId = canonicalUnsignedDecimal(data['kaId'], 'kaId').toString();
  } catch {
    return { ok: false, reason: 'noncanonical-ka-id' };
  }

  let position;
  try {
    // Core's position boundary: safe non-negative integers and lowercase
    // 32-byte digests, validated as ONE record. The POSITION fields decide
    // ordering and de-duplication downstream, so a malformed one makes the
    // event unusable and the event is dropped — unlike `author`/`merkleRoot`,
    // which are advisory and degrade.
    position = canonicalEventPositionV1({
      blockNumber: event.blockNumber,
      blockHash: data['blockHash'] as never,
      transactionHash: data['txHash'] as never,
      transactionIndex: data['txIndex'] as never,
      logIndex: data['logIndex'] as never,
    });
  } catch {
    return { ok: false, reason: 'noncanonical-position' };
  }

  const merkleRoot = kind === 'roots-replaced' ? undefined : degradeDigest(data['merkleRoot']);

  let mutation: KnowledgeAssetRootMutationEventV1;
  switch (kind) {
    case 'lifecycle-update':
      mutation = {
        kind, kaId, position,
        ...(merkleRoot ? { merkleRoot } : {}),
        author: degradeAuthor(data['author']),
      };
      break;
    case 'root-added':
    case 'root-removed':
      mutation = { kind, kaId, position, ...(merkleRoot ? { merkleRoot } : {}) };
      break;
    case 'roots-replaced':
      mutation = { kind, kaId, position };
      break;
  }
  return { ok: true, mutation };
}
