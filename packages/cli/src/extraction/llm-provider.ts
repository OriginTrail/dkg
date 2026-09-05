// Pluggable LLM provider for Layer 2 semantic extraction.
//
// A provider declares two things: how to build the HTTP request from an
// extraction input, and how to read the LLM's response payload back into
// `{ text, tokensUsed }`. Everything else — apiKey check, 60s timeout,
// fail-soft branches, JSON parse, NONE/empty handling, parseNTriples —
// lives in `invokeProvider` below.
import type { LlmConfig } from '../config.js';
import type { LlmExtractionInput, LlmExtractionOutput } from './llm-extractor.js';
import { parseNTriples } from './parse-ntriples.js';

export interface LlmProvider {
  readonly name: 'openai' | 'anthropic';
  readonly defaultModel: string;

  /** Build the HTTP request to send. Called once per `invokeProvider` call. */
  buildRequest(
    input: LlmExtractionInput,
    config: LlmConfig,
    model: string,
  ): { url: string; headers: Record<string, string>; body: unknown };

  /** Extract the LLM-emitted text and token count from the response JSON. */
  parseResponse(data: unknown): {
    text: string | undefined;
    tokensUsed: number | undefined;
  };
}

/**
 * Run an `LlmProvider` end-to-end against an extraction input. Owns the
 * shared scaffolding so providers only declare what makes them different.
 * Never throws — every failure mode returns `{ triples: [], model }` and
 * emits a `[<provider>] …` console.warn.
 */
export async function invokeProvider(
  provider: LlmProvider,
  input: LlmExtractionInput,
  config: LlmConfig,
): Promise<LlmExtractionOutput> {
  const model = config.model ?? provider.defaultModel;
  const empty: LlmExtractionOutput = { triples: [], model };

  if (!config.apiKey) {
    console.warn(`[${provider.name}] missing apiKey — semantic extraction skipped`);
    return empty;
  }

  const { url, headers, body } = provider.buildRequest(input, config, model);
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
      console.warn(`[${provider.name}] API returned ${res.status}: ${await res.text().catch(() => '')}`);
      return empty;
    }

    let data: unknown;
    try { data = await res.json(); }
    catch (err: any) {
      console.warn(`[${provider.name}] malformed response body: ${err?.message ?? err}`);
      return empty;
    }

    const { text, tokensUsed } = provider.parseResponse(data);
    if (typeof text !== 'string') {
      console.warn(`[${provider.name}] malformed response body: response text missing`);
      return empty;
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed === 'NONE') return { triples: [], model, tokensUsed };
    return { triples: parseNTriples(trimmed, input.documentIri), model, tokensUsed };
  } catch (err: any) {
    console.warn(err?.name === 'AbortError'
      ? `[${provider.name}] request timed out after 60s`
      : `[${provider.name}] extraction failed: ${err?.message ?? err}`);
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
