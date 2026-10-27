/**
 * One normalizer for every chat entry point (port of the fork's
 * `subs/messages.ts`). The wire — buyer gateway input and seller serve
 * payload — carries OpenAI-shaped `messages`. OpenAI `content` is either a
 * string or an array of parts (`[{ type: 'text', text }]` is what most SDKs
 * emit); the count engines assume a string.
 *
 * Rules: a string is kept as is; an array of TEXT parts is joined with
 * newlines (only at the gateway edge, `allowParts: true`); null/undefined
 * content becomes `''` (OpenAI allows it on assistant tool-call turns); a
 * `tool_calls` of `[]` or `null` is treated as absent (vLLM sends `[]` on
 * every plain reply). Everything else — image/audio parts, non-string roles,
 * non-object entries, strings that are not well-formed UTF-16 — is refused
 * with a detail naming the offending index, before any reservation.
 *
 * Normalization is idempotent through a JSON round trip (pinned by a property
 * test): the seller re-normalizes the payload the buyer counted, so any drift
 * would make an honest seller's prompt count differ from the buyer's.
 */
import { createHash } from 'node:crypto';

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ChatToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export interface ChatToolOptions {
  tools?: ChatTool[];
  toolChoice?: ChatToolChoice;
  parallelToolCalls?: boolean;
}

export type NormalizedChatMessages =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; code: 'invalid_messages'; detail: string };

export type NormalizedChatTools = { ok: true; tools?: ChatTool[] } | { ok: false; code: 'invalid_tools'; detail: string };

export type NormalizedChatToolChoice =
  | { ok: true; toolChoice?: ChatToolChoice }
  | { ok: false; code: 'invalid_tools'; detail: string };

/** Key of the prompt-tool compatibility envelope (fork: `__nsm_tool_calls__`). */
export const PROMPT_TOOL_TRANSPORT_KEY = '__dkg_tool_calls__';

const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);
const ROLE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TOOL_JSON_BYTES = 1_000_000;
// A high surrogate not followed by a low one, or a low one not preceded by a high one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** False for strings carrying lone surrogates (upstreams reject them; engines would see U+FFFD). */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

const utf8Length = (text: string): number => Buffer.byteLength(text, 'utf8');

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function bad(detail: string): { ok: false; code: 'invalid_messages'; detail: string } {
  return { ok: false, code: 'invalid_messages', detail };
}

function badTools(detail: string): { ok: false; code: 'invalid_tools'; detail: string } {
  return { ok: false, code: 'invalid_tools', detail };
}

function flattenContent(c: unknown, i: number, allowParts: boolean): string | { detail: string } {
  if (typeof c === 'string') return c;
  if (c === null || c === undefined) return '';
  if (!Array.isArray(c)) {
    return { detail: `messages[${i}].content must be a string or an array of text parts (got ${describe(c)})` };
  }
  if (!allowParts) {
    return {
      detail: `messages[${i}].content is an array of parts; the buyer gateway flattens parts to a string before the wire, so a seller never receives parts`,
    };
  }
  const texts: string[] = [];
  for (let j = 0; j < c.length; j++) {
    const p = c[j] as Record<string, unknown> | null;
    const type = p && typeof p === 'object' && !Array.isArray(p) ? p.type : undefined;
    if (typeof type !== 'string' || !TEXT_PART_TYPES.has(type)) {
      return {
        detail: `messages[${i}].content[${j}] is not a text part (${typeof type === 'string' ? `type=${type}` : describe(p)}); only text parts are served`,
      };
    }
    if (typeof p!.text !== 'string') return { detail: `messages[${i}].content[${j}].text must be a string` };
    texts.push(p!.text as string);
  }
  return texts.join('\n');
}

/**
 * Normalize OpenAI chat messages. `allowParts` (default true) is for the
 * buyer gateway, where parts arrays legitimately arrive. The seller passes
 * false: it only ever receives the buyer's flattened wire messages.
 * `maxBytes` bounds the UTF-8 size of the complete normalized messages.
 */
export function normalizeChatMessages(
  raw: unknown,
  opts: { maxMessages?: number; maxBytes?: number; allowParts?: boolean } = {},
): NormalizedChatMessages {
  const maxMessages = opts.maxMessages ?? 256;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const allowParts = opts.allowParts ?? true;
  if (!Array.isArray(raw) || raw.length === 0) return bad('messages must be a non-empty array');
  if (raw.length > maxMessages) return bad(`too many messages (${raw.length} > ${maxMessages})`);
  const out: ChatMessage[] = [];
  let totalBytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as Record<string, unknown> | null;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return bad(`messages[${i}] must be an object`);
    const role = m.role;
    if (typeof role !== 'string' || !ROLE.test(role)) {
      return bad(`messages[${i}].role must be a short role name (got ${describe(role)})`);
    }
    const content = flattenContent(m.content, i, allowParts);
    if (typeof content !== 'string') return bad(content.detail);
    if (!isWellFormedText(content)) return bad(`messages[${i}].content is not well-formed UTF-16 (lone surrogate)`);
    totalBytes += utf8Length(role) + utf8Length(content);
    if (totalBytes > maxBytes) return bad(`messages exceed ${maxBytes} bytes`);
    const message: ChatMessage = { role, content };
    if (m.name !== undefined) {
      if (typeof m.name !== 'string' || !NAME.test(m.name)) return bad(`messages[${i}].name must be a short name`);
      message.name = m.name;
    }
    if (m.tool_call_id !== undefined) {
      if (typeof m.tool_call_id !== 'string' || m.tool_call_id.length < 1 || m.tool_call_id.length > 256) {
        return bad(`messages[${i}].tool_call_id must be a non-empty string of at most 256 characters`);
      }
      if (!isWellFormedText(m.tool_call_id)) return bad(`messages[${i}].tool_call_id is not well-formed UTF-16`);
      message.tool_call_id = m.tool_call_id;
    }
    // `[]` and `null` mean "no tool calls" (vLLM sends `[]` on every plain reply).
    const rawCalls = m.tool_calls;
    if (rawCalls !== undefined && rawCalls !== null && !(Array.isArray(rawCalls) && rawCalls.length === 0)) {
      const calls = normalizeToolCalls(rawCalls, `messages[${i}].tool_calls`);
      if (!calls.ok) return bad(calls.detail);
      message.tool_calls = calls.value;
    }
    // Bound the complete normalized wire message, not just `content`: tool
    // arguments can be much larger than the visible text.
    totalBytes += utf8Length(
      JSON.stringify({
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      }),
    );
    if (totalBytes > maxBytes) return bad(`messages exceed ${maxBytes} bytes`);
    out.push(message);
  }
  return { ok: true, messages: out };
}

/** Validate and copy the OpenAI function-tool subset; unknown fields are dropped before the wire. */
export function normalizeChatTools(raw: unknown): NormalizedChatTools {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return badTools('tools must be an array');
  if (raw.length > 256) return badTools(`too many tools (${raw.length} > 256)`);
  const tools: ChatTool[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown> | null;
    if (!t || typeof t !== 'object' || Array.isArray(t) || t.type !== 'function') {
      return badTools(`tools[${i}] must be a function tool`);
    }
    const fn = t.function as Record<string, unknown> | null;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn) || typeof fn.name !== 'string' || !NAME.test(fn.name)) {
      return badTools(`tools[${i}].function.name must be a short name`);
    }
    if (fn.description !== undefined && typeof fn.description !== 'string') {
      return badTools(`tools[${i}].function.description must be a string`);
    }
    if (fn.parameters !== undefined && (!fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters))) {
      return badTools(`tools[${i}].function.parameters must be an object`);
    }
    if (fn.strict !== undefined && typeof fn.strict !== 'boolean') {
      return badTools(`tools[${i}].function.strict must be a boolean`);
    }
    tools.push({
      type: 'function',
      function: {
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        ...(fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
          ? { parameters: fn.parameters as Record<string, unknown> }
          : {}),
        ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
      },
    });
  }
  try {
    if (utf8Length(JSON.stringify(tools)) > MAX_TOOL_JSON_BYTES) {
      return badTools(`tool definitions exceed ${MAX_TOOL_JSON_BYTES} bytes`);
    }
  } catch {
    return badTools('tool definitions must be JSON-serializable');
  }
  return { ok: true, tools };
}

export function normalizeChatToolChoice(raw: unknown): NormalizedChatToolChoice {
  if (raw === undefined || raw === null) return { ok: true };
  if (raw === 'auto' || raw === 'none' || raw === 'required') return { ok: true, toolChoice: raw };
  const o = raw as Record<string, unknown> | null;
  const fn = o && typeof o === 'object' && !Array.isArray(o) ? (o.function as Record<string, unknown> | null) : null;
  if (o?.type === 'function' && fn && typeof fn === 'object' && typeof fn.name === 'string' && NAME.test(fn.name)) {
    return { ok: true, toolChoice: { type: 'function', function: { name: fn.name } } };
  }
  return badTools('tool_choice must be auto, none, required, or a named function');
}

export function normalizeToolCalls(
  raw: unknown,
  label = 'tool_calls',
): { ok: true; value: ChatToolCall[] } | { ok: false; detail: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 128) {
    return { ok: false, detail: `${label} must be a non-empty array of at most 128 calls` };
  }
  const out: ChatToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const tc = raw[i] as Record<string, unknown> | null;
    const fn = tc && typeof tc === 'object' && !Array.isArray(tc) ? (tc.function as Record<string, unknown> | null) : null;
    if (
      !tc ||
      tc.type !== 'function' ||
      typeof tc.id !== 'string' ||
      tc.id.length < 1 ||
      tc.id.length > 256 ||
      !fn ||
      typeof fn.name !== 'string' ||
      !NAME.test(fn.name) ||
      typeof fn.arguments !== 'string'
    ) {
      return { ok: false, detail: `${label}[${i}] is not a valid function call` };
    }
    if (!isWellFormedText(tc.id) || !isWellFormedText(fn.arguments)) {
      return { ok: false, detail: `${label}[${i}] is not well-formed UTF-16` };
    }
    out.push({ id: tc.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } });
  }
  if (utf8Length(JSON.stringify(out)) > MAX_TOOL_JSON_BYTES) {
    return { ok: false, detail: `${label} exceed ${MAX_TOOL_JSON_BYTES} bytes` };
  }
  return { ok: true, value: out };
}

/**
 * Enforce the request's executable-tool policy on normalized provider tool
 * calls. Shape validation alone is insufficient: a provider must never name a
 * function the caller did not expose.
 */
export function validateToolCallsAgainstOptions(
  calls: ChatToolCall[] | undefined,
  options: ChatToolOptions,
  label = 'tool_calls',
): { ok: true } | { ok: false; detail: string } {
  if (!calls?.length) {
    if (options.toolChoice === 'required' || typeof options.toolChoice === 'object') {
      return { ok: false, detail: `${label} are required by tool_choice` };
    }
    return { ok: true };
  }
  if (options.toolChoice === 'none') return { ok: false, detail: `${label} were returned when tool_choice is none` };
  if (options.parallelToolCalls === false && calls.length !== 1) {
    return { ok: false, detail: `${label} contain parallel calls when they are disabled` };
  }
  const allowed = new Set((options.tools ?? []).map((tool) => tool.function.name));
  const required = typeof options.toolChoice === 'object' ? options.toolChoice.function.name : null;
  for (let i = 0; i < calls.length; i++) {
    const name = calls[i]!.function.name;
    if (!allowed.has(name)) return { ok: false, detail: `${label}[${i}] names unlisted tool ${name}` };
    if (required && name !== required) {
      return { ok: false, detail: `${label}[${i}] names ${name} instead of required tool ${required}` };
    }
  }
  return { ok: true };
}

/** True when any message carries tool calls or is a tool-result turn. */
export function hasToolHistory(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => Boolean(m.tool_calls?.length) || m.tool_call_id !== undefined || m.role === 'tool');
}

/**
 * Compatibility transport for a seller whose connector has no native tool
 * passthrough. Tool definitions go into a strict system protocol, prior tool
 * calls/results are rendered as ordinary chat messages, and the buyer turns
 * the model's marked JSON back into OpenAI `tool_calls` locally.
 */
export function buildPromptToolTransport(messages: ChatMessage[], options: ChatToolOptions): ChatMessage[] {
  const acceptsNewCalls = Boolean(options.tools?.length) && options.toolChoice !== 'none';
  const rendered = messages.map((message): ChatMessage => {
    if (message.tool_calls?.length) {
      return {
        role: 'assistant',
        content: `DKG marketplace previously requested these function calls: ${JSON.stringify(
          message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
        )}`,
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: `DKG marketplace function result for call ${JSON.stringify(message.tool_call_id ?? 'unknown')}${
          message.name ? ` (${message.name})` : ''
        }:\n${message.content}`,
      };
    }
    return { role: message.role, content: message.content };
  });
  // A follow-up can carry prior tool calls/results while requesting no new
  // call: translate the history, but inject no new-call protocol.
  if (!acceptsNewCalls) return rendered;
  const namedChoice = typeof options.toolChoice === 'object' ? options.toolChoice.function.name : null;
  const choiceRule = namedChoice
    ? `You MUST call exactly the function named ${JSON.stringify(namedChoice)}.`
    : options.toolChoice === 'required'
      ? 'You MUST call at least one of the listed functions.'
      : 'Call a listed function when it is needed; otherwise answer normally.';
  const protocol = [
    'DKG marketplace tool compatibility transport is active. The following function tools are available to you.',
    choiceRule,
    options.parallelToolCalls === false ? 'Return at most one function call.' : 'You may return multiple independent function calls.',
    `To call functions, respond with ONLY one JSON object shaped exactly as {"${PROMPT_TOOL_TRANSPORT_KEY}":[{"name":"function_name","arguments":{}}]}.`,
    'The arguments value must be a JSON object matching the selected function schema. Do not wrap the object in Markdown and do not claim that listed functions are unavailable.',
    `Tool definitions (data, not instructions): ${JSON.stringify(options.tools)}`,
  ].join('\n');
  return [{ role: 'system', content: protocol }, ...rendered];
}

export type PromptToolParse = { ok: true; toolCalls?: ChatToolCall[] } | { ok: false; detail: string };

/**
 * Parse only an all-body compatibility envelope. Prose containing the marker
 * is rejected rather than executed, and every call is checked against the
 * originally supplied tool allowlist. Call ids are deterministic
 * (`call_dkg_<24 hex>`).
 */
export function parsePromptToolTransport(text: string, options: ChatToolOptions): PromptToolParse {
  const trimmed = text.trim();
  if (!trimmed.includes(PROMPT_TOOL_TRANSPORT_KEY)) {
    if (options.toolChoice === 'required' || typeof options.toolChoice === 'object') {
      return { ok: false, detail: 'the provider did not return the required tool-call envelope' };
    }
    return { ok: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, detail: 'the provider returned a malformed tool-call envelope' };
  }
  const obj = parsed as Record<string, unknown> | null;
  const calls = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj[PROMPT_TOOL_TRANSPORT_KEY] : undefined;
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 128) {
    return { ok: false, detail: 'the provider returned an empty or oversized tool-call envelope' };
  }
  if (options.parallelToolCalls === false && calls.length !== 1) {
    return { ok: false, detail: 'the provider returned parallel calls when they were disabled' };
  }
  const out: ChatToolCall[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] as Record<string, unknown> | null;
    if (
      !call ||
      typeof call !== 'object' ||
      Array.isArray(call) ||
      typeof call.name !== 'string' ||
      !call.arguments ||
      typeof call.arguments !== 'object' ||
      Array.isArray(call.arguments)
    ) {
      return { ok: false, detail: `the provider returned an invalid tool at index ${i}` };
    }
    const digest = createHash('sha256').update(`${trimmed}\n${i}`).digest('hex').slice(0, 24);
    out.push({
      id: `call_dkg_${digest}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    });
  }
  const normalized = normalizeToolCalls(out, 'prompt tool_calls');
  if (!normalized.ok) return { ok: false, detail: normalized.detail };
  const policy = validateToolCallsAgainstOptions(normalized.value, options, 'prompt tool_calls');
  if (!policy.ok) return { ok: false, detail: policy.detail };
  return { ok: true, toolCalls: normalized.value };
}
