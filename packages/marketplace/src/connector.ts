// SPDX-License-Identifier: Apache-2.0

/**
 * A seller's backend for a service (OT-RFC-27): an OpenAI-compatible chat
 * completions endpoint, of one of two kinds:
 *   - `openai`, an upstream API. Its key is read, at each call, from the
 *     environment variable the settings name, and is never stored;
 *   - `llamacpp`, local weights behind llama.cpp's server, on loopback only.
 * It returns the text, or the tools the model called, and what the backend
 * counted: input and output tokens. A call with tools sends them, with
 * `tool_choice` and `parallel_tool_calls`; a call without sends what 10.1.0 sent.
 *
 * How the output limit and the temperature are sent is the backend's, per
 * service (`maxTokensField`, `temperature`). OpenAI's own API
 * (api.openai.com) gets `max_completion_tokens` and no temperature, which its
 * reasoning models (GPT-5 and on) need, as they refuse `max_tokens` and any
 * temperature but the default; every other backend `max_tokens` and a
 * temperature of 0, as in 10.1.0. A call with tools also sends the
 * `reasoning_effort` its service names (`reasoningEffortWithTools`), and none
 * by default: some OpenAI reasoning models take function tools on chat
 * completions only with `none`. A backend that refuses a call has its own
 * words for why in the error and the seller's log, cut short, the key never,
 * and the error carries the HTTP status it answered (`UpstreamError.status`).
 */
import { WireError, answerFromWire, type Answer, type ChatMessage, type FinishReason, type ToolChoice, type ToolSpec } from './wire.js';

/**
 * A backend's answer (`Answer`: text, or the tools the model called, with text or none), and what it counted. Its
 * `finishReason` is said when the backend says `length` or `content_filter`; `stop` and `tool_calls` go without saying.
 */
export type Completion = Answer & {
  finishReason?: FinishReason;
  promptTokens: number;
  completionTokens: number;
};

export interface CompletionCall {
  messages: ChatMessage[];
  maxTokens: number;
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
}

export interface Connector {
  readonly kind: 'openai' | 'llamacpp';
  complete(call: CompletionCall): Promise<Completion>;
}

export interface ConnectorSettings {
  kind: 'openai' | 'llamacpp';
  /** The API's base, as OpenAI clients take it, e.g. `http://127.0.0.1:8080/v1`. */
  baseUrl: string;
  /** The backend's own model name. */
  model: string;
  /** The environment variable that holds the upstream's key, if it needs one. */
  apiKeyEnv?: string;
  timeoutMs?: number;
  /** The field the output limit goes in. By default `max_completion_tokens` for api.openai.com, `max_tokens` elsewhere. */
  maxTokensField?: MaxTokensField;
  /** The temperature sent; `null` sends none, for the backend's default. By default none for api.openai.com, 0 elsewhere. */
  temperature?: number | null;
  /**
   * The `reasoning_effort` sent with a call that carries tools, e.g. `none`; by default none is sent, for the model's
   * own. Some OpenAI reasoning models refuse function tools on chat completions at any effort but `none`.
   */
  reasoningEffortWithTools?: string;
}

export type MaxTokensField = 'max_tokens' | 'max_completion_tokens';

export const MAX_TOKENS_FIELDS: readonly MaxTokensField[] = ['max_tokens', 'max_completion_tokens'];

/** OpenAI's own API, whose reasoning models take `max_completion_tokens` and only the default temperature. */
const OPENAI_API_HOST = 'api.openai.com';

/** How a backend is sent a call's output limit and temperature: its settings, or the defaults for its host. */
export function requestShapeOf(settings: Pick<ConnectorSettings, 'baseUrl' | 'maxTokensField' | 'temperature'>): {
  maxTokensField: MaxTokensField;
  temperature: number | null;
} {
  const openai = new URL(settings.baseUrl).hostname.toLowerCase() === OPENAI_API_HOST;
  return {
    maxTokensField: settings.maxTokensField ?? (openai ? 'max_completion_tokens' : 'max_tokens'),
    temperature: settings.temperature !== undefined ? settings.temperature : (openai ? null : 0),
  };
}

/** How long a backend's own words for a refusal may be, in the error and the log. */
const BACKEND_MESSAGE_CHARS = 200;

/**
 * The backend's words for why it refused a call (OpenAI's `error.message`, or a bare `error` text), on one line,
 * cut to `BACKEND_MESSAGE_CHARS`, with the key, anything shaped as an API key and any bearer token taken out.
 * `undefined` when the answer says none.
 */
export function backendMessageOf(body: unknown, key: string | undefined): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  const raw = typeof error === 'string' ? error : (error as { message?: unknown } | undefined)?.message;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  // Control characters become spaces, then every run of space is one: the words on one line.
  const spaced = Array.from(raw, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('');
  let text = spaced.replace(/\s+/g, ' ').trim();
  if (key) text = text.split(key).join('[redacted]');
  text = text.replace(/\bsk-[A-Za-z0-9_*.-]{4,}/g, '[redacted]').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  return text.length > BACKEND_MESSAGE_CHARS ? `${text.slice(0, BACKEND_MESSAGE_CHARS - 1)}…` : text;
}

/**
 * The backend failed or answered without text and token counts: nothing was served. `status` is the HTTP status of
 * a backend that refused the call with one; it is unset when the backend did not answer, or answered with nothing to
 * serve.
 */
export class UpstreamError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Drops trailing slashes in one pass; a regular expression for this is slow on a long run of slashes. */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

export function connectorOf(settings: ConnectorSettings): Connector {
  const base = new URL(settings.baseUrl);
  if (settings.kind === 'llamacpp' && !LOOPBACK.has(base.hostname)) {
    throw new Error(`a llama.cpp backend is served on loopback only, not ${base.hostname}`);
  }
  const endpoint = `${withoutTrailingSlashes(settings.baseUrl)}/chat/completions`;
  const shape = requestShapeOf(settings);
  return {
    kind: settings.kind,
    async complete({ messages, maxTokens, tools, toolChoice, parallelToolCalls }) {
      const key = settings.apiKeyEnv ? process.env[settings.apiKeyEnv] : undefined;
      if (settings.apiKeyEnv && !key) throw new UpstreamError(`${settings.apiKeyEnv} is not set`);
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({
            model: settings.model, messages, [shape.maxTokensField]: maxTokens,
            ...(shape.temperature !== null ? { temperature: shape.temperature } : {}),
            stream: false,
            ...(tools ? {
              tools,
              ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
              ...(parallelToolCalls !== undefined ? { parallel_tool_calls: parallelToolCalls } : {}),
              ...(settings.reasoningEffortWithTools !== undefined ? { reasoning_effort: settings.reasoningEffortWithTools } : {}),
            } : {}),
          }),
          signal: AbortSignal.timeout(settings.timeoutMs ?? 60_000),
        });
      } catch (err) {
        throw new UpstreamError(`the backend did not answer: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        const said = backendMessageOf(await res.json().catch(() => null), key);
        throw new UpstreamError(`the backend answered ${res.status}${said ? `: ${said}` : ''}`, res.status);
      }
      const out = await res.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      } | null;
      const choice = out?.choices?.[0];
      // The answer's text and tool calls as the wire decodes a served result's: one policy for both.
      let answer: Answer;
      try {
        answer = answerFromWire(choice?.message, 'the answer');
      } catch (err) {
        throw new UpstreamError(`the backend answered without text or tool calls: ${err instanceof WireError ? err.message : String(err)}`);
      }
      const promptTokens = out?.usage?.prompt_tokens;
      const completionTokens = out?.usage?.completion_tokens;
      if (!isCount(promptTokens) || !isCount(completionTokens)) throw new UpstreamError('the backend answered without token counts');
      const finishReason = choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter' ? choice.finish_reason : undefined;
      return { ...answer, ...(finishReason ? { finishReason } : {}), promptTokens, completionTokens };
    },
  };
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
