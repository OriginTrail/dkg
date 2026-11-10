// SPDX-License-Identifier: Apache-2.0

/**
 * The marketplace's peer protocol (OT-RFC-27): two request
 * and response messages over the node's messenger, as remote queries go.
 *   - `quote`: in, service ids; out, for each, the seller's price for the
 *     epoch, whether it is available, and its capacity.
 *   - `quote`: a seller that takes tool calls for a service says so in its
 *     offer there (`tools: true`); one that says nothing takes text alone.
 *   - `serve`: in, a `ServiceRequest` signed by the subscription's session key
 *     and the call's body; out, the result and the seller's signed receipt, or
 *     an error code that says whether to retry.
 *
 * A call may carry OpenAI tools: `tools`, `tool_choice` and
 * `parallel_tool_calls`, an assistant's `tool_calls` and a tool's results
 * (`role: "tool"`). A call without them is encoded as 10.1.0 encoded it, and
 * a text result commits to its bytes as 10.1.0 committed: a seller or buyer
 * of 10.1.0 serves and checks it as before. A served call also says, unsigned,
 * how its units split between prompt and completion tokens.
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

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** Bounds of a call's tools and tool calls; the serve message's byte cap bounds the rest. */
export const TOOL_LIMITS = Object.freeze({
  /** Tools in one call. */
  tools: 128,
  /** Tool calls in one message or result. */
  toolCalls: 128,
  /** A tool call's id, in characters. */
  idChars: 128,
  /** A tool's description, in characters. */
  descriptionChars: 8_192,
});

/** A call the model made to one of the call's tools, as OpenAI shapes it: `arguments` is the JSON text it wrote. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One or more tool calls: an answer with tool calls has at least one. */
export type ToolCalls = [ToolCall, ...ToolCall[]];

/**
 * A model's answer, as decoding makes every one (`answerFromWire`): text; or one or more tool calls, with text or
 * none. A backend's completion, an assistant's message in a call's history and a served result are each one, with
 * what they carry beside it.
 */
export type Answer = { content: string; tool_calls?: undefined } | { content: string | null; tool_calls: ToolCalls };

/** A tool the model may call: a function, with a JSON Schema of its arguments. */
export interface ToolSpec {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

/**
 * One message of a call: text from system or user; an assistant's answer
 * (`Answer`), text or tool calls; or a tool's result, answering one of them.
 */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | ({ role: 'assistant' } & Answer)
  | { role: 'tool'; content: string; tool_call_id: string };

/**
 * The body of an inference call: OpenAI-shaped messages, the most tokens to
 * produce, and the tools the model may call, if any. Without tools it is
 * `{ messages, max_tokens }`, as 10.1.0 sent it.
 */
export interface InferenceBody {
  messages: ChatMessage[];
  max_tokens: number;
  tools?: ToolSpec[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
}

/** Why a model stopped, as the wire carries it. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export const FINISH_REASONS: readonly FinishReason[] = ['stop', 'length', 'tool_calls', 'content_filter'];

/** What a served call answers (`Answer`), and why the model stopped, when not `stop`. */
export type ServeResult = Answer & { finish_reason?: FinishReason };

/** How a served call's units split, as the seller's backend counted them within the receipt's units. Not signed. */
export interface ServeUsage {
  promptTokens: number;
  completionTokens: number;
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
  /** Whether the seller takes tool calls for the service; absent, as from a 10.1.0 seller, it takes text alone. */
  tools?: true;
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

/** A served call. The receipt commits to `resultBytesOf(result)`. */
export interface ServeAnswer {
  ok: true;
  result: ServeResult;
  receipt: ReceiptWire;
  /** The seller's operational wallet's signature over the receipt (EIP-712, in the request's domain). */
  receiptSignature: string;
  /** The budget the call counted against, its index in the subscription. */
  budgetIndex: number;
  /** How its units split; absent from a 10.1.0 seller. */
  usage?: ServeUsage;
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

// ------------------------------------------------------------------ results

/** The first byte of a result with tool calls: never in UTF-8, so its bytes are never a text result's. */
const TOOL_RESULT_TAG = 0xff;

/**
 * The bytes a receipt commits to. Seller and buyer both use this.
 *   - A text result: its text, as UTF-8, as in 10.1.0.
 *   - A result with tool calls: `0xff`, then the UTF-8 of the JSON array
 *     `[content, [[id, type, name, arguments], …]]`, its calls in order.
 */
export function resultBytesOf(result: string | ServeResult): Uint8Array {
  const r: ServeResult = typeof result === 'string' ? { content: result } : result;
  if (!r.tool_calls?.length) return ethers.toUtf8Bytes(r.content ?? '');
  const json = ethers.toUtf8Bytes(JSON.stringify([r.content, r.tool_calls.map((c) => [c.id, c.type, c.function.name, c.function.arguments])]));
  const bytes = new Uint8Array(json.length + 1);
  bytes[0] = TOOL_RESULT_TAG;
  bytes.set(json, 1);
  return bytes;
}

export function resultCommitmentOf(result: string | ServeResult): string {
  return ethers.keccak256(resultBytesOf(result));
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

/** The roles whose messages are text alone; an assistant's is an answer (`answerFromWire`), a tool's a result. */
const TEXT_ROLES = ['system', 'user'] as const;
/** A function's name, as OpenAI takes it. */
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** A tool call's id: printable ASCII, no spaces. */
const TOOL_CALL_ID = new RegExp(`^[\\x21-\\x7e]{1,${TOOL_LIMITS.idChars}}$`);

/** Absent: undefined, null, or an empty list, as OpenAI clients send all three for "none". */
const absent = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);

function functionName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !FUNCTION_NAME.test(value)) throw new WireError(`${field} must be a function name: 1 to 64 letters, digits, _ or -`);
  return value;
}

function toolCallId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOOL_CALL_ID.test(value)) throw new WireError(`${field} must be a tool call id`);
  return value;
}

/** Tool calls: 1 to `TOOL_LIMITS.toolCalls` function calls, each with an id, a name and its arguments as text. */
export function toolCallsFromWire(raw: unknown, field = 'tool_calls'): ToolCalls {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > TOOL_LIMITS.toolCalls) {
    throw new WireError(`${field} must be a list of 1 to ${TOOL_LIMITS.toolCalls} tool calls`);
  }
  return raw.map((c, i): ToolCall => {
    const at = `${field}[${i}]`;
    if (!isRecord(c) || (c.type !== undefined && c.type !== 'function') || !isRecord(c.function)) throw new WireError(`${at} must be a function call`);
    if (typeof c.function.arguments !== 'string') throw new WireError(`${at}.function.arguments must be text`);
    return { id: toolCallId(c.id, `${at}.id`), type: 'function', function: { name: functionName(c.function.name, `${at}.function.name`), arguments: c.function.arguments } };
  }) as ToolCalls;
}

/** Tools: up to `TOOL_LIMITS.tools` functions, each named once, with only the fields OpenAI defines for one. */
function toolsFromWire(raw: unknown): ToolSpec[] {
  if (!Array.isArray(raw) || raw.length > TOOL_LIMITS.tools) throw new WireError(`tools must be a list of at most ${TOOL_LIMITS.tools} functions`);
  const names = new Set<string>();
  return raw.map((t, i): ToolSpec => {
    const at = `tools[${i}]`;
    if (!isRecord(t) || t.type !== 'function' || !isRecord(t.function)) throw new WireError(`${at} must be a function`);
    const f = t.function;
    const name = functionName(f.name, `${at}.function.name`);
    if (names.has(name)) throw new WireError(`${at}.function.name ${name} is listed twice`);
    names.add(name);
    const fn: ToolSpec['function'] = { name };
    if (f.description !== undefined && f.description !== null) {
      if (typeof f.description !== 'string' || f.description.length > TOOL_LIMITS.descriptionChars) {
        throw new WireError(`${at}.function.description must be text of at most ${TOOL_LIMITS.descriptionChars} characters`);
      }
      fn.description = f.description;
    }
    if (f.parameters !== undefined && f.parameters !== null) {
      if (!isRecord(f.parameters)) throw new WireError(`${at}.function.parameters must be a JSON Schema object`);
      fn.parameters = f.parameters;
    }
    if (f.strict !== undefined && f.strict !== null) {
      if (typeof f.strict !== 'boolean') throw new WireError(`${at}.function.strict must be true or false`);
      fn.strict = f.strict;
    }
    return { type: 'function', function: fn };
  });
}

function toolChoiceFromWire(raw: unknown, tools: readonly ToolSpec[]): ToolChoice {
  if (raw === 'none' || raw === 'auto' || raw === 'required') return raw;
  if (isRecord(raw) && raw.type === 'function' && isRecord(raw.function) && typeof raw.function.name === 'string') {
    const name = raw.function.name;
    if (tools.some((t) => t.function.name === name)) return { type: 'function', function: { name } };
  }
  throw new WireError('tool_choice must be none, auto, required, or a function of the call\'s tools');
}

/** One message; `called` holds the ids of the tool calls before it, which a tool's result must answer. */
function messageFromWire(m: unknown, i: number, called: Set<string>): ChatMessage {
  const at = `messages[${i}]`;
  if (!isRecord(m)) throw new WireError(`${at} must be a message`);
  if (m.role === 'assistant') {
    // An answer the model gave before, decoded as any answer is (`answerFromWire`): text, or tool calls with text or none.
    const answer = answerFromWire(m, at);
    if (!answer.tool_calls) return { role: 'assistant', content: answer.content };
    for (const c of answer.tool_calls) called.add(c.id);
    return { role: 'assistant', content: answer.content, tool_calls: answer.tool_calls };
  }
  if (m.role === 'tool') {
    if (typeof m.content !== 'string') throw new WireError(`${at} must be a tool's result as text`);
    const id = toolCallId(m.tool_call_id, `${at}.tool_call_id`);
    if (!called.has(id)) throw new WireError(`${at} answers no tool call before it`);
    return { role: 'tool', content: m.content, tool_call_id: id };
  }
  if (!TEXT_ROLES.includes(m.role as (typeof TEXT_ROLES)[number]) || typeof m.content !== 'string') {
    throw new WireError(`${at} must have a role of system, user, assistant or tool and text content`);
  }
  return { role: m.role as (typeof TEXT_ROLES)[number], content: m.content };
}

/**
 * The call body: 1 to 256 messages, a positive `max_tokens`, and, when it has
 * tools, `tool_choice` and `parallel_tool_calls` as it gives them. Without
 * tools those two mean nothing and are dropped, so a text call's body is
 * `{ messages, max_tokens }` with `{ role, content }` messages, as in 10.1.0.
 * A tool's result must answer a tool call of an assistant message before it.
 */
export function inferenceBodyFromWire(raw: unknown): InferenceBody {
  if (!isRecord(raw) || !Array.isArray(raw.messages) || raw.messages.length === 0 || raw.messages.length > 256) {
    throw new WireError('messages must be a list of 1 to 256 messages');
  }
  const called = new Set<string>();
  const messages = raw.messages.map((m, i) => messageFromWire(m, i, called));
  const maxTokens = raw.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > 1_000_000) {
    throw new WireError('max_tokens must be a positive integer');
  }
  const body: InferenceBody = { messages, max_tokens: maxTokens };
  if (absent(raw.tools)) return body;
  const tools = toolsFromWire(raw.tools);
  body.tools = tools;
  if (raw.tool_choice !== undefined && raw.tool_choice !== null) body.tool_choice = toolChoiceFromWire(raw.tool_choice, tools);
  if (raw.parallel_tool_calls !== undefined && raw.parallel_tool_calls !== null) {
    if (typeof raw.parallel_tool_calls !== 'boolean') throw new WireError('parallel_tool_calls must be true or false');
    body.parallel_tool_calls = raw.parallel_tool_calls;
  }
  return body;
}

/** Whether a call needs a seller that takes tool calls: it has tools, an assistant's tool calls, or a tool's result. */
export function usesTools(body: InferenceBody): boolean {
  return body.tools !== undefined || body.messages.some((m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls !== undefined));
}

/**
 * A model's answer, as a backend's message or a served call's result carries
 * it: text, or tool calls with text or none (`content` null then). Tool calls
 * that are absent, null or an empty list are none. The one decoder of this
 * shape: the connector reads a backend's message with it, and the wire a
 * seller's result. `field` names it in errors.
 */
export function answerFromWire(raw: unknown, field = 'result'): Answer {
  if (!isRecord(raw)) throw new WireError(`${field} must have text content, or tool calls`);
  if (absent(raw.tool_calls)) {
    if (typeof raw.content !== 'string') throw new WireError(`${field} must have text content, or tool calls`);
    return { content: raw.content };
  }
  const toolCalls = toolCallsFromWire(raw.tool_calls, `${field}.tool_calls`);
  if (typeof raw.content !== 'string' && raw.content !== null && raw.content !== undefined) {
    throw new WireError(`${field} must have text content, or tool calls`);
  }
  return { content: typeof raw.content === 'string' ? raw.content : null, tool_calls: toolCalls };
}

/**
 * A served call's result (`answerFromWire`) and why the model stopped. A
 * finish reason the wire does not know is dropped: it is not signed, and says
 * nothing the receipt relies on.
 */
export function serveResultFromWire(raw: unknown): ServeResult {
  const answer = answerFromWire(raw);
  const finish = FINISH_REASONS.find((r) => r === (raw as Record<string, unknown>).finish_reason);
  return { ...answer, ...(finish ? { finish_reason: finish } : {}) };
}

/** A served call's usage, or `undefined` when it has none that reads as one: it is not signed. */
export function serveUsageFromWire(raw: unknown): ServeUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const { promptTokens, completionTokens } = raw;
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return whole(promptTokens) && whole(completionTokens) ? { promptTokens, completionTokens } : undefined;
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
        // Only `true` says the seller takes tool calls; anything else, or nothing, is text alone.
        ...(o.tools === true ? { tools: true as const } : {}),
      };
    }),
  };
}

/**
 * A seller's answer to `serve`: a refusal with a code of `SERVE_ERRORS`, or a
 * result (`serveResultFromWire`), a receipt signature, the budget's index,
 * and the usage when it reads as one. The receipt is left as it came, for the
 * buyer's checks of it.
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
  const result = serveResultFromWire(raw.result);
  if (typeof raw.receiptSignature !== 'string') throw new WireError('receiptSignature must be text');
  const usage = serveUsageFromWire(raw.usage);
  return {
    ok: true, result, receipt: raw.receipt, receiptSignature: raw.receiptSignature, budgetIndex: count(raw.budgetIndex, 'budgetIndex'),
    ...(usage ? { usage } : {}),
  };
}
