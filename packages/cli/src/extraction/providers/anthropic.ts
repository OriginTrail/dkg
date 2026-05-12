// Anthropic provider (Messages API).
import { DOCUMENT_KG_PROMPT, type LlmProvider } from '../llm-provider.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

export const anthropicProvider: LlmProvider = {
  name: 'anthropic',
  defaultModel: DEFAULT_MODEL,

  buildRequest(input, config, model) {
    const baseURL = config.baseURL ?? 'https://api.anthropic.com';
    return {
      url: `${baseURL.replace(/\/$/, '')}/v1/messages`,
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: {
        model,
        max_tokens: input.maxTokens ?? 4096,
        system: DOCUMENT_KG_PROMPT,
        messages: [
          { role: 'user', content: `Document URI: ${input.documentIri}\n\n${input.markdown}` },
        ],
      },
    };
  },

  parseResponse(data: any) {
    return {
      text: data?.content?.[0]?.text,
      tokensUsed: (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0),
    };
  },
};
