import type { LlmCapabilities, LlmConfig } from './types.js';

function normalizeModel(model: string | undefined): string {
  return (model ?? '').trim().toLowerCase();
}

function isReasoningStyleModel(model: string): boolean {
  return model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('o5');
}

export function resolveCapabilities(config: LlmConfig): LlmCapabilities {
  const model = normalizeModel(config.model || 'gpt-5-mini');
  const reasoningModel = isReasoningStyleModel(model);
  const gpt5Model = model.startsWith('gpt-5');
  const supportsTemperature = !reasoningModel && !gpt5Model;
  const supportsMaxTokens = !reasoningModel && !gpt5Model;

  return {
    provider: 'openai-compatible',
    supportsStreaming: true,
    supportsTools: true,
    supportsTemperature,
    supportsMaxTokens,
  };
}
