// Pluggable LLM provider for Layer 2 semantic extraction.
import type { LlmConfig } from '../config.js';
import type { LlmExtractionInput, LlmExtractionOutput } from './llm-extractor.js';
import { parseNTriples } from './parse-ntriples.js';

export interface LlmProvider {
  readonly name: 'openai' | 'anthropic';
  readonly defaultModel: string;
  invoke(input: LlmExtractionInput, config: LlmConfig): Promise<LlmExtractionOutput>;
}

/**
 * Per-provider differences in the shared request/response scaffolding.
 * Everything else (apiKey check, 60s timeout, fail-soft, JSON parse,
 * NONE/empty handling, parseNTriples) is centralised in `runProvider`.
 */
export interface ProviderSpec {
  readonly name: 'openai' | 'anthropic';
  readonly defaultModel: string;
  buildRequest(
    input: LlmExtractionInput,
    config: LlmConfig,
    model: string,
  ): { url: string; headers: Record<string, string>; body: unknown };
  parseResponse(data: any): {
    text: string | undefined;
    tokensUsed: number | undefined;
  };
}

export function createProvider(spec: ProviderSpec): LlmProvider {
  return {
    name: spec.name,
    defaultModel: spec.defaultModel,
    invoke: (input, config) => runProvider(spec, input, config),
  };
}

async function runProvider(
  spec: ProviderSpec,
  input: LlmExtractionInput,
  config: LlmConfig,
): Promise<LlmExtractionOutput> {
  const model = config.model ?? spec.defaultModel;
  const empty: LlmExtractionOutput = { triples: [], model };

  if (!config.apiKey) {
    console.warn(`[${spec.name}] missing apiKey — semantic extraction skipped`);
    return empty;
  }

  const { url, headers, body } = spec.buildRequest(input, config, model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(
        `[${spec.name}] API returned ${res.status}: ${await res.text().catch(() => '')}`,
      );
      return empty;
    }

    let data: any;
    try {
      data = await res.json();
    } catch (err: any) {
      console.warn(`[${spec.name}] malformed response body: ${err?.message ?? err}`);
      return empty;
    }

    const { text, tokensUsed } = spec.parseResponse(data);
    if (typeof text !== 'string') {
      console.warn(`[${spec.name}] malformed response body: response text missing`);
      return empty;
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed === 'NONE') return { triples: [], model, tokensUsed };
    return { triples: parseNTriples(trimmed, input.documentIri), model, tokensUsed };
  } catch (err: any) {
    console.warn(
      err?.name === 'AbortError'
        ? `[${spec.name}] request timed out after 60s`
        : `[${spec.name}] extraction failed: ${err?.message ?? err}`,
    );
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

export const DOCUMENT_KG_PROMPT = `You are a knowledge graph extraction engine. Extract structured knowledge from the following document as RDF N-Triples.

Rules:
- Subject URIs: use the document URI as the main subject for document-level facts. For entities mentioned in the document, use urn:dkg:entity:{slug} where slug is lowercase-kebab-case.
- Use schema.org predicates where possible:
  <http://schema.org/name>, <http://schema.org/description>, <http://schema.org/author>,
  <http://schema.org/datePublished>, <http://schema.org/about>, <http://schema.org/mentions>,
  <http://schema.org/keywords>, <http://schema.org/citation>, <http://schema.org/isPartOf>
- Use <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> for types (schema:ScholarlyArticle, schema:Person, schema:Organization, schema:MedicalCondition, etc.)
- For domain-specific relationships, use urn:dkg:rel:{relationship-name}
- String literals use "value" syntax. Include language tags where appropriate.
- Each triple MUST end with " ."
- Extract: document metadata (title, authors, date), key entities (people, organizations, concepts, conditions, treatments), relationships between entities, quantitative claims, and conclusions.
- Aim for 20-100 triples depending on document length and richness.
- If the document is too short or has no extractable knowledge, output exactly: NONE

IMPORTANT: Output ONLY valid N-Triples, one per line. No markdown fences, no explanations.`;
