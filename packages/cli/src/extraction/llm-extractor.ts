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

/**
 * When the env var forces a provider different from `config.provider`, the
 * `model` and `baseURL` on the config belong to the OTHER provider (e.g.
 * OpenAI's `gpt-5-nano` + `https://api.openai.com/v1`) and would corrupt
 * the actual outbound request — wrong endpoint, wrong model name. Strip
 * them so each provider uses its own defaults. The apiKey is the only
 * field the operator-routed provider needs from the config.
 */
function resolveEffectiveConfig(config: LlmConfig, provider: LlmProvider): LlmConfig {
  const configuredProvider = config.provider ?? 'openai';
  if (configuredProvider !== provider.name) {
    return { apiKey: config.apiKey };
  }
  return config;
}

export async function extractWithLlm(
  input: LlmExtractionInput,
  config: LlmConfig,
): Promise<LlmExtractionOutput> {
  const provider = resolveProvider(config);
  const effective = resolveEffectiveConfig(config, provider);
  try {
    return await invokeProvider(provider, input, effective);
  } catch (err: any) {
    console.warn(`[llm-extractor] provider "${provider.name}" threw: ${err?.message ?? err}`);
    return { triples: [], model: effective.model ?? provider.defaultModel };
  }
}
