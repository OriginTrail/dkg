import { resolveCapabilities } from './capability-resolver.js';
import { OpenAICompatibleAdapter } from './provider-adapter.js';
import type { LlmCapabilities, LlmChatRequest, LlmCompletionResult, LlmConfig, LlmStreamEvent } from './types.js';

export class LlmRequestError extends Error {
  readonly status?: number;
  readonly provider: string;
  readonly model?: string;

  constructor(message: string, opts: { status?: number; provider: string; model?: string }) {
    super(message);
    this.name = 'LlmRequestError';
    this.status = opts.status;
    this.provider = opts.provider;
    this.model = opts.model;
  }
}

export interface LlmClientOptions {
  config: LlmConfig;
  request: Omit<LlmChatRequest, 'config'>;
}

export class LlmClient {
  private readonly adapter = new OpenAICompatibleAdapter();

  resolveCapabilities(config: LlmConfig): LlmCapabilities {
    return resolveCapabilities(config);
  }

  private async postCompletion(config: LlmConfig, request: Omit<LlmChatRequest, 'config'>, caps: LlmCapabilities): Promise<Response> {
    const baseURL = config.baseURL || 'https://api.openai.com/v1';
    const url = this.adapter.endpoint(baseURL);
    const body = this.adapter.buildRequestPayload({ config, ...request }, caps);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const raw = await res.text();
      throw new LlmRequestError(
        this.adapter.normalizeError(res.status, raw),
        { status: res.status, provider: caps.provider, model: config.model },
      );
    }
    return res;
  }

  async complete(opts: LlmClientOptions): Promise<LlmCompletionResult> {
    const caps = this.resolveCapabilities(opts.config);
    const useStreaming = opts.request.stream === true && caps.supportsStreaming;

    if (useStreaming) {
      const events = this.stream(opts);
      let finalResult: LlmCompletionResult | undefined;
      for await (const event of events) {
        if (event.type === 'final') {
          finalResult = {
            mode: event.mode,
            message: event.message,
          };
        }
      }
      if (!finalResult) throw new Error('Streaming completion ended without a final message');
      return finalResult;
    }

    const res = await this.postCompletion(opts.config, { ...opts.request, stream: false }, caps);
    const data = await res.json();
    const message = this.adapter.parseBlockingResponse(data);
    return { mode: 'blocking', message, raw: data };
  }

  async *stream(opts: LlmClientOptions): AsyncGenerator<LlmStreamEvent, void, void> {
    const caps = this.resolveCapabilities(opts.config);
    const useStreaming = opts.request.stream === true && caps.supportsStreaming;

    if (!useStreaming) {
      const completion = await this.complete({
        config: opts.config,
        request: { ...opts.request, stream: false },
      });
      if (completion.message.content) {
        yield { type: 'text_delta', delta: completion.message.content };
      }
      if (completion.message.tool_calls) {
        for (const tc of completion.message.tool_calls) {
          yield {
            type: 'tool_call_delta',
            callId: tc.id,
            name: tc.function.name,
            argumentsDelta: tc.function.arguments,
          };
        }
      }
      yield { type: 'final', mode: 'blocking', message: completion.message };
      return;
    }

    const res = await this.postCompletion(opts.config, opts.request, caps);
    for await (const event of this.adapter.streamEvents(res)) {
      yield event;
    }
  }
}
