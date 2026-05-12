/**
 * Anthropic provider for Layer 2 semantic extraction.
 *
 * Mirrors the OpenAI provider's shape and fail-soft semantics, with the
 * differences required by the Anthropic Messages API:
 *   - URL: ${baseURL}/v1/messages
 *   - Headers: x-api-key, anthropic-version: 2023-06-01, Content-Type
 *   - Body: { model, max_tokens, system, messages: [{role:'user', content}] }
 *     — no temperature field; the request stays minimal.
 *   - Response: data.content[0].text
 *   - Tokens: data.usage.input_tokens + data.usage.output_tokens
 *
 * Fail-soft: missing apiKey / non-2xx / AbortError / malformed body all
 * resolve to `{ triples: [], model }` with a `console.warn('[anthropic] …')`.
 */
import type { LlmConfig } from '../../config.js';
import type { LlmExtractionInput, LlmExtractionOutput } from '../llm-extractor.js';
import { DOCUMENT_KG_PROMPT, type LlmProvider } from '../llm-provider.js';
import { parseNTriples } from '../parse-ntriples.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
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
    console.warn('[anthropic] missing apiKey — semantic extraction skipped');
    return empty;
  }

  const truncated = input.markdown.length > MARKDOWN_TRUNCATE_CHARS
    ? input.markdown.slice(0, MARKDOWN_TRUNCATE_CHARS) + '\n\n[... document truncated for extraction ...]'
    : input.markdown;

  const url = `${baseURL.replace(/\/$/, '')}/v1/messages`;
  const body = {
    model,
    max_tokens: input.maxTokens ?? 4096,
    system: DOCUMENT_KG_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Document URI: ${input.documentIri}\n\n${truncated}`,
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[anthropic] API returned ${res.status}: ${detail}`);
      return empty;
    }

    let data: any;
    try {
      data = await res.json();
    } catch (err: any) {
      console.warn(`[anthropic] malformed response body: ${err?.message ?? err}`);
      return empty;
    }

    const output = data?.content?.[0]?.text;
    if (typeof output !== 'string') {
      console.warn('[anthropic] malformed response body: content[0].text missing');
      return empty;
    }
    const trimmed = output.trim();
    const tokensUsed = (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0);

    if (!trimmed || trimmed === 'NONE') {
      return { triples: [], model, tokensUsed };
    }

    const triples = parseNTriples(trimmed, input.documentIri);
    return { triples, model, tokensUsed };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn('[anthropic] request timed out after 60s');
    } else {
      console.warn(`[anthropic] extraction failed: ${err?.message ?? err}`);
    }
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

export const anthropicProvider: LlmProvider = {
  name: 'anthropic',
  defaultModel: DEFAULT_MODEL,
  invoke,
};
