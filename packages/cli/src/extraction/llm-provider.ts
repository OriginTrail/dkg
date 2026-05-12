// Pluggable LLM provider for Layer 2 semantic extraction.
import type { LlmConfig } from '../config.js';
import type { LlmExtractionInput, LlmExtractionOutput } from './llm-extractor.js';

export interface LlmProvider {
  readonly name: 'openai' | 'anthropic';
  readonly defaultModel: string;
  invoke(input: LlmExtractionInput, config: LlmConfig): Promise<LlmExtractionOutput>;
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
