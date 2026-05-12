// OpenAI provider. Reasoning models (gpt-5*, o1*, o3*, o4*) use
// max_completion_tokens + reasoning_effort; legacy models use max_tokens + temperature.
import type { LlmConfig } from '../../config.js';
import type { LlmExtractionInput, LlmExtractionOutput } from '../llm-extractor.js';
import { DOCUMENT_KG_PROMPT, type LlmProvider } from '../llm-provider.js';
import { parseNTriples } from '../parse-ntriples.js';

const DEFAULT_MODEL = 'gpt-5-nano';
const REASONING_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'] as const;

export function isReasoningModel(model: string): boolean {
  return REASONING_PREFIXES.some((p) => model.startsWith(p));
}

async function invoke(input: LlmExtractionInput, config: LlmConfig): Promise<LlmExtractionOutput> {
  const model = config.model ?? DEFAULT_MODEL;
  const baseURL = config.baseURL ?? 'https://api.openai.com/v1';
  const empty: LlmExtractionOutput = { triples: [], model };

  if (!config.apiKey) {
    console.warn('[openai] missing apiKey — semantic extraction skipped');
    return empty;
  }

  const truncated = input.markdown.length > 60_000
    ? input.markdown.slice(0, 60_000) + '\n\n[... document truncated for extraction ...]'
    : input.markdown;

  const familyFields = isReasoningModel(model)
    ? { max_completion_tokens: input.maxTokens ?? 16_000, reasoning_effort: 'low' }
    : { max_tokens: input.maxTokens ?? 4096, temperature: 0.1 };

  const body = {
    model,
    messages: [
      { role: 'system', content: DOCUMENT_KG_PROMPT },
      { role: 'user', content: `Document URI: ${input.documentIri}\n\n${truncated}` },
    ],
    ...familyFields,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[openai] API returned ${res.status}: ${await res.text().catch(() => '')}`);
      return empty;
    }

    let data: any;
    try { data = await res.json(); }
    catch (err: any) {
      console.warn(`[openai] malformed response body: ${err?.message ?? err}`);
      return empty;
    }

    const output = data?.choices?.[0]?.message?.content;
    if (typeof output !== 'string') {
      console.warn('[openai] malformed response body: choices[0].message.content missing');
      return empty;
    }
    const text = output.trim();
    const tokensUsed = data?.usage?.total_tokens;
    if (!text || text === 'NONE') return { triples: [], model, tokensUsed };
    return { triples: parseNTriples(text, input.documentIri), model, tokensUsed };
  } catch (err: any) {
    console.warn(err?.name === 'AbortError'
      ? '[openai] request timed out after 60s'
      : `[openai] extraction failed: ${err?.message ?? err}`);
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

export const openaiProvider: LlmProvider = { name: 'openai', defaultModel: DEFAULT_MODEL, invoke };
