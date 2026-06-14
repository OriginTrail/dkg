import type { SharedModelMessage, SharedModelProviderConfig } from './types.js';

export interface SharedModelCompletion {
  content: string;
  model: string;
}

export interface SharedModelCompleteOpts {
  maxTokens?: number;
  temperature?: number;
  /**
   * Curator-side deadline (ms) for the upstream provider `fetch`. When the
   * request exceeds this, the call rejects with a clear `provider timeout
   * after <n>ms` Error so the curator returns a structured denial before the
   * member's transport aborts the round trip. Unset = no deadline.
   */
  providerTimeoutMs?: number;
}

/**
 * Minimal chat-completions client. Mirrors the house `fetch` style in
 * `packages/cli/src/vector-store.ts`. Two providers:
 *   - 'mock'              — deterministic, offline, no key (local testing)
 *   - 'openai-compatible' — POST {baseUrl}/chat/completions, Bearer apiKey
 *                           (works with OpenAI, OpenRouter, Together, vLLM, …)
 */
export class SharedModelClient {
  async complete(
    config: SharedModelProviderConfig,
    messages: SharedModelMessage[],
    opts: SharedModelCompleteOpts = {},
  ): Promise<SharedModelCompletion> {
    if (config.provider === 'mock') return this.mockComplete(config, messages);
    return this.openAiCompatibleComplete(config, messages, opts);
  }

  private mockComplete(config: SharedModelProviderConfig, messages: SharedModelMessage[]): SharedModelCompletion {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const echo = (lastUser?.content ?? '').slice(0, 400);
    const model = config.model || 'mock-model';
    return { model, content: `[shared-model:${model}] ${echo}`.trim() };
  }

  private async openAiCompatibleComplete(
    config: SharedModelProviderConfig,
    messages: SharedModelMessage[],
    opts: SharedModelCompleteOpts,
  ): Promise<SharedModelCompletion> {
    const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const body: Record<string, unknown> = { model: config.model || 'gpt-4o-mini', messages };
    if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
    if (opts.temperature != null) body.temperature = opts.temperature;

    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        ...(opts.providerTimeoutMs != null ? { signal: AbortSignal.timeout(opts.providerTimeoutMs) } : {}),
      });
    } catch (err) {
      // AbortSignal.timeout(...) aborts with a TimeoutError; surface it as a
      // clear, deterministic message the caller's catch can relay.
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(`provider timeout after ${opts.providerTimeoutMs}ms`);
      }
      throw err;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`shared-model provider error: ${resp.status} ${resp.statusText} ${text.slice(0, 200)}`);
    }
    const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
    const content = json.choices?.[0]?.message?.content ?? '';
    return { model: json.model ?? (config.model || 'unknown'), content };
  }
}
