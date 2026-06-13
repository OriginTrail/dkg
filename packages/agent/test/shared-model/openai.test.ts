import { describe, it, expect } from 'vitest';
import {
  openAiMessagesToShared,
  buildOpenAIChatCompletion,
  openAiErrorBody,
} from '../../src/shared-model/openai.js';

describe('shared-model OpenAI compatibility', () => {
  it('maps OpenAI messages to shared-model messages, coercing unsupported roles to user', () => {
    const out = openAiMessagesToShared([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool', content: 'tool result' },     // coerced -> user
      { role: 'user', content: 123 as unknown as string }, // dropped (non-string)
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'tool result' },
    ]);
  });

  it('returns [] for non-array / empty input', () => {
    expect(openAiMessagesToShared(undefined)).toEqual([]);
    expect(openAiMessagesToShared('nope')).toEqual([]);
    expect(openAiMessagesToShared([])).toEqual([]);
  });

  it('builds a valid OpenAI chat.completion envelope', () => {
    const env = buildOpenAIChatCompletion({
      contextGraphId: 'demo',
      content: '[shared-model:mock-model] hi',
      model: 'mock-model',
      createdSec: 1700000000,
    }) as any;
    expect(env.object).toBe('chat.completion');
    expect(env.model).toBe('mock-model');
    expect(env.created).toBe(1700000000);
    expect(env.id).toContain('chatcmpl-dkg-demo');
    expect(env.choices[0].message).toEqual({ role: 'assistant', content: '[shared-model:mock-model] hi' });
    expect(env.choices[0].finish_reason).toBe('stop');
    expect(env.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it('builds an OpenAI-shaped error body', () => {
    expect(openAiErrorBody('requester is not a member of this context graph')).toEqual({
      error: {
        message: 'requester is not a member of this context graph',
        type: 'invalid_request_error',
        code: 'shared_model_denied',
      },
    });
  });
});
