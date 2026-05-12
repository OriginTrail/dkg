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

  it('default request body matches the pinned OpenAI chat-completions shape', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured.url = String(url);
        captured.init = init;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'NONE' } }],
            usage: { total_tokens: 7 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const result = await extractWithLlm(sampleInput, makeConfig());

    expect(result.triples).toEqual([]);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.tokensUsed).toBe(7);

    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured.init?.method).toBe('POST');
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(captured.init?.body));
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: body.messages[0].content },
        {
          role: 'user',
          content: 'Document URI: urn:dkg:doc:1\n\n# Doc\n\nHello world.',
        },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });
    // System prompt: pin load-bearing phrases without snapshotting verbatim.
    expect(body.messages[0].content).toContain('knowledge graph extraction engine');
    expect(body.messages[0].content).toContain('RDF N-Triples');
    expect(body.messages[0].content).toContain('output exactly: NONE');
  });
});
