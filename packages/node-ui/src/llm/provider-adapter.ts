import type {
  LlmAssistantMessage,
  LlmCapabilities,
  LlmChatRequest,
  LlmCompletionResult,
  LlmStreamEvent,
  LlmToolCall,
} from './types.js';

interface OpenAIMessage {
  content?: string;
  tool_calls?: Array<{
    id?: string;
    index?: number;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIChoice {
  message?: OpenAIMessage;
  delta?: OpenAIMessage;
}

interface OpenAIResponseShape {
  choices?: OpenAIChoice[];
}

function normalizeToolCalls(raw: OpenAIMessage['tool_calls']): LlmToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const normalized = raw
    .map((tc, idx) => ({
      id: tc.id ?? `call_${idx}`,
      type: 'function' as const,
      function: {
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '',
      },
    }))
    .filter(tc => tc.function.name);
  return normalized.length > 0 ? normalized : undefined;
}

export interface LlmProviderAdapter {
  endpoint(baseURL: string): string;
  buildRequestPayload(request: LlmChatRequest, caps: LlmCapabilities): Record<string, unknown>;
  parseBlockingResponse(responseBody: unknown): LlmAssistantMessage;
  streamEvents(response: Response): AsyncGenerator<LlmStreamEvent, LlmCompletionResult, void>;
  normalizeError(status: number, rawText: string): string;
}

export class OpenAICompatibleAdapter implements LlmProviderAdapter {
  endpoint(baseURL: string): string {
    return `${baseURL.replace(/\/$/, '')}/chat/completions`;
  }

  buildRequestPayload(request: LlmChatRequest, caps: LlmCapabilities): Record<string, unknown> {
    const model = request.config.model || 'gpt-4o-mini';
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
    };
    if (request.tools && request.tools.length > 0 && caps.supportsTools) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    if (request.maxTokens != null && caps.supportsMaxTokens) body.max_tokens = request.maxTokens;
    if (request.temperature != null && caps.supportsTemperature) body.temperature = request.temperature;
    if (request.stream === true && caps.supportsStreaming) body.stream = true;
    return body;
  }

  parseBlockingResponse(responseBody: unknown): LlmAssistantMessage {
    const data = responseBody as OpenAIResponseShape;
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Empty LLM response');
    return {
      content: msg.content ?? undefined,
      tool_calls: normalizeToolCalls(msg.tool_calls),
    };
  }

  async *streamEvents(response: Response): AsyncGenerator<LlmStreamEvent, LlmCompletionResult, void> {
    if (!response.body) {
      const text = await response.text();
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
      const message = this.parseBlockingResponse(parsed);
      if (message.content) yield { type: 'text_delta', delta: message.content };
      if (message.tool_calls) {
        for (const tc of message.tool_calls) {
          yield {
            type: 'tool_call_delta',
            callId: tc.id,
            name: tc.function.name,
            argumentsDelta: tc.function.arguments,
          };
        }
      }
      yield { type: 'final', mode: 'blocking', message };
      return { mode: 'blocking', message, raw: parsed };
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let content = '';
    let sawSseFrame = false;
    const toolAccumulator = new Map<number, { id: string; name: string; arguments: string }>();

    const parseDataLine = (dataLine: string): LlmStreamEvent[] => {
      const events: LlmStreamEvent[] = [];
      const data = dataLine.trim();
      if (!data || data === '[DONE]') return events;
      let parsed: OpenAIResponseShape;
      try {
        parsed = JSON.parse(data) as OpenAIResponseShape;
      } catch {
        return events;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) return events;

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        events.push({ type: 'text_delta', delta: delta.content });
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of toolCalls) {
        const idx = tc.index ?? 0;
        const existing = toolAccumulator.get(idx) ?? {
          id: tc.id ?? `call_${idx}`,
          name: '',
          arguments: '',
        };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') {
          existing.arguments += tc.function.arguments;
          events.push({
            type: 'tool_call_delta',
            callId: existing.id,
            name: existing.name || undefined,
            argumentsDelta: tc.function.arguments,
          });
        }
        toolAccumulator.set(idx, existing);
      }
      return events;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let lineEnd = buffer.indexOf('\n');
      while (lineEnd !== -1) {
        const rawLine = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf('\n');
        if (!rawLine.startsWith('data:')) continue;
        sawSseFrame = true;
        const dataLine = rawLine.slice(5);
        const events = parseDataLine(dataLine);
        for (const ev of events) yield ev;
      }
    }

    const flushed = decoder.decode();
    if (flushed) buffer += flushed;
    if (buffer.trim().startsWith('data:')) {
      sawSseFrame = true;
      const dataLine = buffer.trim().slice(5);
      const events = parseDataLine(dataLine);
      for (const ev of events) yield ev;
    }

    if (!sawSseFrame && buffer.trim()) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(buffer.trim());
      } catch {
        parsed = {};
      }
      const message = this.parseBlockingResponse(parsed);
      if (message.content) yield { type: 'text_delta', delta: message.content };
      if (message.tool_calls) {
        for (const tc of message.tool_calls) {
          yield {
            type: 'tool_call_delta',
            callId: tc.id,
            name: tc.function.name,
            argumentsDelta: tc.function.arguments,
          };
        }
      }
      yield { type: 'final', mode: 'blocking', message };
      return { mode: 'blocking', message, raw: parsed };
    }

    const toolCalls: LlmToolCall[] = Array.from(toolAccumulator.values())
      .filter(tc => tc.name)
      .map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

    const message: LlmAssistantMessage = {
      content: content || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    yield { type: 'final', mode: 'streaming', message };
    return { mode: 'streaming', message };
  }

  normalizeError(status: number, rawText: string): string {
    const snippet = rawText.slice(0, 300);
    return `LLM API ${status}: ${snippet}`;
  }
}
