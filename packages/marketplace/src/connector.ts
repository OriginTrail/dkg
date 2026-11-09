// SPDX-License-Identifier: Apache-2.0

/**
 * A seller's backend for a service (OT-RFC-27): an OpenAI-compatible chat
 * completions endpoint, of one of two kinds:
 *   - `openai`, an upstream API. Its key is read, at each call, from the
 *     environment variable the settings name, and is never stored;
 *   - `llamacpp`, local weights behind llama.cpp's server, on loopback only.
 * It returns the text and what the backend counted: input and output tokens.
 * A call ends at its settings' timeout, or sooner when the caller's `signal`
 * aborts it, as the seller's does at the request's expiry.
 */
import type { ChatMessage } from './wire.js';

export interface Completion {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

export interface Connector {
  readonly kind: 'openai' | 'llamacpp';
  complete(call: { messages: ChatMessage[]; maxTokens: number; signal?: AbortSignal }): Promise<Completion>;
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
    async complete({ messages, maxTokens, signal }) {
      const key = settings.apiKeyEnv ? process.env[settings.apiKeyEnv] : undefined;
      if (settings.apiKeyEnv && !key) throw new UpstreamError(`${settings.apiKeyEnv} is not set`);
      const timeout = AbortSignal.timeout(settings.timeoutMs ?? 60_000);
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: settings.model, messages, max_tokens: maxTokens, temperature: 0, stream: false }),
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch (err) {
        throw new UpstreamError(`the backend did not answer: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) throw new UpstreamError(`the backend answered ${res.status}`);
      const out = await res.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      } | null;
      const content = out?.choices?.[0]?.message?.content;
      const promptTokens = out?.usage?.prompt_tokens;
      const completionTokens = out?.usage?.completion_tokens;
      if (typeof content !== 'string' || !isCount(promptTokens) || !isCount(completionTokens)) {
        throw new UpstreamError('the backend answered without text and token counts');
      }
      return { content, promptTokens, completionTokens };
    },
  };
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
