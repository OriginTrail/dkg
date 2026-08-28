import { describe, expect, it, vi } from 'vitest';
import {
  createDaemonLocalLlmService,
  DaemonLocalLlmError,
  resolveDaemonLocalLlmSettings,
} from '../src/daemon/local-llm-service.js';
import { listLocalAgentIntegrations } from '../src/daemon/local-agents.js';

function onlineFetch(): typeof fetch {
  return vi.fn(async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch;
}

function fakeSession(options: {
  run?: (message: string) => Promise<any>;
  close?: ReturnType<typeof vi.fn>;
} = {}) {
  const close = options.close ?? vi.fn(async () => undefined);
  const clearSession = vi.fn(async () => undefined);
  return {
    runtime: {
      run: options.run ?? vi.fn(async () => ({
        answer: 'DKG evidence answer',
        profile: 'catalog',
        toolCalls: [{ name: 'dkg_query_catalog_list', arguments: { projectId: 'testing' } }],
        traceFile: '/tmp/local-llm.log',
      })),
      clearSession,
    },
    trace: { filePath: '/tmp/local-llm.log' },
    close,
  } as any;
}

describe('daemon local LLM service', () => {
  it('registers a daemon-owned read-only chat surface that stored config cannot replace', () => {
    const integrations = listLocalAgentIntegrations({
      localAgentIntegrations: {
        'local-llm': {
          id: 'local-llm',
          name: 'untrusted override',
          enabled: false,
          transport: { kind: 'external-installer' },
          capabilities: { localChat: false, connectFromUi: true },
        },
      },
    } as any);
    expect(integrations.find((integration) => integration.id === 'local-llm')).toMatchObject({
      name: 'DKG Local LLM',
      enabled: true,
      transport: { kind: 'dkg-local-llm' },
      capabilities: { localChat: true, connectFromUi: false },
      runtime: { status: 'configured', ready: false },
    });
  });

  it('resolves only the supported daemon environment settings', () => {
    expect(resolveDaemonLocalLlmSettings('/tmp/dkg', {
      DKG_LLM_URL: ' http://127.0.0.1:9090/v1/chat/completions ',
      DKG_LLM_MODEL: ' qwen ',
      DKG_PROJECT: ' testing ',
    })).toEqual({
      llamaUrl: 'http://127.0.0.1:9090/v1/chat/completions',
      model: 'qwen',
      defaultProjectId: 'testing',
      logDir: '/tmp/dkg/logs/local-llm',
    });
  });

  it('reports online/offline health without initializing MCP', async () => {
    const createSession = vi.fn();
    const online = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg', fetch: onlineFetch(), createSession,
    });
    expect(await online.health()).toEqual(expect.objectContaining({
      ok: true, ready: true, reachable: true, offline: false, initialized: false, readOnly: true,
    }));
    expect(createSession).not.toHaveBeenCalled();

    const offline = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch,
      createSession,
    });
    expect(await offline.health()).toEqual(expect.objectContaining({
      ok: false, reachable: false, offline: true,
    }));
    await expect(offline.chat({ message: 'hello' })).rejects.toMatchObject({
      code: 'LOCAL_LLM_OFFLINE', status: 503,
    });
  });

  it('lazily creates one read-only session and returns trace/tool metadata', async () => {
    const session = fakeSession();
    const createSession = vi.fn(async () => session);
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg', fetch: onlineFetch(), createSession,
    });
    const result = await service.chat({ message: 'List saved queries', contextGraphId: 'testing' });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'testing', allowWrite: false, profile: 'auto', temperature: 0.15, topP: 0.9,
    }));
    expect(result).toEqual(expect.objectContaining({
      text: 'DKG evidence answer',
      sessionId: 'local-llm:dkg-ui',
      contextGraphId: 'testing',
      profile: 'catalog',
      readOnly: true,
      traceFile: '/tmp/local-llm.log',
      toolCalls: [{ name: 'dkg_query_catalog_list', arguments: { projectId: 'testing' } }],
    }));
    await service.chat({ message: 'Run the first one', contextGraphId: 'testing' });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('rejects concurrent turns with a stable busy code', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      fetch: onlineFetch(),
      createSession: vi.fn(async () => fakeSession({
        run: async () => {
          await pending;
          return { answer: 'done', profile: 'read', toolCalls: [] };
        },
      })),
    });
    const first = service.chat({ message: 'first', contextGraphId: 'a' });
    await vi.waitFor(async () => expect((await service.health()).busy).toBe(true));
    await expect(service.chat({ message: 'second', contextGraphId: 'a' })).rejects.toMatchObject({
      code: 'LOCAL_LLM_BUSY', status: 409,
    });
    release();
    await first;
  });

  it('requires clear before rebinding, then closes and creates the new graph session', async () => {
    const first = fakeSession();
    const second = fakeSession();
    const createSession = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg', fetch: onlineFetch(), createSession,
    });
    await service.chat({ message: 'one', contextGraphId: 'graph-a' });
    await expect(service.chat({ message: 'two', contextGraphId: 'graph-b' })).rejects.toMatchObject({
      code: 'LOCAL_LLM_PROJECT_MISMATCH', status: 409,
    });
    await service.clear();
    expect(first.runtime.clearSession).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    await service.chat({ message: 'two', contextGraphId: 'graph-b' });
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'graph-b' }));
    await service.close();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('surfaces initialization failure in health and closes cleanly', async () => {
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      fetch: onlineFetch(),
      createSession: vi.fn(async () => { throw new Error('MCP tools/list failed'); }),
    });
    await expect(service.chat({ message: 'hello' })).rejects.toBeInstanceOf(DaemonLocalLlmError);
    expect(await service.health()).toEqual(expect.objectContaining({
      ok: false,
      initFailure: 'MCP tools/list failed',
      error: 'MCP tools/list failed',
    }));
    await service.close();
  });
});
