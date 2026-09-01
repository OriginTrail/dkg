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
  type FinalizedEventPositionV1,
  type KnowledgeAssetRootMutationKindV1,
} from '@origintrail-official/dkg-core';
import type { ChainEvent, KnowledgeAssetRootMutationEventType } from '@origintrail-official/dkg-chain';
import type { Digest32V1, EvmAddressV1, KaIdV1 } from '@origintrail-official/dkg-core';

/**
 * One on-chain mutation of a Knowledge Asset's committed Merkle-root set.
 *
 * Emitted by the `kaRootMutations` lane for each of the four
 * `KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES`. The payload is deliberately
 * canonical-string shaped (not `bigint`/`Uint8Array`) so it matches core's
 * `FinalizedEventPositionV1` vocabulary and survives a durable round-trip
 * without a lossy re-encode.
 *
 * `position` — not a bare `blockNumber` — because two root mutations of the
 * SAME asset can land in one block; a consumer deciding whether an event is
 * newer than one it already recorded needs `(block, txIndex, logIndex)`, which
 * is exactly what core's `compareEventPosition` orders on.
 */
interface KnowledgeAssetRootMutationBaseV1 {
  /** On-chain KA id, canonical unsigned decimal (never hex, never `bigint`). */
  kaId: KaIdV1;
  /** Chain position, for ordering and de-duplication. */
  position: FinalizedEventPositionV1;
}

/** `updateKnowledgeAsset` — the ordinary V10 lifecycle update. */
export interface KnowledgeAssetLifecycleUpdateEventV1 extends KnowledgeAssetRootMutationBaseV1 {
  kind: 'lifecycle-update';
  /**
   * The appended root, 0x-prefixed 32-byte hex. Optional because it is
   * best-effort enrichment off `parseLog` — `kaId`/`position` come from the
   * indexed topics and survive a payload that fails to decode.
   */
  merkleRoot?: Digest32V1;
  /**
   * EIP-712-attested author; `null` for the unattributed publish path (the
   * chain legally emits the zero address there). Optional for the same
   * best-effort-decode reason as `merkleRoot`.
   */
  author?: EvmAddressV1 | null;
}

/** `pushMerkleRoot` — append-only admin push. Carries no author field on chain. */
export interface KnowledgeAssetRootAddedEventV1 extends KnowledgeAssetRootMutationBaseV1 {
  kind: 'root-added';
  merkleRoot?: Digest32V1;
}

/**
 * `setMerkleRoots` — destructive replacement. Deliberately carries NO root:
 * the event's dynamic `MerkleRoot[]` is never decoded (unbounded work on an
 * untrusted payload), and no consumer needs it — the repair path re-reads the
 * committed set from chain.
 */
export interface KnowledgeAssetRootsReplacedEventV1 extends KnowledgeAssetRootMutationBaseV1 {
  kind: 'roots-replaced';
}

/** `popMerkleRoot` — destructive removal of the latest root. */
export interface KnowledgeAssetRootRemovedEventV1 extends KnowledgeAssetRootMutationBaseV1 {
  kind: 'root-removed';
  /** The REMOVED root (best-effort decode), not a new latest root. */
  merkleRoot?: Digest32V1;
}

/**
 * One on-chain mutation of a Knowledge Asset's committed Merkle-root set, as
 * a discriminated union over `kind` (PR #2436 review r2): each variant carries
 * exactly the fields its emitter defines, so an impossible combination — an
 * author on `roots-replaced`, a root on a replacement — is a compile error
 * rather than a prose rule.
 *
 * Payloads are canonical-string shaped (not `bigint`/`Uint8Array`) so they
 * match core's `FinalizedEventPositionV1` vocabulary and survive a durable
 * round-trip without a lossy re-encode. `position` — not a bare
 * `blockNumber` — because two root mutations of the SAME asset can land in
 * one block; ordering needs `(block, txIndex, logIndex)`, which is what
 * core's `compareEventPosition` orders on.
 */
export type KnowledgeAssetRootMutationEventV1 =
  | KnowledgeAssetLifecycleUpdateEventV1
  | KnowledgeAssetRootAddedEventV1
  | KnowledgeAssetRootsReplacedEventV1
  | KnowledgeAssetRootRemovedEventV1;

/**
 * Callback for `KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES`.
 *
 * Contract, unlike every other poller callback: **a rejection is not
 * swallowed.** It propagates to the lane runner, which holds the lane cursor
 * and re-scans the same window on the next due poll. So a handler that cannot
 * durably record the event MUST reject — returning normally is a promise that
 * the event has been taken responsibility for, and the cursor advances past it
 * forever.
 */
export type OnKnowledgeAssetRootMutated = (
  event: KnowledgeAssetRootMutationEventV1,
) => Promise<void>;

/**
 * On-chain event name → the off-chain kind a consumer classifies it as.
 * The keys are the CLOSED chain union (review r8), so an event name added to
 * `KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES` without a row here is a compile
 * error rather than a silently dropped event — and the object carries a NULL
 * prototype, so an inherited name like `toString` can never read as a row
 * even if a call site indexes it without the own-property guard below.
 */
export const KA_ROOT_MUTATION_KIND_BY_EVENT: Readonly<
  Record<KnowledgeAssetRootMutationEventType, KnowledgeAssetRootMutationKindV1>
> = Object.freeze(
  Object.assign(Object.create(null) as Record<never, never>, {
    KnowledgeAssetUpdated: 'lifecycle-update',
    KnowledgeAssetMerkleRootAdded: 'root-added',
    KnowledgeAssetMerkleRootsUpdated: 'roots-replaced',
    KnowledgeAssetMerkleRootRemoved: 'root-removed',
  } satisfies Record<KnowledgeAssetRootMutationEventType, KnowledgeAssetRootMutationKindV1>),
);

export type KnowledgeAssetRootMutationDecodeFailure =
  | 'unknown-event-type'
  | 'noncanonical-ka-id'
  | 'noncanonical-position';

export type KnowledgeAssetRootMutationDecodeResult =
  | { ok: true; mutation: KnowledgeAssetRootMutationEventV1 }
  | { ok: false; reason: KnowledgeAssetRootMutationDecodeFailure };

/**
 * `author` is ADVISORY enrichment with a TRI-STATE contract (review r7):
 *  - canonical nonzero address → attributed (`author: '0x…'`)
 *  - canonical zero address    → EXPLICITLY unattributed (`author: null`)
 *  - absent or malformed       → UNKNOWN (`author` omitted)
 * The last two must not collapse: `null` is a positive on-chain claim that
 * nobody attested the update, while an omitted property only says this decode
 * could not read the enrichment. A consumer that erased authorship over a
 * corrupt RPC payload would be acting on evidence the chain never gave it.
 * The event itself still flows either way — identity fields, not enrichment,
 * decide delivery. `parseLog` returns checksummed addresses while core's
 * canonical form is lowercase, so the lowercasing here is load-bearing.
 */
function degradeAuthor(value: unknown): EvmAddressV1 | null | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return canonicalNullableAuthorAddress(value.toLowerCase());
  } catch {
    return undefined;
  }
}

/** A lowercase canonical 32-byte digest, or `undefined` for best-effort fields. */
function degradeDigest(value: unknown): Digest32V1 | undefined {
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
  // Own-property check (review r8): indexing a plain object accepted names
  // inherited from `Object.prototype` — `type: 'toString'` read the inherited
  // function as a kind, bypassed this guard, matched no switch case, and
  // returned `{ ok: true, mutation: undefined }` for the poller to throw on.
  const kind = Object.hasOwn(KA_ROOT_MUTATION_KIND_BY_EVENT, event.type)
    ? KA_ROOT_MUTATION_KIND_BY_EVENT[event.type as KnowledgeAssetRootMutationEventType]
    : undefined;
  if (!kind) return { ok: false, reason: 'unknown-event-type' };

  const { data } = event;

  let kaId: KaIdV1;
  try {
    // Core's canonical unsigned decimal: rejects leading zeros, signs,
    // non-digits and anything above u256 — the payload contract's exact
    // words. Canonical BY CONSTRUCTION (BigInt#toString has no leading-zero
    // or sign alias for a validated u256), which is what licenses the brand.
    kaId = canonicalUnsignedDecimal(data['kaId'], 'kaId').toString() as KaIdV1;
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
      blockHash: data['blockHash'],
      transactionHash: data['txHash'],
      transactionIndex: data['txIndex'],
      logIndex: data['logIndex'],
    });
  } catch {
    return { ok: false, reason: 'noncanonical-position' };
  }

  const merkleRoot = kind === 'roots-replaced' ? undefined : degradeDigest(data['merkleRoot']);

  let mutation: KnowledgeAssetRootMutationEventV1;
  switch (kind) {
    case 'lifecycle-update': {
      const author = degradeAuthor(data['author']);
      mutation = {
        kind, kaId, position,
        ...(merkleRoot ? { merkleRoot } : {}),
        ...(author !== undefined ? { author } : {}),
      };
      break;
    }
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

// Type-level proof (review r19; kept in SRC because package test directories
// are not typechecked): an arbitrary string cannot populate the branded
// payload fields — only the decoder canonical judgements mint them.
const _plainStringsCannotForgePayloads: KnowledgeAssetLifecycleUpdateEventV1 = {
  kind: 'lifecycle-update',
  // @ts-expect-error -- a plain string is not KaIdV1
  kaId: '42',
  position: undefined as never, // the position module carries its own proof
  // @ts-expect-error -- a plain string is not Digest32V1
  merkleRoot: 'not-a-digest',
  // @ts-expect-error -- a plain string is not EvmAddressV1
  author: 'not-an-address',
};
void _plainStringsCannotForgePayloads;
