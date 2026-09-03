import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSafeLlmAdapter } from '../src/semantic-runtime-safe-llm-adapter.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('safe LLM Rig adapter', () => {
  it('uses a keyless local endpoint and lets Rig invoke only an opaque Program', async () => {
    const requests: string[] = [];
    const toolName = 'program_0123456789abcdef';
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        requests.push(body);
        const hasResult = body.includes('urn:sr:execution:child');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: 'chat.completion',
          created: 1,
          model: 'fixture-model',
          choices: [{
            index: 0,
            message: hasResult ? {
              role: 'assistant',
              content: 'safe-rig-ok',
            } : {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: { name: toolName, arguments: '{}' },
              }],
            },
            finish_reason: hasResult ? 'stop' : 'tool_calls',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    vi.stubEnv('DKG_LLM_URL', `http://127.0.0.1:${address.port}/v1/chat/completions`);
    vi.stubEnv('DKG_LLM_MODEL', 'fixture-model');
    const invokeChild = vi.fn(async () => ({
      executionIri: 'urn:sr:execution:child',
      outputs: ['field-a-value'],
      persisted: true as const,
    }));
    const adapter = createSafeLlmAdapter(
      undefined,
      [{
        capabilityId: 'opaque-capability',
        programIri: 'urn:sr:program:field-a-read',
        sourceHash: 'a'.repeat(64),
        name: toolName,
        description: 'Read field A.',
      }],
      invokeChild,
    );

    const result = await adapter.dispatch({ effectId: 'urn:sr:effect:parent:1' } as any, {
      prompt: 'Read field A and answer.',
    });
    expect(result).toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(result.output!)).toEqual({
      output: 'safe-rig-ok',
      childExecutions: ['urn:sr:execution:child'],
    });
    expect(invokeChild).toHaveBeenCalledWith(
      'urn:sr:program:field-a-read',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(toolName);
    expect(requests[0]).not.toContain('urn:sr:program:field-a-read');
  });

  it('does not allow a keyless non-loopback endpoint', () => {
    const adapter = createSafeLlmAdapter(
      { apiKey: '', model: 'remote-model', baseURL: 'https://models.example/v1' },
      [{
        capabilityId: 'opaque-capability',
        programIri: 'urn:sr:program:field-a-read',
        name: 'program_0123456789abcdef',
        description: 'Read field A.',
      }],
      vi.fn(),
    );
    expect(adapter.enabled()).toBe(false);
  });
});
