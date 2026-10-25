/**
 * OT-RFC-27 NeuroSymbolic Marketplace wire schemas (protocol-level
 * prototype).
 *
 * Two request/response pairs, one per protocol id (see
 * `PROTOCOL_MARKETPLACE_QUOTE` / `PROTOCOL_MARKETPLACE_SERVE` in
 * `constants.ts`):
 *
 * - **Quote** — the buyer router's cheap availability/price probe,
 *   fanned out to candidate sellers before one is selected. Carries no
 *   authorization; a seller answers from its local offering table.
 * - **Serve** — the authorized call. The request carries every field of
 *   the buyer's bounded authorization (the `DKG_MKT_AUTH_V1` digest
 *   preimage minus chainId/marketplace address/seller identity, which
 *   both sides derive from chain config and the dialed seller) plus the
 *   session-key EIP-191 signature; the response carries the result and
 *   the seller-signed QueryInferenceReceipt (`DKG_MKT_RCPT_V1`).
 *
 * All TRAC amounts cross the wire as **decimal strings** (wei): the
 * on-chain types are uint96/uint256, which neither a protobuf uint64
 * field nor a JS number can hold, and the TS side is bigint-only for
 * money — consumers parse with `BigInt(...)`. `sellerIdentityId` is a
 * decimal string for the same reason (uint72 on-chain). Unit counts and
 * timestamps are genuine uint64 fields, normalized to safe-integer
 * `number`s on decode.
 *
 * Semantic validation (byte lengths, signature recovery, digest
 * recomputation, payload JSON shape) is the handlers' job — these
 * codecs only frame bytes, like the other modules in this directory.
 *
 * The `*Schema` consts are exported for consistency with the other
 * proto modules; prefer the `*Msg` types and `encode*` / `decode*`
 * functions re-exported from `packages/core/src/proto/index.ts`.
 *
 * @internal
 */
import protobuf from 'protobufjs';

import { uint64ForProto, type LongLike } from './swm-sender-key.js';

const { Type, Field } = protobuf;

/**
 * Serve-request wire version. Bump when a change is NOT strictly
 * additive (protobuf field-number compatibility covers additive ones);
 * a seller refuses versions it does not understand instead of silently
 * mis-reading authorization fields it would then verify and sign over.
 */
export const MARKETPLACE_SERVE_VERSION = 1;

export const MarketplaceQuoteRequestSchema = new Type('MarketplaceQuoteRequest')
  .add(new Field('offeringId', 1, 'bytes'));

export const MarketplaceQuoteResponseSchema = new Type('MarketplaceQuoteResponse')
  .add(new Field('available', 1, 'bool'))
  .add(new Field('askPerUnitWei', 2, 'string'))
  .add(new Field('capacityUnitsPerMin', 3, 'uint64'))
  .add(new Field('declineCode', 4, 'string'));

export const MarketplaceServeRequestSchema = new Type('MarketplaceServeRequest')
  .add(new Field('version', 1, 'uint32'))
  .add(new Field('buyer', 2, 'bytes'))
  .add(new Field('sellerIdentityId', 3, 'string'))
  .add(new Field('offeringId', 4, 'bytes'))
  .add(new Field('callId', 5, 'bytes'))
  .add(new Field('epoch', 6, 'uint64'))
  .add(new Field('maxUnits', 7, 'uint64'))
  .add(new Field('askPerUnitWei', 8, 'string'))
  .add(new Field('expiry', 9, 'uint64'))
  .add(new Field('authSignature', 10, 'bytes'))
  .add(new Field('payloadKind', 11, 'string'))
  .add(new Field('payload', 12, 'bytes'));

export const MarketplaceServeResponseSchema = new Type('MarketplaceServeResponse')
  .add(new Field('ok', 1, 'bool'))
  .add(new Field('errorCode', 2, 'string'))
  .add(new Field('servedUnits', 3, 'uint64'))
  .add(new Field('receiptValueWei', 4, 'string'))
  .add(new Field('resultCommitment', 5, 'bytes'))
  .add(new Field('sellerSignature', 6, 'bytes'))
  .add(new Field('result', 7, 'bytes'))
  .add(new Field('authDigest', 8, 'bytes'));

export interface MarketplaceQuoteRequestMsg {
  /** keccak256 offering id (32 bytes) the buyer wants a live quote for. */
  offeringId: Uint8Array;
}

export interface MarketplaceQuoteResponseMsg {
  /** Seller is willing and able to serve this offering right now. */
  available: boolean;
  /**
   * Current ask, decimal wei per unit (parse with `BigInt`). Set iff
   * `available`; this is the ask the buyer signs into its
   * authorization, so a seller cannot raise it after acceptance.
   */
  askPerUnitWei?: string;
  /** Advertised serving capacity; 0/unset = seller does not say. */
  capacityUnitsPerMin?: number | bigint | LongLike;
  /**
   * Non-empty iff `available` is false — a short machine-readable
   * reason (e.g. `UNKNOWN_OFFERING`, `AT_CAPACITY`) surfaced in buyer
   * routing logs. Unknown codes are treated as a generic decline.
   */
  declineCode?: string;
}

export interface MarketplaceServeRequestMsg {
  /** Wire version; see {@link MARKETPLACE_SERVE_VERSION}. */
  version: number;
  /** Funding wallet address (20 bytes) — NOT the session key. */
  buyer: Uint8Array;
  /** Seller identityId as a decimal string (uint72 on-chain). */
  sellerIdentityId: string;
  /** keccak256 offering id (32 bytes), as signed into the auth digest. */
  offeringId: Uint8Array;
  /** Buyer-generated single-use call id (32 bytes). */
  callId: Uint8Array;
  /** Chronos epoch the funded bucket belongs to. */
  epoch: number | bigint | LongLike;
  /** Authorization ceiling on units served for this call. */
  maxUnits: number | bigint | LongLike;
  /** Accepted ask, decimal wei per unit (parse with `BigInt`). */
  askPerUnitWei: string;
  /** Authorization expiry, unix seconds (uint40 on-chain). */
  expiry: number | bigint | LongLike;
  /** Session-key EIP-191 signature over the auth digest (65 bytes). */
  authSignature: Uint8Array;
  /** Executor selector: 'inference' | 'query'. */
  payloadKind: string;
  /** Executor input, JSON bytes (shape owned by the executor kind). */
  payload: Uint8Array;
}

export interface MarketplaceServeResponseMsg {
  /** True iff the call executed and the receipt fields below are set. */
  ok: boolean;
  /**
   * Non-empty iff `ok` is false — machine-readable failure reason
   * (e.g. `BAD_AUTH`, `REPLAYED_CALL_ID`, `EXPIRED`, `OVER_MAX_UNITS`).
   * The receipt fields are unset on failures.
   */
  errorCode?: string;
  /** Units actually served (≤ the authorized `maxUnits`). */
  servedUnits?: number | bigint | LongLike;
  /** `servedUnits · askPerUnit`, decimal wei (parse with `BigInt`). */
  receiptValueWei?: string;
  /** sha256 of the raw `result` bytes (32 bytes); stored in the claim event for audit. */
  resultCommitment?: Uint8Array;
  /** Seller operational-wallet EIP-191 signature over the receipt digest (65 bytes). */
  sellerSignature?: Uint8Array;
  /** Executor output, JSON bytes. */
  result?: Uint8Array;
  /** The auth digest this receipt settles (32 bytes) — buyer cross-checks. */
  authDigest?: Uint8Array;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bytesField(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(0);
}

function boolField(value: unknown): boolean {
  return value === true;
}

export function encodeMarketplaceQuoteRequest(msg: MarketplaceQuoteRequestMsg): Uint8Array {
  return MarketplaceQuoteRequestSchema.encode(
    MarketplaceQuoteRequestSchema.create(msg),
  ).finish();
}

export function decodeMarketplaceQuoteRequest(buf: Uint8Array): MarketplaceQuoteRequestMsg {
  const decoded = MarketplaceQuoteRequestSchema.decode(buf) as unknown as Record<string, unknown>;
  return { offeringId: bytesField(decoded.offeringId) };
}

export function encodeMarketplaceQuoteResponse(msg: MarketplaceQuoteResponseMsg): Uint8Array {
  return MarketplaceQuoteResponseSchema.encode(
    MarketplaceQuoteResponseSchema.create({
      available: msg.available,
      askPerUnitWei: msg.askPerUnitWei ?? '',
      capacityUnitsPerMin: uint64ForProto(msg.capacityUnitsPerMin ?? 0),
      declineCode: msg.declineCode ?? '',
    }),
  ).finish();
}

export function decodeMarketplaceQuoteResponse(buf: Uint8Array): MarketplaceQuoteResponseMsg {
  const decoded = MarketplaceQuoteResponseSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    available: boolField(decoded.available),
    askPerUnitWei: stringField(decoded.askPerUnitWei) || undefined,
    capacityUnitsPerMin: uint64ForProto(decoded.capacityUnitsPerMin ?? 0),
    declineCode: stringField(decoded.declineCode) || undefined,
  };
}

export function encodeMarketplaceServeRequest(msg: MarketplaceServeRequestMsg): Uint8Array {
  return MarketplaceServeRequestSchema.encode(
    MarketplaceServeRequestSchema.create({
      ...msg,
      epoch: uint64ForProto(msg.epoch),
      maxUnits: uint64ForProto(msg.maxUnits),
      expiry: uint64ForProto(msg.expiry),
    }),
  ).finish();
}

export function decodeMarketplaceServeRequest(buf: Uint8Array): MarketplaceServeRequestMsg {
  const decoded = MarketplaceServeRequestSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    version: typeof decoded.version === 'number' ? decoded.version : 0,
    buyer: bytesField(decoded.buyer),
    sellerIdentityId: stringField(decoded.sellerIdentityId),
    offeringId: bytesField(decoded.offeringId),
    callId: bytesField(decoded.callId),
    epoch: uint64ForProto(decoded.epoch ?? 0),
    maxUnits: uint64ForProto(decoded.maxUnits ?? 0),
    askPerUnitWei: stringField(decoded.askPerUnitWei),
    expiry: uint64ForProto(decoded.expiry ?? 0),
    authSignature: bytesField(decoded.authSignature),
    payloadKind: stringField(decoded.payloadKind),
    payload: bytesField(decoded.payload),
  };
}

export function encodeMarketplaceServeResponse(msg: MarketplaceServeResponseMsg): Uint8Array {
  return MarketplaceServeResponseSchema.encode(
    MarketplaceServeResponseSchema.create({
      ok: msg.ok,
      errorCode: msg.errorCode ?? '',
      servedUnits: uint64ForProto(msg.servedUnits ?? 0),
      receiptValueWei: msg.receiptValueWei ?? '',
      resultCommitment: msg.resultCommitment ?? new Uint8Array(0),
      sellerSignature: msg.sellerSignature ?? new Uint8Array(0),
      result: msg.result ?? new Uint8Array(0),
      authDigest: msg.authDigest ?? new Uint8Array(0),
    }),
  ).finish();
}

export function decodeMarketplaceServeResponse(buf: Uint8Array): MarketplaceServeResponseMsg {
  const decoded = MarketplaceServeResponseSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    ok: boolField(decoded.ok),
    errorCode: stringField(decoded.errorCode) || undefined,
    servedUnits: uint64ForProto(decoded.servedUnits ?? 0),
    receiptValueWei: stringField(decoded.receiptValueWei) || undefined,
    resultCommitment: bytesField(decoded.resultCommitment),
    sellerSignature: bytesField(decoded.sellerSignature),
    result: bytesField(decoded.result),
    authDigest: bytesField(decoded.authDigest),
  };
}
