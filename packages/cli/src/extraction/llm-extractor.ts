/**
 * Layer 2 Semantic Extraction — LLM-assisted knowledge extraction from
 * a Markdown intermediate. Non-deterministic; produces attributed triples.
 *
 * Spec: 19_MARKDOWN_CONTENT_TYPE.md §3.2
 *
 * The LLM reads the markdown body and extracts structured knowledge that
 * the deterministic structural extractor cannot capture: claims in prose,
 * implicit relationships, entity mentions, and quantitative facts.
 *
 * Every triple carries extraction provenance so consumers can distinguish
 * structural (deterministic, verifiable) from semantic (agent-interpreted,
 * endorsable) knowledge.
 */

import type { LlmConfig } from '../config.js';

export interface LlmExtractionInput {
  markdown: string;
  agentDid: string;
  documentIri: string;
  /** Maximum tokens for the LLM response. */
  maxTokens?: number;
}

export interface LlmExtractionOutput {
  triples: Array<{ subject: string; predicate: string; object: string }>;
  model: string;
  tokensUsed?: number;
}

const DOCUMENT_KG_PROMPT = `You are a knowledge graph extraction engine. Extract structured knowledge from the following document as RDF N-Triples.

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

/**
 * Run LLM-assisted semantic extraction on a markdown intermediate.
 * Returns extracted triples or an empty result if the LLM is unavailable
 * or produces no usable output. Never throws — failures are logged and
 * return an empty result so structural extraction still succeeds.
 */
export async function extractWithLlm(
  input: LlmExtractionInput,
  llmConfig: LlmConfig,
): Promise<LlmExtractionOutput> {
  const empty: LlmExtractionOutput = { triples: [], model: llmConfig.model ?? 'gpt-4o-mini' };

  const { apiKey, model = 'gpt-4o-mini', baseURL = 'https://api.openai.com/v1' } = llmConfig;
  if (!apiKey) return empty;

  const truncated = input.markdown.length > 60_000
    ? input.markdown.slice(0, 60_000) + '\n\n[... document truncated for extraction ...]'
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[llm-extractor] LLM API returned ${res.status}: ${await res.text().catch(() => '')}`);
      return empty;
    }

    const data = (await res.json()) as any;
    const output = data.choices?.[0]?.message?.content?.trim() ?? '';
    const tokensUsed = data.usage?.total_tokens;

    if (!output || output === 'NONE') {
      return { triples: [], model, tokensUsed };
    }

    const triples = parseNTriples(output, input.documentIri);
    return { triples, model, tokensUsed };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn('[llm-extractor] LLM API request timed out after 60s');
    } else {
      console.warn(`[llm-extractor] LLM extraction failed: ${err.message}`);
    }
    return empty;
  }
}

/**
 * Parse N-Triples output from the LLM. Tolerant of common LLM formatting
 * issues (markdown fences, blank lines, comments).
 */
function parseNTriples(
  text: string,
  _documentIri: string,
): Array<{ subject: string; predicate: string; object: string }> {
  const triples: Array<{ subject: string; predicate: string; object: string }> = [];

  const cleaned = text
    .replace(/^```[a-z]*\n?/gm, '')
    .replace(/^```\s*$/gm, '');

  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(
      /^<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|("(?:[^"\\]|\\.)*"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?))\s*\.?\s*$/,
    );
    if (match) {
      const subject = match[1]!;
      const predicate = match[2]!;
      const object = match[3] ? match[3] : match[4]!;
      if (subject.length > 0 && predicate.length > 0 && object.length > 0) {
        triples.push({ subject, predicate, object });
      }
    }
  }
  return triples;
}
