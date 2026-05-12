/**
 * OpenAI provider for Layer 2 semantic extraction.
 *
 * Byte-equivalent to the original inline implementation in llm-extractor.ts:
 *   - URL: ${baseURL}/chat/completions
 *   - Auth: Bearer ${apiKey}
 *   - Body: { model, messages: [system, user], max_tokens, temperature: 0.1 }
 *   - Response: data.choices[0].message.content
 *   - Tokens: data.usage.total_tokens
 *
 * Fail-soft: missing apiKey / non-2xx / AbortError / malformed body all
 * resolve to `{ triples: [], model }` with a `console.warn('[openai] …')`.
 */
import type { LlmConfig } from '../../config.js';
import type { LlmExtractionInput, LlmExtractionOutput } from '../llm-extractor.js';
import { DOCUMENT_KG_PROMPT, type LlmProvider } from '../llm-provider.js';
import { parseNTriples } from '../parse-ntriples.js';

const DEFAULT_MODEL = 'gpt-5-nano';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 60_000;
const MARKDOWN_TRUNCATE_CHARS = 60_000;

async function invoke(
  input: LlmExtractionInput,
  config: LlmConfig,
): Promise<LlmExtractionOutput> {
  const model = config.model ?? DEFAULT_MODEL;
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL;
  const empty: LlmExtractionOutput = { triples: [], model };

  if (!config.apiKey) {
    console.warn('[openai] missing apiKey — semantic extraction skipped');
    return empty;
  }

  const truncated = input.markdown.length > MARKDOWN_TRUNCATE_CHARS
    ? input.markdown.slice(0, MARKDOWN_TRUNCATE_CHARS) + '\n\n[... document truncated for extraction ...]'
    : input.markdown;

  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: DOCUMENT_KG_PROMPT },
      {
        role: 'user',
        content: `Document URI: ${input.documentIri}\n\n${truncated}`,
      },
    ],
    max_tokens: input.maxTokens ?? 4096,
    temperature: 0.1,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[openai] API returned ${res.status}: ${detail}`);
      return empty;
    }

    let data: any;
    try {
      data = await res.json();
    } catch (err: any) {
      console.warn(`[openai] malformed response body: ${err?.message ?? err}`);
      return empty;
    }

    const output = data?.choices?.[0]?.message?.content;
    if (typeof output !== 'string') {
      console.warn('[openai] malformed response body: choices[0].message.content missing');
      return empty;
    }
    const trimmed = output.trim();
    const tokensUsed = data?.usage?.total_tokens;

    if (!trimmed || trimmed === 'NONE') {
      return { triples: [], model, tokensUsed };
    }

    const triples = parseNTriples(trimmed, input.documentIri);
    return { triples, model, tokensUsed };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn('[openai] request timed out after 60s');
    } else {
      console.warn(`[openai] extraction failed: ${err?.message ?? err}`);
    }
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

export const openaiProvider: LlmProvider = {
  name: 'openai',
  defaultModel: DEFAULT_MODEL,
  invoke,
};
