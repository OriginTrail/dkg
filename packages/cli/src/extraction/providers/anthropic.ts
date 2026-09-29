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
    // Anthropic Messages API responses model `content` as an array of typed
    // blocks. A response may include thinking/tool_use blocks before/between
    // text blocks, and the model can legitimately split output across
    // multiple `{ type: 'text', text: '…' }` entries. Reading only
    // `content[0].text` drops everything past index 0 and treats a leading
    // non-text block as a missing response. Filter to text blocks, join,
    // and return undefined when there are none so the runner emits the
    // "response text missing" warn instead of silently treating empty as
    // legitimate output.
    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
      .map((b) => b.text)
      .join('\n');
    return {
      text: text || undefined,
      tokensUsed: (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0),
    };
  },
};
