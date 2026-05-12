import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { extractWithLlm } from '../src/extraction/llm-extractor.js';
import type { LlmConfig } from '../src/config.js';

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    apiKey: 'sk-test-key',
    ...overrides,
  };
}

const sampleInput = {
  markdown: '# Doc\n\nHello world.',
  agentDid: 'did:example:agent',
  documentIri: 'urn:dkg:doc:1',
};

describe('extractWithLlm — OpenAI provider', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  it('fail-soft: missing apiKey returns empty and warns with [openai] prefix', async () => {
    const result = await extractWithLlm(sampleInput, makeConfig({ apiKey: '' }));
    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-4o-mini');
    expect(warnSpy).toHaveBeenCalled();
    const message = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/^\[openai\]/m);
  });
});
