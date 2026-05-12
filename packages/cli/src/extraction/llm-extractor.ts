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
 * in ./llm-provider.ts. Precedence:
 *   DKG_EXTRACTION_PROVIDER env var > LlmConfig.provider > 'openai'.
 * Unknown values warn and fall back to OpenAI so a typo never blocks
 * extraction.
 */
import type { LlmConfig } from '../config.js';
import type { LlmProvider } from './llm-provider.js';
import { openaiProvider } from './providers/openai.js';
import { anthropicProvider } from './providers/anthropic.js';

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

function resolveProvider(llmConfig: LlmConfig): LlmProvider {
  const requested =
    process.env.DKG_EXTRACTION_PROVIDER ?? llmConfig.provider ?? 'openai';
  if (requested === 'anthropic') return anthropicProvider;
  if (requested === 'openai') return openaiProvider;
  console.warn(
    `[llm-extractor] Unknown provider "${requested}", falling back to openai`,
  );
  return openaiProvider;
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
  const provider = resolveProvider(llmConfig);
  try {
    return await provider.invoke(input, llmConfig);
  } catch (err: any) {
    console.warn(
      `[llm-extractor] provider "${provider.name}" threw unexpectedly: ${err?.message ?? err}`,
    );
    const fallbackModel =
      llmConfig.model ?? (provider.name === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini');
    return { triples: [], model: fallbackModel };
  }
}
