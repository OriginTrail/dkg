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
 */
import { WireError, toolCallsFromWire, type ChatMessage, type FinishReason, type ToolCall, type ToolChoice, type ToolSpec } from './wire.js';

export interface Completion {
  /** The text; `null` when the model only called tools. */
  content: string | null;
  /** The tools the model called, when it called any. */
  toolCalls?: ToolCall[];
  /** Why the backend stopped, when it says `length` or `content_filter`; `stop` and `tool_calls` go without saying. */
  finishReason?: FinishReason;
  promptTokens: number;
  completionTokens: number;
}

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
}

/** The backend failed or answered without text and token counts: nothing was served. */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
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
            model: settings.model, messages, max_tokens: maxTokens, temperature: 0, stream: false,
            ...(tools ? {
              tools,
              ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
              ...(parallelToolCalls !== undefined ? { parallel_tool_calls: parallelToolCalls } : {}),
            } : {}),
          }),
          signal: AbortSignal.timeout(settings.timeoutMs ?? 60_000),
        });
      } catch (err) {
        throw new UpstreamError(`the backend did not answer: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) throw new UpstreamError(`the backend answered ${res.status}`);
      const out = await res.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      } | null;
      const choice = out?.choices?.[0];
      const content = choice?.message?.content;
      const calls = choice?.message?.tool_calls;
      let toolCalls: ToolCall[] | undefined;
      if (calls !== undefined && calls !== null && !(Array.isArray(calls) && calls.length === 0)) {
        try {
          toolCalls = toolCallsFromWire(calls);
        } catch (err) {
          throw new UpstreamError(`the backend answered with tool calls that are not shaped as calls: ${err instanceof WireError ? err.message : String(err)}`);
        }
      }
      const promptTokens = out?.usage?.prompt_tokens;
      const completionTokens = out?.usage?.completion_tokens;
      const answered = typeof content === 'string' || (toolCalls !== undefined && (content === null || content === undefined));
      if (!answered || !isCount(promptTokens) || !isCount(completionTokens)) {
        throw new UpstreamError('the backend answered without text or tool calls and token counts');
      }
      const finishReason = choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter' ? choice.finish_reason : undefined;
      return {
        content: typeof content === 'string' ? content : null,
        ...(toolCalls ? { toolCalls } : {}),
        ...(finishReason ? { finishReason } : {}),
        promptTokens,
        completionTokens,
      };
    },
  };
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
