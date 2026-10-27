/**
 * Chat metering under a pinned count engine and the `openai-chat-count/v1`
 * template. The seller bills with these functions and the buyer recounts
 * with the same functions over the same committed bytes.
 *
 * Canonical counting rules (carried from the fork's inference meter):
 *   R1 the delivered completion is `choices[0].message.content` of the result
 *      JSON, verbatim after the JSON parser's own unescaping;
 *   R2 UTF-8, no normalization, no trim, no whitespace mutation;
 *   R3 an empty delivered completion is legal and counts 0;
 *   R4 tool calls count as `encodeCount(JSON.stringify(tool_calls))` of the
 *      array as serialized (seller) / as JSON-parsed from the result bytes
 *      (buyer), never re-normalized.
 *
 * Every count is `bigint` at this boundary; engines count with `number`
 * internally (bounded by text length).
 */
import type { ChatMessage, ChatToolCall, ChatToolOptions } from './chat-messages.js';
import { sha256Digest, type TokenCountEngine } from './token-engines.js';

export interface ChatTemplate {
  readonly version: 'openai-chat-count/v1';
  readonly perMessageTokens: number;
  readonly perReplyPrimerTokens: number;
}

/** OpenAI-cookbook message overhead constants, frozen and pinned by digest. */
export const CHAT_TEMPLATE_OPENAI_COUNT_V1: ChatTemplate = Object.freeze({
  version: 'openai-chat-count/v1',
  perMessageTokens: 3,
  perReplyPrimerTokens: 3,
});

/** sha256 of `JSON.stringify({version, perMessageTokens, perReplyPrimerTokens})` in that key order. */
export function chatTemplateDigest(t: ChatTemplate): string {
  return sha256Digest(
    JSON.stringify({ version: t.version, perMessageTokens: t.perMessageTokens, perReplyPrimerTokens: t.perReplyPrimerTokens }),
  );
}

export const CHAT_TEMPLATE_OPENAI_COUNT_V1_DIGEST = chatTemplateDigest(CHAT_TEMPLATE_OPENAI_COUNT_V1);

/**
 * Extra authorized units when native tool calls may be returned: R4 counts
 * provider ids and wrapper keys that the upstream's `max_tokens` does not
 * bound. Only tool calls can use it — the content cap stays at `max_tokens`.
 */
export const TOOL_CALL_SLACK_UNITS = 128n;

const utf8Length = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * The request metadata the role/content formula does not cover (fork
 * `chatToolReservationUnits` payload): per-message `{name?, tool_call_id?,
 * tool_calls?}` plus the tool options. `''` when there is neither metadata
 * nor any tool option.
 */
export function toolEnvelopeText(messages: readonly ChatMessage[], options: ChatToolOptions): string {
  const messageMetadata = messages.map((m) => ({
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
  }));
  const hasMetadata = messageMetadata.some((m) => Object.keys(m).length > 0);
  if (!hasMetadata && !options.tools && options.toolChoice === undefined && options.parallelToolCalls === undefined) {
    return '';
  }
  return JSON.stringify({
    messageMetadata,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
    ...(options.parallelToolCalls !== undefined ? { parallel_tool_calls: options.parallelToolCalls } : {}),
  });
}

/** `Σ (E(content) + E(role) + perMessageTokens) + perReplyPrimerTokens`. */
export function countChatPromptUnits(
  engine: TokenCountEngine,
  messages: readonly ChatMessage[],
  template: ChatTemplate = CHAT_TEMPLATE_OPENAI_COUNT_V1,
): bigint {
  let units = BigInt(template.perReplyPrimerTokens);
  for (const m of messages) {
    units += BigInt(engine.encodeCount(m.content) + engine.encodeCount(m.role) + template.perMessageTokens);
  }
  return units;
}

/** `E(toolEnvelopeText)`, or 0 when the envelope is empty. */
export function countChatToolUnits(
  engine: TokenCountEngine,
  messages: readonly ChatMessage[],
  options: ChatToolOptions,
): bigint {
  const text = toolEnvelopeText(messages, options);
  return text === '' ? 0n : BigInt(engine.encodeCount(text));
}

/** `E(content ?? '') + (toolCalls?.length ? E(JSON.stringify(toolCalls)) : 0)` (R1, R3, R4). */
export function countChatCompletionUnits(
  engine: TokenCountEngine,
  content: string | null,
  toolCalls?: readonly ChatToolCall[],
): bigint {
  const contentUnits = engine.encodeCount(content ?? '');
  const toolCallUnits = toolCalls?.length ? engine.encodeCount(JSON.stringify(toolCalls)) : 0;
  return BigInt(contentUnits + toolCallUnits);
}

export interface ChatUnitBreakdown {
  promptUnits: bigint;
  toolUnits: bigint;
  completionUnits: bigint;
  servedUnits: bigint;
}

/** The full chat bill: `servedUnits = promptUnits + toolUnits + completionUnits`. */
export function meterChat(
  engine: TokenCountEngine,
  input: {
    messages: readonly ChatMessage[];
    options: ChatToolOptions;
    content: string | null;
    toolCalls?: readonly ChatToolCall[];
    template?: ChatTemplate;
  },
): ChatUnitBreakdown {
  const promptUnits = countChatPromptUnits(engine, input.messages, input.template);
  const toolUnits = countChatToolUnits(engine, input.messages, input.options);
  const completionUnits = countChatCompletionUnits(engine, input.content, input.toolCalls);
  return { promptUnits, toolUnits, completionUnits, servedUnits: promptUnits + toolUnits + completionUnits };
}

/**
 * Strict engine-independent bound on `promptUnits + toolUnits`: UTF-8 bytes in
 * place of `E` (every engine counts ≤ one unit per byte), plus the template
 * constants. Used to size the authorization when no pinned engine is held.
 */
export function chatPromptUpperBound(
  messages: readonly ChatMessage[],
  options: ChatToolOptions,
  template: ChatTemplate = CHAT_TEMPLATE_OPENAI_COUNT_V1,
): bigint {
  let bytes = template.perReplyPrimerTokens;
  for (const m of messages) bytes += utf8Length(m.content) + utf8Length(m.role) + template.perMessageTokens;
  return BigInt(bytes) + BigInt(utf8Length(toolEnvelopeText(messages, options)));
}

/**
 * Bound a delivered completion to at most `maxUnits` as counted by the
 * billing engine (fork `boundCompletion`, verbatim algorithm). The result is
 * a code-point prefix — never a split surrogate pair — found by binary search
 * for the longest prefix whose count fits, so the engine that bills it is the
 * one that bounded it. A cap ≤ 0 delivers nothing.
 */
export function boundCompletion(
  engine: Pick<TokenCountEngine, 'encodeCount'>,
  text: string,
  maxUnits: bigint,
): { text: string; truncated: boolean } {
  const cap = maxUnits <= 0n ? 0 : maxUnits >= BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(maxUnits);
  if (cap === 0) return { text: '', truncated: text.length > 0 };
  if (engine.encodeCount(text) <= cap) return { text, truncated: false };
  const chars = Array.from(text);
  const count = (k: number): number => engine.encodeCount(chars.slice(0, k).join(''));
  let lo = 0;
  let hi = chars.length; // invariant: count(lo) ≤ cap
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (count(mid) <= cap) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 0 && count(lo) > cap) lo--; // BPE counts are not strictly monotonic in prefix length
  return { text: chars.slice(0, lo).join(''), truncated: true };
}
