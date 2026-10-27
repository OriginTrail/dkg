/**
 * OT-RFC-27 buyer chat + gateway calls over the routed invoke pipeline: the
 * OpenAI-shaped chat completion (`openai-chat/v1` offers), the metered SPARQL
 * query, and the gateway model list.
 *
 * Chat check order (the gateway's error mapping depends on it): runtime →
 * subscription → input normalization → model resolution → plan bucket →
 * payload validation per tool transport (before any quote probe) → route →
 * spend-guard admit → reserve → sign → serve → receipt verify → recount →
 * tool-response validation.
 *
 * `wireFor(offer)` is the ONLY place wire messages/options are built, and the
 * authorization sizing, the serialized payload and the recount all use those
 * same objects, so an honest seller's count equals the buyer's.
 */
import {
  CHAT_PAYLOAD_SCHEMA,
  CHAT_MAX_TOKENS_LIMIT,
  DEFAULT_QUERY_GUARDS,
  TOOL_CALL_SLACK_UNITS,
  assertQueryWithinLimit,
  buildPromptToolTransport,
  canonicalModelId,
  chatPromptUpperBound,
  countChatPromptUnits,
  countChatToolUnits,
  countResultRows,
  hasToolHistory,
  matchPolicyBucket,
  normalizeChatMessages,
  normalizeChatToolChoice,
  normalizeChatTools,
  parseChatServePayload,
  parseChatServeResult,
  parsePromptToolTransport,
  parseQueryServeResult,
  queryWorstCaseUnits,
  recountChat,
  recountQuery,
  validateToolCallsAgainstOptions,
  type ChatMessage,
  type ChatMeteringBlock,
  type ChatToolCall,
  type ChatToolOptions,
  type MarketplaceOffer,
  type MeteringBasis,
  type QueryMeteringBlock,
  type RecountVerdict,
  type TokenizerKind,
  type ToolTransport,
} from '@origintrail-official/dkg-marketplace';
import {
  MarketplaceInvalidToolResponseError,
  MarketplaceModelNotFoundError,
  MarketplaceRequestError,
  type MarketplaceRequestErrorCode,
  type MarketplaceSpendGuard,
} from './buyer-errors.js';
import {
  MarketplaceInvokeError,
  MarketplaceRouteError,
  type MarketplaceBuyerService,
  type MarketplaceInvokeResult,
} from './buyer-service.js';
import type { BuyerTokenizers } from './tokenizer-files.js';

export interface MarketplaceChatCompletionInput {
  model: string;
  messages: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  parallelToolCalls?: unknown;
  maxTokens?: number;
  defaultMaxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  stop?: string | string[];
  spendGuard?: MarketplaceSpendGuard;
}

export interface MarketplaceChatCompletionResult {
  callId: string;
  model: string;
  message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] };
  finishReason: 'stop' | 'length' | 'tool_calls';
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  metering: ChatMeteringBlock;
  recount: RecountVerdict;
  invoke: MarketplaceInvokeResult;
}

export interface MarketplaceGatewayQueryResult {
  callId: string;
  result: unknown;
  rowCount: number;
  aborted?: { reason: 'timeout' | 'row-cap' | 'size-cap' };
  metering: QueryMeteringBlock;
  recount: RecountVerdict;
  invoke: MarketplaceInvokeResult;
}

export interface MarketplaceGatewayModel {
  id: string;
  contextLength?: bigint;
  offers: number;
  sellers: bigint[];
  minAskPerUnitWei: bigint;
  meteringBases: MeteringBasis[];
  tokenizerKinds: TokenizerKind[];
  provenanceClasses: string[];
  toolTransports: string[];
  routable: boolean;
}

export interface BuyerChatDeps {
  buyer: MarketplaceBuyerService;
  tokenizers: BuyerTokenizers;
  chatServeTimeoutMs: number;
}

export const DEFAULT_CHAT_MAX_TOKENS = 256;
export const DEFAULT_CHAT_SERVE_TIMEOUT_MS = 200_000;
const MAX_QUERY_ROWS = 10_000;

const requestError = (code: MarketplaceRequestErrorCode, message: string, param?: string) =>
  new MarketplaceRequestError(code, message, param);

function tokenCount(value: unknown, param: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > CHAT_MAX_TOKENS_LIMIT) {
    throw requestError('invalid_parameter', `${param} must be an integer 1..${CHAT_MAX_TOKENS_LIMIT}`, param);
  }
  return value;
}

function boundedNumber(value: unknown, max: number, param: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw requestError('invalid_parameter', `${param} must be a number 0..${max}`, param);
  }
  return value;
}

interface NormalizedChat {
  model: string;
  messages: ChatMessage[];
  options: ChatToolOptions;
  maxTokens?: number;
  defaultMaxTokens: number;
  sampler: { temperature?: number; top_p?: number; seed?: number; stop?: string[] };
  /** Tools offered with `tool_choice ≠ none`, or tool history: needs a native/prompt transport. */
  requiresTools: boolean;
}

function normalizeChatInput(input: MarketplaceChatCompletionInput): NormalizedChat {
  const model = canonicalModelId(input.model);
  if (model === undefined) throw requestError('invalid_model', 'model must be a valid model id', 'model');
  const messages = normalizeChatMessages(input.messages, { allowParts: true });
  if (!messages.ok) throw requestError('invalid_messages', messages.detail, 'messages');
  const tools = normalizeChatTools(input.tools);
  if (!tools.ok) throw requestError('invalid_tools', tools.detail, 'tools');
  const toolChoice = normalizeChatToolChoice(input.toolChoice);
  if (!toolChoice.ok) throw requestError('invalid_tools', toolChoice.detail, 'tool_choice');
  const choice = toolChoice.toolChoice;
  if ((choice === 'required' || typeof choice === 'object') && !tools.tools?.length) {
    throw requestError('invalid_tools', 'tool_choice requires tools', 'tool_choice');
  }
  if (typeof choice === 'object' && !tools.tools?.some((tool) => tool.function.name === choice.function.name)) {
    throw requestError('invalid_tools', `tool_choice names ${choice.function.name}, which is not in tools`, 'tool_choice');
  }
  const parallel = input.parallelToolCalls ?? undefined;
  if (parallel !== undefined && typeof parallel !== 'boolean') {
    throw requestError('invalid_parameter', 'parallel_tool_calls must be a boolean', 'parallel_tool_calls');
  }
  const seed = input.seed ?? undefined;
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isSafeInteger(seed))) {
    throw requestError('invalid_parameter', 'seed must be a safe integer', 'seed');
  }
  const rawStop = input.stop ?? undefined;
  const stop = typeof rawStop === 'string' ? [rawStop] : rawStop;
  if (stop !== undefined
    && (!Array.isArray(stop) || stop.length > 4 || !stop.every((s) => typeof s === 'string' && s.length >= 1 && s.length <= 256))) {
    throw requestError('invalid_parameter', 'stop must be a string or at most 4 strings of 1..256 characters', 'stop');
  }
  const temperature = boundedNumber(input.temperature, 2, 'temperature');
  const topP = boundedNumber(input.topP, 1, 'top_p');
  const maxTokens = tokenCount(input.maxTokens, 'max_tokens');
  const options: ChatToolOptions = {
    ...(tools.tools ? { tools: tools.tools } : {}),
    ...(choice !== undefined ? { toolChoice: choice } : {}),
    ...(parallel !== undefined ? { parallelToolCalls: parallel } : {}),
  };
  return {
    model,
    messages: messages.messages,
    options,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    defaultMaxTokens: tokenCount(input.defaultMaxTokens, 'defaultMaxTokens') ?? DEFAULT_CHAT_MAX_TOKENS,
    sampler: {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(stop !== undefined && stop.length > 0 ? { stop } : {}),
    },
    requiresTools: (Boolean(options.tools?.length) && choice !== 'none') || hasToolHistory(messages.messages),
  };
}

/** Map a seller-side payload-limit detail to the request error the caller can fix. */
function payloadRequestError(detail: string): MarketplaceRequestError {
  if (/^(messages|too many messages)/.test(detail)) return requestError('invalid_messages', detail, 'messages');
  if (/^(tools|tool_choice|too many tools|tool definitions)/.test(detail)) return requestError('invalid_tools', detail, 'tools');
  const param = ['temperature', 'top_p', 'seed', 'stop', 'max_tokens', 'parallel_tool_calls', 'model'].find((p) => detail.startsWith(p));
  return requestError('invalid_parameter', detail, param);
}

interface Wire {
  wire: ChatMessage[];
  wireOpts: ChatToolOptions;
}

class ChatCall {
  readonly #request: NormalizedChat;
  readonly #tokenizers: BuyerTokenizers;
  readonly #wires = new Map<ToolTransport, Wire>();
  readonly #fixed = new Map<string, bigint>();

  constructor(request: NormalizedChat, tokenizers: BuyerTokenizers) {
    this.#request = request;
    this.#tokenizers = tokenizers;
  }

  wireFor(offer: MarketplaceOffer): Wire {
    const transport = offer.toolTransport ?? 'none';
    let wire = this.#wires.get(transport);
    if (!wire) {
      const { messages, options } = this.#request;
      if (transport === 'native') {
        wire = { wire: messages, wireOpts: options };
      } else if (transport === 'prompt') {
        const translate = Boolean(options.tools?.length) || hasToolHistory(messages);
        wire = { wire: translate ? buildPromptToolTransport(messages, options) : messages, wireOpts: {} };
      } else {
        // Reached only without required tools: tool fields are STRIPPED.
        wire = { wire: messages, wireOpts: {} };
      }
      this.#wires.set(transport, wire);
    }
    return wire;
  }

  #slack(offer: MarketplaceOffer, wireOpts: ChatToolOptions): bigint {
    return offer.toolTransport === 'native' && wireOpts.tools?.length && wireOpts.toolChoice !== 'none'
      ? TOOL_CALL_SLACK_UNITS
      : 0n;
  }

  /** `promptUnits + toolUnits` under the offer's pin, or the strict byte bound. Memoized per (pin, transport). */
  fixed(offer: MarketplaceOffer): bigint {
    const engine = this.#tokenizers.engineFor(offer.metering);
    const key = `${engine?.digest ?? 'upper'}|${offer.toolTransport ?? 'none'}`;
    let fixed = this.#fixed.get(key);
    if (fixed === undefined) {
      const { wire, wireOpts } = this.wireFor(offer);
      fixed = engine
        ? countChatPromptUnits(engine, wire) + countChatToolUnits(engine, wire, wireOpts)
        : chatPromptUpperBound(wire, wireOpts);
      this.#fixed.set(key, fixed);
    }
    return fixed;
  }

  maxUnitsFor(offer: MarketplaceOffer, bucketCap: bigint): bigint {
    const fixed = this.fixed(offer);
    const slack = this.#slack(offer, this.wireFor(offer).wireOpts);
    const explicit = this.#request.maxTokens;
    let units = fixed + BigInt(explicit ?? this.#request.defaultMaxTokens) + slack;
    // Clamp only a DEFAULT max_tokens to the bucket cap (≥ 1 completion unit must remain).
    if (explicit === undefined && units > bucketCap && bucketCap - fixed - slack >= 1n) units = bucketCap;
    return units;
  }

  payloadFor(offer: MarketplaceOffer, maxUnits: bigint): Record<string, unknown> {
    const { wire, wireOpts } = this.wireFor(offer);
    const maxTokens = maxUnits - this.fixed(offer) - this.#slack(offer, wireOpts);
    return this.#payload(wire, wireOpts, maxTokens);
  }

  #payload(wire: ChatMessage[], wireOpts: ChatToolOptions, maxTokens: bigint): Record<string, unknown> {
    return {
      schema: CHAT_PAYLOAD_SCHEMA,
      model: this.#request.model,
      messages: wire,
      ...(wireOpts.tools ? { tools: wireOpts.tools } : {}),
      ...(wireOpts.toolChoice !== undefined ? { tool_choice: wireOpts.toolChoice } : {}),
      ...(wireOpts.parallelToolCalls !== undefined ? { parallel_tool_calls: wireOpts.parallelToolCalls } : {}),
      max_tokens: Number(maxTokens),
      ...this.#request.sampler,
    };
  }

  /** Seller-side limits checked on the exact serialized shape, once per transport, before any probe. */
  validatePayloads(offers: readonly MarketplaceOffer[]): void {
    const checked = new Set<ToolTransport>();
    for (const offer of offers) {
      const transport = offer.toolTransport ?? 'none';
      if (checked.has(transport)) continue;
      checked.add(transport);
      if (this.#request.requiresTools && transport === 'none') continue; // routed away as tools-unsupported
      const { wire, wireOpts } = this.wireFor(offer);
      const probe = this.#payload(wire, wireOpts, BigInt(this.#request.maxTokens ?? 1));
      const parsed = parseChatServePayload(JSON.parse(JSON.stringify(probe)));
      if (!parsed.ok) throw payloadRequestError(parsed.detail);
    }
  }

  /** Post-receipt: conformance, then the request's tool policy (per transport). */
  finish(offer: MarketplaceOffer, invoke: MarketplaceInvokeResult): MarketplaceChatCompletionResult {
    const parsed = parseChatServeResult(invoke.result);
    if (!parsed.ok) {
      throw new MarketplaceInvokeError('MALFORMED_RESULT', `the chat result does not conform to openai-chat-result/v1: ${parsed.detail}`, 'served');
    }
    const { options } = this.#request;
    const choice = parsed.result.choices[0];
    let message: MarketplaceChatCompletionResult['message'] = {
      role: 'assistant',
      content: choice.message.content,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    };
    let finishReason = choice.finish_reason;
    const acceptsNewCalls = Boolean(options.tools?.length) && options.toolChoice !== 'none';
    if (offer.toolTransport === 'prompt' && acceptsNewCalls && !choice.message.tool_calls) {
      const calls = parsePromptToolTransport(choice.message.content ?? '', options);
      if (!calls.ok) throw new MarketplaceInvalidToolResponseError(calls.detail, invoke, invoke.recount);
      if (calls.toolCalls) {
        message = { role: 'assistant', content: null, tool_calls: calls.toolCalls };
        finishReason = 'tool_calls';
      }
    } else {
      const policy = validateToolCallsAgainstOptions(choice.message.tool_calls, options, 'tool_calls');
      if (!policy.ok) throw new MarketplaceInvalidToolResponseError(policy.detail, invoke, invoke.recount);
    }
    const { usage } = parsed.result;
    return {
      callId: invoke.authorization.callId,
      model: this.#request.model,
      message,
      finishReason,
      usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
      metering: parsed.result.metering,
      recount: invoke.recount,
      invoke,
    };
  }
}

export async function runChatCompletion(
  deps: BuyerChatDeps,
  input: MarketplaceChatCompletionInput,
): Promise<MarketplaceChatCompletionResult> {
  const { policy } = deps.buyer.requirePlan();
  const request = normalizeChatInput(input);
  const offers = await deps.buyer.discoverOffers();
  if (offers.length === 0) throw new MarketplaceRouteError('no-offers', []);
  const chatOffers = offers.filter((offer) => offer.apiShape === CHAT_PAYLOAD_SCHEMA && offer.modelId === request.model);
  if (chatOffers.length === 0) throw new MarketplaceModelNotFoundError(request.model);
  const bucketIndex = matchPolicyBucket(policy, { serviceType: 'inference', modelId: request.model });
  if (bucketIndex < 0) throw new MarketplaceRouteError('no-bucket', []);
  const bucketCap = policy.buckets[bucketIndex].maxUnitsPerCall;
  const call = new ChatCall(request, deps.tokenizers);
  call.validatePayloads(chatOffers);

  let completion: MarketplaceChatCompletionResult | undefined;
  await deps.buyer.invokeRouted({
    serviceType: 'inference',
    modelId: request.model,
    maxUnits: bucketCap,
    maxUnitsFor: (offer) => call.maxUnitsFor(offer, bucketCap),
    requireApiShape: CHAT_PAYLOAD_SCHEMA,
    requiresTools: request.requiresTools,
    offers,
    payloadFor: (offer, maxUnits) => call.payloadFor(offer, maxUnits),
    serveTimeoutMs: deps.chatServeTimeoutMs,
    minAuthTtlSeconds: Math.ceil(deps.chatServeTimeoutMs / 1000) + 300,
    ...(input.spendGuard ? { spendGuard: input.spendGuard } : {}),
    recount: (offer, served) => {
      const { wire, wireOpts } = call.wireFor(offer);
      return recountChat({
        engine: deps.tokenizers.engineFor(offer.metering),
        offerMetering: offer.metering,
        wireMessages: wire,
        wireOptions: wireOpts,
        result: served.result,
        receiptServedUnits: served.servedUnits,
      });
    },
    validate: (offer, invoke) => {
      completion = call.finish(offer, invoke);
    },
  });
  return completion!;
}

const LEGACY_QUERY_DIGEST = '';

export async function runGatewayQuery(
  deps: BuyerChatDeps,
  input: { sparql: string; maxRows?: number; spendGuard?: MarketplaceSpendGuard },
): Promise<MarketplaceGatewayQueryResult> {
  const { policy } = deps.buyer.requirePlan();
  const { sparql } = input;
  if (typeof sparql !== 'string' || sparql.trim() === '') throw requestError('invalid_sparql', 'sparql must be a non-empty string', 'sparql');
  try {
    assertQueryWithinLimit(sparql);
  } catch (error) {
    throw requestError('invalid_sparql', (error as Error).message, 'sparql');
  }
  const maxRows = input.maxRows ?? undefined;
  if (maxRows !== undefined && (typeof maxRows !== 'number' || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_QUERY_ROWS)) {
    throw requestError('invalid_parameter', `max_rows must be an integer 1..${MAX_QUERY_ROWS}`, 'max_rows');
  }
  if (matchPolicyBucket(policy, { serviceType: 'query' }) < 0) throw new MarketplaceRouteError('no-bucket', []);
  const invoke = await deps.buyer.invokeRouted({
    serviceType: 'query',
    maxUnits: queryWorstCaseUnits(sparql, maxRows ?? DEFAULT_QUERY_GUARDS.maxRows),
    payloadFor: () => ({ sparql }),
    ...(input.spendGuard ? { spendGuard: input.spendGuard } : {}),
    recount: (offer, served) => recountQuery({
      sparql, offerQueryCost: offer.queryCost, result: served.result, receiptServedUnits: served.servedUnits,
    }),
    validate: (offer, invoke) => {
      if (offer.queryCost && invoke.recount.reason === 'malformed-result') {
        throw new MarketplaceInvokeError('MALFORMED_RESULT', 'the query result does not conform to sparql-result/v1', 'served');
      }
    },
  });
  const parsed = parseQueryServeResult(invoke.result);
  if (parsed.ok) {
    const { result, rowCount, metering } = parsed.result;
    return {
      callId: invoke.authorization.callId,
      result,
      rowCount,
      ...(metering.aborted ? { aborted: metering.aborted } : {}),
      metering,
      recount: invoke.recount,
      invoke,
    };
  }
  // A pre-schedule seller (`{ result }` only): the whole charge is reported as admission.
  const legacy = (invoke.result as { result?: unknown } | null)?.result ?? null;
  const rowCount = countResultRows(legacy);
  return {
    callId: invoke.authorization.callId,
    result: legacy,
    rowCount,
    metering: {
      scheduleDigest: LEGACY_QUERY_DIGEST,
      admissionUnits: Number(invoke.servedUnits),
      deliveryUnits: 0,
      servedUnits: Number(invoke.servedUnits),
      rowCount,
    },
    recount: invoke.recount,
    invoke,
  };
}

const sortedUnique = <T>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/** Chat models across discovered `openai-chat/v1` offers (no subscription needed; `routable` needs a matching bucket). */
export async function listGatewayModels(deps: BuyerChatDeps): Promise<MarketplaceGatewayModel[]> {
  const offers = await deps.buyer.discoverOffers();
  const policy = deps.buyer.activePolicy();
  const byModel = new Map<string, MarketplaceOffer[]>();
  for (const offer of offers) {
    if (offer.apiShape !== CHAT_PAYLOAD_SCHEMA || offer.modelId === undefined) continue;
    const list = byModel.get(offer.modelId);
    if (list) list.push(offer);
    else byModel.set(offer.modelId, [offer]);
  }
  return [...byModel.keys()].sort().map((id) => {
    const group = byModel.get(id)!;
    const contexts = group.map((offer) => offer.model?.contextLength).filter((v): v is bigint => v !== undefined);
    const minAsk = group.reduce((min, offer) => (offer.askPerUnitWei < min ? offer.askPerUnitWei : min), group[0].askPerUnitWei);
    return {
      id,
      ...(contexts.length > 0 ? { contextLength: contexts.reduce((a, b) => (b < a ? b : a)) } : {}),
      offers: group.length,
      sellers: [...new Set(group.map((offer) => offer.sellerIdentityId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      minAskPerUnitWei: minAsk,
      meteringBases: sortedUnique(group.flatMap((offer) => (offer.metering ? [offer.metering.basis] : []))),
      tokenizerKinds: sortedUnique(group.flatMap((offer) => (offer.metering?.basis === 'pinned' ? [offer.metering.tokenizer.kind] : []))),
      provenanceClasses: sortedUnique(group.flatMap((offer) => (offer.model?.provenanceClass ? [offer.model.provenanceClass] : []))),
      toolTransports: sortedUnique(group.map((offer) => offer.toolTransport ?? 'none')),
      routable: policy !== undefined && matchPolicyBucket(policy, { serviceType: 'inference', modelId: id }) >= 0,
    };
  });
}
