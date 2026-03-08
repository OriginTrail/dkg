export interface LlmConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  systemPrompt?: string;
}

export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmChatMessage {
  role: LlmMessageRole;
  content?: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmChatRequest {
  config: LlmConfig;
  messages: LlmChatMessage[];
  tools?: unknown[];
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface LlmAssistantMessage {
  content?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmCompletionResult {
  mode: 'streaming' | 'blocking';
  message: LlmAssistantMessage;
  raw?: unknown;
}

export type LlmStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_delta'; callId: string; name?: string; argumentsDelta?: string }
  | { type: 'final'; mode: 'streaming' | 'blocking'; message: LlmAssistantMessage }
  | { type: 'error'; error: string };

export interface LlmCapabilities {
  provider: 'openai-compatible';
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsTemperature: boolean;
  supportsMaxTokens: boolean;
}
