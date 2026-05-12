// Anthropic provider (Messages API).
import type { LlmConfig } from '../../config.js';
import type { LlmExtractionInput, LlmExtractionOutput } from '../llm-extractor.js';
import { DOCUMENT_KG_PROMPT, type LlmProvider } from '../llm-provider.js';
import { parseNTriples } from '../parse-ntriples.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

async function invoke(input: LlmExtractionInput, config: LlmConfig): Promise<LlmExtractionOutput> {
  const model = config.model ?? DEFAULT_MODEL;
  const baseURL = config.baseURL ?? 'https://api.anthropic.com';
  const empty: LlmExtractionOutput = { triples: [], model };

  if (!config.apiKey) {
    console.warn('[anthropic] missing apiKey — semantic extraction skipped');
    return empty;
  }

  const truncated = input.markdown.length > 60_000
    ? input.markdown.slice(0, 60_000) + '\n\n[... document truncated for extraction ...]'
    : input.markdown;

  const body = {
    model,
    max_tokens: input.maxTokens ?? 4096,
    system: DOCUMENT_KG_PROMPT,
    messages: [{ role: 'user', content: `Document URI: ${input.documentIri}\n\n${truncated}` }],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[anthropic] API returned ${res.status}: ${await res.text().catch(() => '')}`);
      return empty;
    }

    let data: any;
    try { data = await res.json(); }
    catch (err: any) {
      console.warn(`[anthropic] malformed response body: ${err?.message ?? err}`);
      return empty;
    }

    const output = data?.content?.[0]?.text;
    if (typeof output !== 'string') {
      console.warn('[anthropic] malformed response body: content[0].text missing');
      return empty;
    }
    const text = output.trim();
    const tokensUsed = (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0);
    if (!text || text === 'NONE') return { triples: [], model, tokensUsed };
    return { triples: parseNTriples(text, input.documentIri), model, tokensUsed };
  } catch (err: any) {
    console.warn(err?.name === 'AbortError'
      ? '[anthropic] request timed out after 60s'
      : `[anthropic] extraction failed: ${err?.message ?? err}`);
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

export const anthropicProvider: LlmProvider = { name: 'anthropic', defaultModel: DEFAULT_MODEL, invoke };
