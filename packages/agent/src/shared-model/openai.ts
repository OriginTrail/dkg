/**
 * OpenAI-compatible mapping for the shared curator model.
 *
 * Lets a member point any OpenAI-compatible client (the hermes gateway, a
 * node-UI chat, Cursor, the OpenAI SDK, …) at
 *   POST /api/context-graph/:id/model/v1/chat/completions
 * so the member's agent transparently runs ON the curator's shared model,
 * gated by membership + quota. Pure functions so they're unit-testable and
 * keep the daemon route thin.
 */

import type { SharedModelMessage, SharedModelRole } from './types.js';

export interface OpenAIChatMessage {
  role: string;
  content: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

const SHARED_ROLES: SharedModelRole[] = ['system', 'user', 'assistant'];

/**
 * Map an OpenAI `messages[]` array to the shared-model message shape.
 * Unsupported roles (e.g. `tool`, `function`) are coerced to `user` — they're
 * inputs to the model from the caller's perspective. Non-string content is
 * dropped.
 */
export function openAiMessagesToShared(messages: unknown): SharedModelMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: SharedModelMessage[] = [];
  for (const m of messages) {
    const mm = m as Partial<OpenAIChatMessage>;
    if (!mm || typeof mm.content !== 'string') continue;
    const role: SharedModelRole = SHARED_ROLES.includes(mm.role as SharedModelRole)
      ? (mm.role as SharedModelRole)
      : 'user';
    out.push({ role, content: mm.content });
  }
  return out;
}

/** Build an OpenAI `chat.completion` response envelope around a single completion. */
export function buildOpenAIChatCompletion(opts: {
  contextGraphId: string;
  content: string;
  model: string;
  createdSec: number;
}): Record<string, unknown> {
  return {
    id: `chatcmpl-dkg-${opts.contextGraphId.slice(0, 24)}`,
    object: 'chat.completion',
    created: opts.createdSec,
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: opts.content },
        finish_reason: 'stop',
      },
    ],
    // Token accounting isn't available from the mock/upstream call yet; report
    // zeros so OpenAI clients that read `usage` don't choke. (Follow-up.)
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** OpenAI-shaped error body (`{ error: { message, type, code } }`). */
export function openAiErrorBody(message: string, code = 'shared_model_denied'): Record<string, unknown> {
  return { error: { message, type: 'invalid_request_error', code } };
}
