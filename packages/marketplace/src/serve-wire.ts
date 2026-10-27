/**
 * JSON shapes carried inside the unchanged serve envelope
 * (`MarketplaceServeRequest.payload` / `MarketplaceServeResponse.result`,
 * both opaque JSON bytes; the receipt commits to sha256 of the result bytes).
 * A `schema` discriminator inside the JSON selects the shape, so the core
 * proto and `MARKETPLACE_SERVE_VERSION` stay unchanged.
 *
 * Parsers are total (never throw) and strict where counting depends on it:
 * every count is a non-negative JSON safe integer, internal sums must agree,
 * and tool calls must carry exactly `{id, type, function: {name, arguments}}`.
 */
import { CHAT_TEMPLATE_OPENAI_COUNT_V1 } from './chat-metering.js';
import {
  normalizeChatMessages,
  normalizeChatToolChoice,
  normalizeChatTools,
  normalizeToolCalls,
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  type ChatToolChoice,
  type ChatToolOptions,
} from './chat-messages.js';
import { canonicalModelId } from './model-id.js';
import { countResultRows } from './query-cost.js';
import { isTokenizerKind, SHA256_DIGEST_PATTERN, type TokenizerKind } from './token-engines.js';

export const CHAT_PAYLOAD_SCHEMA = 'openai-chat/v1';
export const CHAT_RESULT_SCHEMA = 'openai-chat-result/v1';
export const QUERY_RESULT_SCHEMA = 'sparql-result/v1';

/**
 * Seller-side cap on serialized result bytes, checked before a receipt is
 * signed. The protocol router reads at most 10 MiB, so a larger result would
 * be signed and claimed but never delivered.
 */
export const MAX_SERVE_RESULT_BYTES = 8 * 1024 * 1024;

/** Seller-side defaults for `parseChatServePayload`. */
export const CHAT_PAYLOAD_MAX_MESSAGES = 256;
export const CHAT_PAYLOAD_MAX_BYTES = 2_000_000;
export const CHAT_MAX_TOKENS_LIMIT = 1_000_000;

export type MeteringBasis = 'pinned' | 'provider-reported';

export type ChatFinishReason = 'stop' | 'length' | 'tool_calls';

export interface ChatServePayload {
  schema: 'openai-chat/v1';
  /** Canonical model id. */
  model: string;
  /** The wire messages, already normalized (prompt-tool transport applied when used). */
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  stop?: string[];
}

export interface ChatMeteringBlock {
  basis: MeteringBasis;
  tokenizer?: { kind: TokenizerKind; digest: string };
  chatTemplate?: { id: 'openai-chat-count/v1'; digest: string };
  promptUnits: number;
  toolUnits: number;
  completionUnits: number;
  servedUnits: number;
  truncated: boolean;
  providerUsage?: { prompt_tokens: number; completion_tokens: number };
}

export interface ChatServeResult {
  schema: 'openai-chat-result/v1';
  model: string;
  choices: [
    {
      index: 0;
      message: { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] };
      finish_reason: ChatFinishReason;
    },
  ];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  metering: ChatMeteringBlock;
}

export type QueryAbortReason = 'timeout' | 'row-cap' | 'size-cap';

export interface QueryMeteringBlock {
  scheduleDigest: string;
  admissionUnits: number;
  deliveryUnits: number;
  servedUnits: number;
  rowCount: number;
  aborted?: { reason: QueryAbortReason };
}

export interface QueryServeResult {
  schema: 'sparql-result/v1';
  /** The seller's query result (`null` when aborted). */
  result: unknown;
  rowCount: number;
  metering: QueryMeteringBlock;
}

type Fail = { ok: false; detail: string };
const fail = (detail: string): Fail => ({ ok: false, detail });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(v, key));
}

/**
 * Parse and normalize a chat serve payload (seller side; also run by the
 * buyer on the exact bytes it is about to send). Messages are normalized
 * with `allowParts: false`.
 */
export function parseChatServePayload(
  raw: unknown,
  opts: { maxMessages?: number; maxBytes?: number } = {},
): { ok: true; payload: ChatServePayload; options: ChatToolOptions } | Fail {
  if (!isRecord(raw)) return fail('payload must be a JSON object');
  if (raw.schema !== CHAT_PAYLOAD_SCHEMA) return fail(`payload schema must be ${CHAT_PAYLOAD_SCHEMA}`);
  const model = canonicalModelId(raw.model);
  if (model === undefined) return fail('model must be a valid model id');
  const messages = normalizeChatMessages(raw.messages, {
    maxMessages: opts.maxMessages ?? CHAT_PAYLOAD_MAX_MESSAGES,
    maxBytes: opts.maxBytes ?? CHAT_PAYLOAD_MAX_BYTES,
    allowParts: false,
  });
  if (!messages.ok) return fail(messages.detail);
  const tools = normalizeChatTools(raw.tools);
  if (!tools.ok) return fail(tools.detail);
  const toolChoice = normalizeChatToolChoice(raw.tool_choice);
  if (!toolChoice.ok) return fail(toolChoice.detail);
  const parallel = raw.parallel_tool_calls;
  if (parallel !== undefined && typeof parallel !== 'boolean') return fail('parallel_tool_calls must be a boolean');
  const maxTokens = raw.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > CHAT_MAX_TOKENS_LIMIT) {
    return fail(`max_tokens must be an integer 1..${CHAT_MAX_TOKENS_LIMIT}`);
  }
  const { temperature, top_p: topP, seed, stop } = raw;
  if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    return fail('temperature must be a number 0..2');
  }
  if (topP !== undefined && (typeof topP !== 'number' || !Number.isFinite(topP) || topP < 0 || topP > 1)) {
    return fail('top_p must be a number 0..1');
  }
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isSafeInteger(seed))) return fail('seed must be a safe integer');
  if (
    stop !== undefined &&
    (!Array.isArray(stop) ||
      stop.length > 4 ||
      !stop.every((s) => typeof s === 'string' && s.length >= 1 && s.length <= 256))
  ) {
    return fail('stop must be at most 4 strings of 1..256 characters');
  }
  const payload: ChatServePayload = {
    schema: CHAT_PAYLOAD_SCHEMA,
    model,
    messages: messages.messages,
    ...(tools.tools ? { tools: tools.tools } : {}),
    ...(toolChoice.toolChoice !== undefined ? { tool_choice: toolChoice.toolChoice } : {}),
    ...(parallel !== undefined ? { parallel_tool_calls: parallel } : {}),
    max_tokens: maxTokens,
    ...(temperature !== undefined ? { temperature: temperature as number } : {}),
    ...(topP !== undefined ? { top_p: topP as number } : {}),
    ...(seed !== undefined ? { seed: seed as number } : {}),
    ...(stop !== undefined ? { stop: stop as string[] } : {}),
  };
  const options: ChatToolOptions = {
    ...(tools.tools ? { tools: tools.tools } : {}),
    ...(toolChoice.toolChoice !== undefined ? { toolChoice: toolChoice.toolChoice } : {}),
    ...(parallel !== undefined ? { parallelToolCalls: parallel } : {}),
  };
  return { ok: true, payload, options };
}

const TOOL_CALL_KEYS = ['id', 'type', 'function'] as const;
const TOOL_FUNCTION_KEYS = ['name', 'arguments'] as const;

/** Validate delivered tool calls WITHOUT re-normalizing them (R4 counts the parsed array as is). */
function checkResultToolCalls(raw: unknown): { ok: true; value: ChatToolCall[] } | Fail {
  const normalized = normalizeToolCalls(raw, 'choices[0].message.tool_calls');
  if (!normalized.ok) return fail(normalized.detail);
  const calls = raw as unknown[];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] as Record<string, unknown>;
    if (!hasExactKeys(call, TOOL_CALL_KEYS) || !isRecord(call.function) || !hasExactKeys(call.function, TOOL_FUNCTION_KEYS)) {
      return fail(`choices[0].message.tool_calls[${i}] must carry exactly {id, type, function: {name, arguments}}`);
    }
  }
  return { ok: true, value: calls as ChatToolCall[] };
}

function parseChatMetering(raw: unknown): { ok: true; value: ChatMeteringBlock } | Fail {
  if (!isRecord(raw)) return fail('metering must be an object');
  const { basis, tokenizer, chatTemplate, promptUnits, toolUnits, completionUnits, servedUnits, truncated, providerUsage } = raw;
  if (basis !== 'pinned' && basis !== 'provider-reported') return fail('metering.basis must be pinned or provider-reported');
  if (!isCount(promptUnits) || !isCount(toolUnits) || !isCount(completionUnits) || !isCount(servedUnits)) {
    return fail('metering units must be non-negative safe integers');
  }
  if (promptUnits + toolUnits + completionUnits !== servedUnits) return fail('metering.servedUnits must equal the sum of its parts');
  if (typeof truncated !== 'boolean') return fail('metering.truncated must be a boolean');
  const block: ChatMeteringBlock = { basis, promptUnits, toolUnits, completionUnits, servedUnits, truncated };
  if (tokenizer !== undefined) {
    if (!isRecord(tokenizer) || !isTokenizerKind(tokenizer.kind) || typeof tokenizer.digest !== 'string' || !SHA256_DIGEST_PATTERN.test(tokenizer.digest)) {
      return fail('metering.tokenizer must be {kind, digest}');
    }
    block.tokenizer = { kind: tokenizer.kind, digest: tokenizer.digest };
  }
  if (chatTemplate !== undefined) {
    if (
      !isRecord(chatTemplate) ||
      chatTemplate.id !== CHAT_TEMPLATE_OPENAI_COUNT_V1.version ||
      typeof chatTemplate.digest !== 'string' ||
      !SHA256_DIGEST_PATTERN.test(chatTemplate.digest)
    ) {
      return fail('metering.chatTemplate must be {id: openai-chat-count/v1, digest}');
    }
    block.chatTemplate = { id: CHAT_TEMPLATE_OPENAI_COUNT_V1.version, digest: chatTemplate.digest };
  }
  if (providerUsage !== undefined) {
    if (!isRecord(providerUsage) || !isCount(providerUsage.prompt_tokens) || !isCount(providerUsage.completion_tokens)) {
      return fail('metering.providerUsage must be {prompt_tokens, completion_tokens}');
    }
    block.providerUsage = { prompt_tokens: providerUsage.prompt_tokens, completion_tokens: providerUsage.completion_tokens };
  }
  if (basis === 'pinned' && (!block.tokenizer || !block.chatTemplate)) {
    return fail('pinned metering must name its tokenizer and chat template');
  }
  if (basis === 'provider-reported') {
    if (block.tokenizer || block.chatTemplate) return fail('provider-reported metering carries no tokenizer pin');
    if (!block.providerUsage) return fail('provider-reported metering must echo providerUsage');
    if (block.providerUsage.prompt_tokens + block.providerUsage.completion_tokens !== servedUnits) {
      return fail('provider-reported servedUnits must equal the provider usage total');
    }
  }
  return { ok: true, value: block };
}

/**
 * Parse a seller's chat result. `content` is `null` only alongside
 * non-empty `tool_calls`; `finish_reason` is `tool_calls` iff tool calls are
 * present; `usage` must agree with the metering block (pinned: prompt =
 * promptUnits + toolUnits, completion = completionUnits; provider-reported:
 * usage = providerUsage); total = servedUnits.
 */
export function parseChatServeResult(raw: unknown): { ok: true; result: ChatServeResult } | Fail {
  if (!isRecord(raw)) return fail('result must be a JSON object');
  if (raw.schema !== CHAT_RESULT_SCHEMA) return fail(`result schema must be ${CHAT_RESULT_SCHEMA}`);
  if (typeof raw.model !== 'string' || canonicalModelId(raw.model) !== raw.model) return fail('model must be a canonical model id');
  if (!Array.isArray(raw.choices) || raw.choices.length !== 1) return fail('choices must hold exactly one choice');
  const choice = raw.choices[0] as unknown;
  if (!isRecord(choice) || choice.index !== 0) return fail('choices[0].index must be 0');
  const message = choice.message;
  if (!isRecord(message) || message.role !== 'assistant') return fail('choices[0].message.role must be assistant');
  let toolCalls: ChatToolCall[] | undefined;
  if (message.tool_calls !== undefined) {
    const checked = checkResultToolCalls(message.tool_calls);
    if (!checked.ok) return checked;
    toolCalls = checked.value;
  }
  const content = message.content;
  if (content !== null && typeof content !== 'string') return fail('choices[0].message.content must be a string or null');
  if (content === null && !toolCalls) return fail('choices[0].message.content may be null only alongside tool_calls');
  const finish = choice.finish_reason;
  if (finish !== 'stop' && finish !== 'length' && finish !== 'tool_calls') {
    return fail('choices[0].finish_reason must be stop, length or tool_calls');
  }
  if ((finish === 'tool_calls') !== Boolean(toolCalls)) return fail('finish_reason is tool_calls iff tool_calls are present');
  const usage = raw.usage;
  if (!isRecord(usage) || !isCount(usage.prompt_tokens) || !isCount(usage.completion_tokens) || !isCount(usage.total_tokens)) {
    return fail('usage must hold non-negative safe integer token counts');
  }
  const metering = parseChatMetering(raw.metering);
  if (!metering.ok) return metering;
  const m = metering.value;
  const expectedPrompt = m.basis === 'pinned' ? m.promptUnits + m.toolUnits : m.providerUsage!.prompt_tokens;
  const expectedCompletion = m.basis === 'pinned' ? m.completionUnits : m.providerUsage!.completion_tokens;
  if (usage.prompt_tokens !== expectedPrompt || usage.completion_tokens !== expectedCompletion || usage.total_tokens !== m.servedUnits) {
    return fail('usage does not agree with the metering block');
  }
  const deliveredMessage: ChatServeResult['choices'][0]['message'] = {
    role: 'assistant',
    content,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  };
  return {
    ok: true,
    result: {
      schema: CHAT_RESULT_SCHEMA,
      model: raw.model,
      choices: [{ index: 0, message: deliveredMessage, finish_reason: finish }],
      usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
      metering: m,
    },
  };
}

/**
 * Parse a seller's query result. Internally consistent: servedUnits =
 * admission + delivery, `metering.rowCount === rowCount`; an aborted result
 * carries `result: null`, 0 rows and 0 delivery units; a delivered result's
 * rowCount is `countResultRows(result)`.
 */
export function parseQueryServeResult(raw: unknown): { ok: true; result: QueryServeResult } | Fail {
  if (!isRecord(raw)) return fail('result must be a JSON object');
  if (raw.schema !== QUERY_RESULT_SCHEMA) return fail(`result schema must be ${QUERY_RESULT_SCHEMA}`);
  if (!Object.prototype.hasOwnProperty.call(raw, 'result')) return fail('result.result is required');
  const { rowCount, metering } = raw;
  if (!isCount(rowCount)) return fail('rowCount must be a non-negative safe integer');
  if (!isRecord(metering)) return fail('metering must be an object');
  const { scheduleDigest, admissionUnits, deliveryUnits, servedUnits, aborted } = metering;
  if (typeof scheduleDigest !== 'string' || !SHA256_DIGEST_PATTERN.test(scheduleDigest)) {
    return fail('metering.scheduleDigest must be a sha256 digest');
  }
  if (!isCount(admissionUnits) || !isCount(deliveryUnits) || !isCount(servedUnits) || !isCount(metering.rowCount)) {
    return fail('metering units must be non-negative safe integers');
  }
  if (admissionUnits + deliveryUnits !== servedUnits) return fail('metering.servedUnits must equal admission + delivery');
  if (metering.rowCount !== rowCount) return fail('metering.rowCount must equal rowCount');
  const block: QueryMeteringBlock = { scheduleDigest, admissionUnits, deliveryUnits, servedUnits, rowCount };
  if (aborted !== undefined) {
    if (!isRecord(aborted) || (aborted.reason !== 'timeout' && aborted.reason !== 'row-cap' && aborted.reason !== 'size-cap')) {
      return fail('metering.aborted.reason must be timeout, row-cap or size-cap');
    }
    if (raw.result !== null || rowCount !== 0 || deliveryUnits !== 0) {
      return fail('an aborted query delivers no result, no rows and no delivery units');
    }
    block.aborted = { reason: aborted.reason };
  } else if (countResultRows(raw.result) !== rowCount) {
    return fail('rowCount must equal the rows of the delivered result');
  }
  return { ok: true, result: { schema: QUERY_RESULT_SCHEMA, result: raw.result, rowCount, metering: block } };
}
