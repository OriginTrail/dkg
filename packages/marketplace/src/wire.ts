// SPDX-License-Identifier: Apache-2.0

/**
 * The marketplace's peer protocol (OT-RFC-27): two request
 * and response messages over the node's messenger, as remote queries go.
 *   - `quote`: in, service ids; out, for each, the seller's price for the
 *     epoch, whether it is available, and its capacity.
 *   - `serve`: in, a `ServiceRequest` signed by the subscription's session key
 *     and the call's body; out, the result and the seller's signed receipt, or
 *     an error code that says whether to retry.
 *
 * Messages are JSON. Integers past 2^53 (wei, nonces, units, identity ids) are
 * decimal strings; times are chain seconds. Everything that comes off the wire
 * is checked here before it reaches a store or a chain read: the requests a
 * seller takes in, and the answers a buyer reads back. A serve answer's
 * receipt is the one part left as it came: the buyer's gateway decodes it
 * with its checks of the receipt.
 */
import { ethers } from 'ethers';
import type { QueryInferenceReceipt, ServiceRequest } from '@origintrail-official/dkg-chain';

/** Size caps and timeouts of the two messages, in one place. */
export const PEER_LIMITS = Object.freeze({
  /** What a seller takes in (`maxWireBytes`); a few kilobytes over the payload for the envelope. */
  quoteRequestBytes: 32 * 1024,
  serveRequestBytes: 512 * 1024,
  /** What a buyer reads back (`maxReadBytes`). */
  quoteResponseBytes: 64 * 1024,
  serveResponseBytes: 2 * 1024 * 1024,
  /** What the messenger's envelope adds to a message, at most; a buyer keeps its payload under the cap by this much. */
  envelopeBytes: 4 * 1024,
  quoteTimeoutMs: 10_000,
  serveTimeoutMs: 120_000,
  /** At most this many services in one quote. */
  quoteServices: 32,
});

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** The body of an inference call: OpenAI-shaped messages and the most tokens to produce. */
export interface InferenceBody {
  messages: ChatMessage[];
  max_tokens: number;
}

export interface QuoteRequest {
  services: string[];
}

export interface QuotedOffer {
  serviceId: string;
  /** Wei per unit, for the epoch; the current epoch's price never changes. */
  pricePerUnit: string;
  available: boolean;
  /** Calls the seller takes at once; `null` when it states none. */
  capacity: number | null;
}

export interface QuoteResponse {
  /** The seller's identity id. */
  seller: string;
  epoch: number;
  offers: QuotedOffer[];
}

export interface ServiceRequestWire {
  subscriptionId: string;
  serviceId: string;
  seller: string;
  nonce: string;
  pricePerUnit: string;
  maxUnits: string;
  maxValueWei: string;
  issuedAt: number;
  expiry: number;
}

export interface ReceiptWire {
  requestDigest: string;
  resultCommitment: string;
  units: string;
  valueWei: string;
  completedAt: number;
}

export interface ServeRequest {
  request: ServiceRequestWire;
  /** The session key's signature over the request, EIP-2098, 64 bytes. */
  signature: string;
  body: InferenceBody;
}

/** A served call. The receipt commits to `resultBytesOf(result.content)`. */
export interface ServeAnswer {
  ok: true;
  result: { content: string };
  receipt: ReceiptWire;
  /** The seller's operational wallet's signature over the receipt (EIP-712, in the request's domain). */
  receiptSignature: string;
  /** The budget the call counted against, its index in the subscription. */
  budgetIndex: number;
}

/** A refused or failed call: nothing was served and nothing is owed. */
export interface ServeRefusal {
  ok: false;
  code: ServeErrorCode;
  /** Whether the same call may succeed later: after a new quote, at the next epoch, or once the seller is free. */
  retry: boolean;
  message?: string;
}

export type ServeResponse = ServeAnswer | ServeRefusal;

/** A served call as a buyer reads it off the wire: its receipt is decoded where the buyer's checks of it run. */
export interface ServeAnswerReceived extends Omit<ServeAnswer, 'receipt'> {
  receipt: unknown;
}

export type ServeResponseReceived = ServeAnswerReceived | ServeRefusal;

/** Why a seller refuses a call, in the order of its checks. */
export const SERVE_ERRORS = {
  BadRequest: false,
  NotServing: true,
  EpochEnding: true,
  UnknownService: false,
  WrongPrice: true,
  SubscriptionNotFound: false,
  NotCurrentEpoch: false,
  ServiceNotFunded: false,
  PriceOverCap: false,
  BadSignature: false,
  NotYetValid: true,
  Expired: false,
  GrantEnded: false,
  NonceUsed: false,
  BudgetExhausted: false,
  UnitsTooFew: false,
  UpstreamError: true,
  /** The seller could not check or serve the call now: a chain read or its ledger failed. */
  Unavailable: true,
} as const satisfies Record<string, boolean>;

export type ServeErrorCode = keyof typeof SERVE_ERRORS;

export function refusal(code: ServeErrorCode, message?: string): ServeRefusal {
  return { ok: false, code, retry: SERVE_ERRORS[code], ...(message ? { message } : {}) };
}

// ------------------------------------------------------------------- units

/** Units allowed per message for the chat template, and per call. */
const UNITS_PER_MESSAGE = 8;
const UNITS_PER_CALL = 16;

/**
 * The most units a call's input can count: each message's UTF-8 bytes, which
 * a tokenizer never exceeds, and an allowance per message and per call for the
 * chat template. A buyer's `maxUnits` covers it and the output it allows. A
 * seller refuses a request whose units do not cover it and one unit of output
 * (`UnitsTooFew`) before its backend runs, so an input the request cannot pay
 * for is never sent to the backend.
 */
export function inputUnitsBound(messages: readonly ChatMessage[]): bigint {
  return BigInt(messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + UNITS_PER_MESSAGE, UNITS_PER_CALL));
}

// ------------------------------------------------------------------ results

/** The bytes a receipt commits to: the completion's text, as UTF-8. Seller and buyer both use this. */
export function resultBytesOf(content: string): Uint8Array {
  return ethers.toUtf8Bytes(content);
}

export function resultCommitmentOf(content: string): string {
  return ethers.keccak256(resultBytesOf(content));
}

// ---------------------------------------------------------------- encoding

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(message: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(message));
}

/** Parse a message, or throw `WireError`. */
export function decodeMessage(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new WireError('not JSON');
  }
}

/** Input from the wire that the node does not accept. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function bytes32(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ethers.isHexString(value, 32)) throw new WireError(`${field} must be 32 bytes of hex`);
  return value.toLowerCase();
}

function uint(value: unknown, field: string, bits: number): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new WireError(`${field} must be a decimal string`);
  const n = BigInt(value);
  if (n >= 1n << BigInt(bits)) throw new WireError(`${field} must fit ${bits} bits`);
  return n;
}

function time(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= 2 ** 40) {
    throw new WireError(`${field} must be a time in chain seconds`);
  }
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new WireError(`${field} must be a whole number`);
  return value;
}

export function requestToWire(r: ServiceRequest): ServiceRequestWire {
  return {
    subscriptionId: r.subscriptionId,
    serviceId: r.serviceId,
    seller: r.seller.toString(),
    nonce: r.nonce.toString(),
    pricePerUnit: r.pricePerUnit.toString(),
    maxUnits: r.maxUnits.toString(),
    maxValueWei: r.maxValueWei.toString(),
    issuedAt: r.issuedAt,
    expiry: r.expiry,
  };
}

export function requestFromWire(raw: unknown): ServiceRequest {
  if (!isRecord(raw)) throw new WireError('request must be an object');
  return {
    subscriptionId: bytes32(raw.subscriptionId, 'subscriptionId'),
    serviceId: bytes32(raw.serviceId, 'serviceId'),
    seller: uint(raw.seller, 'seller', 72),
    nonce: uint(raw.nonce, 'nonce', 64),
    pricePerUnit: uint(raw.pricePerUnit, 'pricePerUnit', 96),
    maxUnits: uint(raw.maxUnits, 'maxUnits', 64),
    maxValueWei: uint(raw.maxValueWei, 'maxValueWei', 96),
    issuedAt: time(raw.issuedAt, 'issuedAt'),
    expiry: time(raw.expiry, 'expiry'),
  };
}

export function receiptToWire(r: QueryInferenceReceipt): ReceiptWire {
  return {
    requestDigest: r.requestDigest,
    resultCommitment: r.resultCommitment,
    units: r.units.toString(),
    valueWei: r.valueWei.toString(),
    completedAt: r.completedAt,
  };
}

export function receiptFromWire(raw: unknown): QueryInferenceReceipt {
  if (!isRecord(raw)) throw new WireError('receipt must be an object');
  return {
    requestDigest: bytes32(raw.requestDigest, 'requestDigest'),
    resultCommitment: bytes32(raw.resultCommitment, 'resultCommitment'),
    units: uint(raw.units, 'units', 64),
    valueWei: uint(raw.valueWei, 'valueWei', 96),
    completedAt: time(raw.completedAt, 'completedAt'),
  };
}

const ROLES: readonly ChatRole[] = ['system', 'user', 'assistant'];

/** The call body: 1 to 256 messages of a known role with text content, and a positive `max_tokens`. */
export function inferenceBodyFromWire(raw: unknown): InferenceBody {
  if (!isRecord(raw) || !Array.isArray(raw.messages) || raw.messages.length === 0 || raw.messages.length > 256) {
    throw new WireError('messages must be a list of 1 to 256 messages');
  }
  const messages = raw.messages.map((m, i): ChatMessage => {
    if (!isRecord(m) || !ROLES.includes(m.role as ChatRole) || typeof m.content !== 'string') {
      throw new WireError(`messages[${i}] must have a role of system, user or assistant and text content`);
    }
    return { role: m.role as ChatRole, content: m.content };
  });
  const maxTokens = raw.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > 1_000_000) {
    throw new WireError('max_tokens must be a positive integer');
  }
  return { messages, max_tokens: maxTokens };
}

export function quoteRequestFromWire(raw: unknown): QuoteRequest {
  if (!isRecord(raw) || !Array.isArray(raw.services) || raw.services.length > PEER_LIMITS.quoteServices) {
    throw new WireError(`services must be a list of at most ${PEER_LIMITS.quoteServices} service ids`);
  }
  return { services: raw.services.map((s, i) => bytes32(s, `services[${i}]`)) };
}

export function serveRequestFromWire(raw: unknown): { request: ServiceRequest; signature: string; body: InferenceBody } {
  if (!isRecord(raw)) throw new WireError('serve must be an object');
  if (typeof raw.signature !== 'string' || !ethers.isHexString(raw.signature, 64)) {
    throw new WireError('signature must be 64 bytes of hex (EIP-2098)');
  }
  return { request: requestFromWire(raw.request), signature: raw.signature.toLowerCase(), body: inferenceBodyFromWire(raw.body) };
}

/** A seller's answer to `quote`: its identity, the epoch, and at most `quoteServices` offers, each whole. */
export function quoteResponseFromWire(raw: unknown): QuoteResponse {
  if (!isRecord(raw) || !Array.isArray(raw.offers) || raw.offers.length > PEER_LIMITS.quoteServices) {
    throw new WireError(`a quote must have a list of at most ${PEER_LIMITS.quoteServices} offers`);
  }
  return {
    seller: uint(raw.seller, 'seller', 72).toString(),
    epoch: count(raw.epoch, 'epoch'),
    offers: raw.offers.map((o, i): QuotedOffer => {
      if (!isRecord(o) || typeof o.available !== 'boolean') throw new WireError(`offers[${i}] must be an offer that says whether it is available`);
      return {
        serviceId: bytes32(o.serviceId, `offers[${i}].serviceId`),
        pricePerUnit: uint(o.pricePerUnit, `offers[${i}].pricePerUnit`, 96).toString(),
        available: o.available,
        capacity: o.capacity === null ? null : count(o.capacity, `offers[${i}].capacity`),
      };
    }),
  };
}

/**
 * A seller's answer to `serve`: a refusal with a code of `SERVE_ERRORS`, or a
 * result with text, a receipt signature, and the budget's index. The receipt
 * is left as it came, for the buyer's checks of it.
 */
export function serveResponseFromWire(raw: unknown): ServeResponseReceived {
  if (!isRecord(raw) || typeof raw.ok !== 'boolean') throw new WireError('an answer must be an object that says whether it is ok');
  if (!raw.ok) {
    if (typeof raw.code !== 'string' || !Object.hasOwn(SERVE_ERRORS, raw.code) || typeof raw.retry !== 'boolean') {
      throw new WireError('a refusal must have a known code and say whether to retry');
    }
    if (raw.message !== undefined && typeof raw.message !== 'string') throw new WireError('a refusal message must be text');
    return { ok: false, code: raw.code as ServeErrorCode, retry: raw.retry, ...(raw.message === undefined ? {} : { message: raw.message }) };
  }
  if (!isRecord(raw.result) || typeof raw.result.content !== 'string') throw new WireError('result must have text content');
  if (typeof raw.receiptSignature !== 'string') throw new WireError('receiptSignature must be text');
  return { ok: true, result: { content: raw.result.content }, receipt: raw.receipt, receiptSignature: raw.receiptSignature, budgetIndex: count(raw.budgetIndex, 'budgetIndex') };
}
