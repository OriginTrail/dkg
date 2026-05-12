// Layer 2 semantic extraction dispatcher. Routes to the configured
// LlmProvider; DKG_EXTRACTION_PROVIDER env > LlmConfig.provider > 'openai'.
import type { LlmConfig } from '../config.js';
import { invokeProvider, type LlmProvider } from './llm-provider.js';
import { openaiProvider } from './providers/openai.js';
import { anthropicProvider } from './providers/anthropic.js';

export interface LlmExtractionInput {
  markdown: string;
  agentDid: string;
  documentIri: string;
  maxTokens?: number;
}

export interface LlmExtractionOutput {
  triples: Array<{ subject: string; predicate: string; object: string }>;
  model: string;
  tokensUsed?: number;
}

function resolveProvider(config: LlmConfig): LlmProvider {
  const requested = process.env.DKG_EXTRACTION_PROVIDER ?? config.provider ?? 'openai';
  if (requested === 'anthropic') return anthropicProvider;
  if (requested === 'openai') return openaiProvider;
  console.warn(`[llm-extractor] Unknown provider "${requested}", falling back to openai`);
  return openaiProvider;
}

export async function extractWithLlm(
  input: LlmExtractionInput,
  config: LlmConfig,
): Promise<LlmExtractionOutput> {
  const provider = resolveProvider(config);
  try {
    return await invokeProvider(provider, input, config);
  } catch (err: any) {
    console.warn(`[llm-extractor] provider "${provider.name}" threw: ${err?.message ?? err}`);
    return { triples: [], model: config.model ?? provider.defaultModel };
  }
}
