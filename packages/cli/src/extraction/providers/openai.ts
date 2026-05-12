// OpenAI provider. Reasoning models (gpt-5*, o1*, o3*, o4*) use
// max_completion_tokens + reasoning_effort; legacy models use max_tokens + temperature.
// All shared scaffolding (timeout, fail-soft, JSON parse, parseNTriples) lives in
// the runner inside `llm-provider.ts`; this file declares only the differences.
import { createProvider, DOCUMENT_KG_PROMPT, type ProviderSpec } from '../llm-provider.js';

const DEFAULT_MODEL = 'gpt-5-nano';
const REASONING_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'] as const;

export function isReasoningModel(model: string): boolean {
  return REASONING_PREFIXES.some((p) => model.startsWith(p));
}

const spec: ProviderSpec = {
  name: 'openai',
  defaultModel: DEFAULT_MODEL,
  buildRequest(input, config, model) {
    const baseURL = config.baseURL ?? 'https://api.openai.com/v1';
    const familyFields = isReasoningModel(model)
      ? { max_completion_tokens: input.maxTokens ?? 16_000, reasoning_effort: 'low' }
      : { max_tokens: input.maxTokens ?? 4096, temperature: 0.1 };

    return {
      url: `${baseURL.replace(/\/$/, '')}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: {
        model,
        messages: [
          { role: 'system', content: DOCUMENT_KG_PROMPT },
          { role: 'user', content: `Document URI: ${input.documentIri}\n\n${input.markdown}` },
        ],
        ...familyFields,
      },
    };
  },
  parseResponse(data) {
    return {
      text: data?.choices?.[0]?.message?.content,
      tokensUsed: data?.usage?.total_tokens,
    };
  },
};

export const openaiProvider = createProvider(spec);
