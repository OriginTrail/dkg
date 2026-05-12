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
 *
 * Provider selection lives behind the pluggable `LlmProvider` interface
 * in ./llm-provider.ts. Issue 0001 ships the OpenAI provider only;
 * Anthropic and env-var selection arrive in issue 0002.
 */
import type { LlmConfig } from '../config.js';
import { openaiProvider } from './providers/openai.js';

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
  return openaiProvider.invoke(input, llmConfig);
}
