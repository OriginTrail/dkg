import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const client = {
    connect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
    close: vi.fn(),
  };
  return {
    client,
    Client: vi.fn(function Client() { return client; }),
    StdioClientTransport: vi.fn(function StdioClientTransport() {
      return { stderr: undefined };
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: sdk.Client }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: sdk.StdioClientTransport,
  getDefaultEnvironment: () => ({}),
}));

import { createDkgLocalLlmRuntimeSession } from '../src/local-llm-runtime-factory.js';

const cliPackageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

describe('local LLM runtime factory initialization lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.client.close.mockResolvedValue(undefined);
  });

  it('aborts a stalled MCP connect and closes the partially initialized client', async () => {
    sdk.client.connect.mockImplementationOnce(async (_transport, options?: { signal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const creating = createDkgLocalLlmRuntimeSession({
      dkgHome: '/tmp/dkg',
      llamaUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      model: 'test-model',
      logDir: '/tmp/dkg-local-llm-factory-test',
      signal: controller.signal,
      initializationTimeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(sdk.client.connect).toHaveBeenCalledOnce());

    controller.abort(new Error('daemon shutdown'));

    await expect(creating).rejects.toThrow('daemon shutdown');
    expect(sdk.client.connect.mock.calls[0][1]).toEqual(expect.objectContaining({
      signal: expect.objectContaining({ aborted: true }),
      timeout: 5_000,
    }));
    expect(sdk.client.close).toHaveBeenCalledOnce();
  });

  it('uses the same bounded initialization signal for MCP tools/list', async () => {
    sdk.client.connect.mockResolvedValueOnce(undefined);
    sdk.client.listTools.mockResolvedValueOnce({
      tools: [{
        name: 'dkg_status',
        description: 'Read node status',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      }],
    });
    const controller = new AbortController();

    const session = await createDkgLocalLlmRuntimeSession({
      dkgHome: '/tmp/dkg',
      llamaUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      model: 'test-model',
      logDir: '/tmp/dkg-local-llm-factory-test',
      signal: controller.signal,
      initializationTimeoutMs: 5_000,
    });

    expect(sdk.Client).toHaveBeenCalledWith({
      name: 'dkg-local-llm',
      version: cliPackageJson.version,
    });
    const connectSignal = sdk.client.connect.mock.calls[0][1]?.signal;
    const listSignal = sdk.client.listTools.mock.calls[0][1]?.signal;
    expect(connectSignal).toBeInstanceOf(AbortSignal);
    expect(listSignal).toBe(connectSignal);
    await session.close();
    expect(sdk.client.close).toHaveBeenCalledOnce();
  });
});
