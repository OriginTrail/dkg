import { describe, expect, it, vi } from 'vitest';
import {
  createDaemonLocalLlmService,
  DaemonLocalLlmError,
  resolveDaemonLocalLlmSettings,
} from '../src/daemon/local-llm-service.js';
import { listLocalAgentIntegrations } from '../src/daemon/local-agents.js';

function onlineFetch(): typeof fetch {
  return vi.fn(async () => Response.json({
    object: 'list',
    data: [{ id: 'local-model' }],
  })) as unknown as typeof fetch;
}

function fakeSession(options: {
  run?: (message: string, options?: { signal?: AbortSignal }) => Promise<any>;
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
      DKG_LLM_BACKEND: ' llama-cpp ',
      DKG_PROJECT: ' testing ',
    })).toEqual({
      llamaUrl: 'http://127.0.0.1:9090/v1/chat/completions',
      model: 'qwen',
      probeStrategy: { kind: 'llama.cpp' },
      defaultProjectId: 'testing',
      logDir: '/tmp/dkg/logs/local-llm',
    });
  });

  it('maps an invalid configured backend to structured offline health and chat errors', async () => {
    const fetcher = vi.fn();
    const createSession = vi.fn(async () => fakeSession());
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      env: { DKG_LLM_BACKEND: 'unknown-provider' },
      fetch: fetcher as typeof fetch,
      createSession,
    });

    expect(await service.health()).toEqual(expect.objectContaining({
      ok: false,
      ready: false,
      reachable: false,
      offline: true,
      error: expect.stringContaining('DKG_LLM_BACKEND must be one of'),
    }));
    await expect(service.chat({ message: 'hello' })).rejects.toMatchObject({
      code: 'LOCAL_LLM_OFFLINE', status: 503,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('accepts Ollama readiness through /v1/models without requiring /health', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:11434/v1/models') {
        return Response.json({ object: 'list', data: [{ id: 'qwen3:8b' }] });
      }
      return new Response('not found', { status: 404 });
    });
    const createSession = vi.fn(async () => fakeSession());
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      env: {
        DKG_LLM_URL: 'http://127.0.0.1:11434/v1/chat/completions',
        DKG_LLM_MODEL: 'qwen3:8b',
        DKG_LLM_BACKEND: 'ollama',
      },
      fetch: fetcher as typeof fetch,
      createSession,
    });

    expect(await service.health()).toEqual(expect.objectContaining({
      ok: true, ready: true, reachable: true, offline: false,
    }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:11434/v1/models');
    await expect(service.chat({ message: 'List saved queries', contextGraphId: 'testing' }))
      .resolves.toEqual(expect.objectContaining({ text: 'DKG evidence answer' }));
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      llamaUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      model: 'qwen3:8b',
    }));
    expect(fetcher.mock.calls.map(([input]) => String(input)))
      .toEqual([
        'http://127.0.0.1:11434/v1/models',
        'http://127.0.0.1:11434/v1/models',
      ]);
  });

  it('keeps health and chat not-ready when the configured model is absent', async () => {
    const fetcher = vi.fn(async () => Response.json({
      object: 'list',
      data: [{ id: 'llama3.2' }],
    }));
    const createSession = vi.fn(async () => fakeSession());
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      env: {
        DKG_LLM_URL: 'http://127.0.0.1:11434/v1/chat/completions',
        DKG_LLM_MODEL: 'qwen3:8b',
        DKG_LLM_BACKEND: 'ollama',
      },
      fetch: fetcher as typeof fetch,
      createSession,
    });

    expect(await service.health()).toEqual(expect.objectContaining({
      ok: false,
      ready: false,
      reachable: true,
      offline: false,
      error: expect.stringContaining("Configured model 'qwen3:8b' is not listed"),
    }));
    await expect(service.chat({ message: 'hello' })).rejects.toMatchObject({
      code: 'LOCAL_LLM_NOT_READY', status: 503,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('maps a malformed endpoint URL to structured offline health and chat errors', async () => {
    const fetcher = vi.fn();
    const createSession = vi.fn(async () => fakeSession());
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      env: { DKG_LLM_URL: 'not-a-url' },
      fetch: fetcher as typeof fetch,
      createSession,
    });

    expect(await service.health()).toEqual(expect.objectContaining({
      ok: false,
      ready: false,
      reachable: false,
      offline: true,
      error: expect.stringContaining('endpoint configuration is invalid'),
    }));
    await expect(service.chat({ message: 'hello' })).rejects.toMatchObject({
      code: 'LOCAL_LLM_OFFLINE', status: 503,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('keeps llama.cpp compatible through its /health readiness fallback', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      return new Response('not found', { status: 404 });
    });
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      env: { DKG_LLM_BACKEND: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
      createSession: vi.fn(),
    });

    expect(await service.health()).toEqual(expect.objectContaining({
      ok: true, ready: true, reachable: true, offline: false,
    }));
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname))
      .toEqual(['/v1/models', '/health']);
  });

  it('keeps llama.cpp chat unavailable until a loading model becomes healthy', async () => {
    let healthy = false;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: 'local-model', meta: null }],
        });
      }
      if (url.endsWith('/health')) {
        return healthy
          ? Response.json({ status: 'ok' })
          : new Response('loading model', { status: 503 });
      }
      return new Response('not found', { status: 404 });
    });
    const createSession = vi.fn(async () => fakeSession());
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      env: { DKG_LLM_BACKEND: 'llama.cpp' },
      fetch: fetcher as typeof fetch,
      createSession,
    });

    expect(await service.health()).toEqual(expect.objectContaining({
      ok: false, ready: false, reachable: true, offline: false,
    }));
    await expect(service.chat({ message: 'hello' })).rejects.toMatchObject({
      code: 'LOCAL_LLM_NOT_READY', status: 503,
    });
    expect(createSession).not.toHaveBeenCalled();

    healthy = true;
    expect(await service.health()).toEqual(expect.objectContaining({
      ok: true, ready: true, reachable: true, offline: false,
    }));
    await expect(service.chat({ message: 'hello' })).resolves.toEqual(
      expect.objectContaining({ text: 'DKG evidence answer' }),
    );
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('distinguishes a reachable but incompatible server from an offline server', async () => {
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      fetch: vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch,
      createSession: vi.fn(),
    });

    expect(await service.health()).toEqual(expect.objectContaining({
      ok: false,
      ready: false,
      reachable: true,
      offline: false,
      error: expect.stringContaining('reachable but not ready'),
    }));
    await expect(service.chat({ message: 'hello' })).rejects.toMatchObject({
      code: 'LOCAL_LLM_NOT_READY', status: 503,
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
    const runtimeOptions = createSession.mock.calls[0][0];
    expect(runtimeOptions.strictProjectScopeTools).toContain('dkg_query_catalog_run');
    expect(runtimeOptions.strictProjectScopeTools).not.toContain('dkg_memory_search');
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

  it('does not clear a session while its turn is active', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const session = fakeSession({
      run: async () => {
        await pending;
        return { answer: 'done', profile: 'read', toolCalls: [] };
      },
    });
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      fetch: onlineFetch(),
      createSession: vi.fn(async () => session),
    });

    const turn = service.chat({ message: 'slow', contextGraphId: 'graph-a' });
    await vi.waitFor(async () => expect((await service.health()).busy).toBe(true));
    await expect(service.clear()).rejects.toMatchObject({
      code: 'LOCAL_LLM_BUSY', status: 409,
    });
    expect(session.runtime.clearSession).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    release();
    await turn;
  });

  it('aborts and drains an active turn before closing its MCP session', async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    let runSignal: AbortSignal | undefined;
    const session = fakeSession({
      run: async (_message, runOptions) => {
        runSignal = runOptions?.signal;
        started();
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          runSignal?.addEventListener('abort', () => reject(runSignal?.reason), { once: true });
        });
        return { answer: 'late answer', profile: 'read', toolCalls: [] };
      },
    });
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg', fetch: onlineFetch(), createSession: vi.fn(async () => session),
    });

    const turn = service.chat({ message: 'slow', contextGraphId: 'graph-a' });
    const turnOutcome = turn.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await began;
    await service.close();
    const abortedBeforeCloseResolved = runSignal?.aborted;
    release();

    expect(abortedBeforeCloseResolved).toBe(true);
    await expect(turnOutcome).resolves.toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'The local LLM service is shutting down.' }),
    });
    expect(session.close).toHaveBeenCalledOnce();
    expect((await service.health()).busy).toBe(false);
  });

  it('waits for active session initialization before shutdown resolves', async () => {
    let releaseInitialization!: (session: ReturnType<typeof fakeSession>) => void;
    const initialization = new Promise<ReturnType<typeof fakeSession>>((resolve) => {
      releaseInitialization = resolve;
    });
    const session = fakeSession();
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg', fetch: onlineFetch(), createSession: vi.fn(async () => initialization),
    });

    const turn = service.chat({ message: 'slow init', contextGraphId: 'graph-a' });
    const turnOutcome = turn.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await vi.waitFor(async () => expect((await service.health()).busy).toBe(true));
    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    const resolvedBeforeInitialization = closeSettled;

    releaseInitialization(session);
    await closing;

    expect(resolvedBeforeInitialization).toBe(false);
    await expect(turnOutcome).resolves.toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'The local LLM service is shutting down.' }),
    });
    expect(session.close).toHaveBeenCalledOnce();
    expect((await service.health()).busy).toBe(false);
  });

  it('cancels stalled session initialization so shutdown can complete', async () => {
    let initializationSignal: AbortSignal | undefined;
    const createSession = vi.fn(async (runtimeOptions: { signal?: AbortSignal }) => {
      initializationSignal = runtimeOptions.signal;
      await new Promise<never>((_resolve, reject) => {
        initializationSignal?.addEventListener(
          'abort',
          () => reject(initializationSignal?.reason),
          { once: true },
        );
      });
    });
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg', fetch: onlineFetch(), createSession: createSession as any,
    });

    const turn = service.chat({ message: 'stalled init', contextGraphId: 'graph-a' });
    const turnOutcome = turn.then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await vi.waitFor(() => expect(initializationSignal).toBeDefined());

    await service.close();

    expect(initializationSignal?.aborted).toBe(true);
    await expect(turnOutcome).resolves.toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'The local LLM service is shutting down.' }),
    });
    expect((await service.health()).busy).toBe(false);
  });

  it('forwards caller cancellation, releases busy state, and reuses the clean session', async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { started = resolve; });
    const session = fakeSession({
      run: async (_message, runOptions) => {
        started();
        await pending;
        runOptions?.signal?.throwIfAborted();
        return { answer: 'clean answer', profile: 'read', toolCalls: [] };
      },
    });
    const createSession = vi.fn(async () => session);
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg', fetch: onlineFetch(), createSession,
    });
    const controller = new AbortController();

    const turn = service.chat({
      message: 'slow',
      contextGraphId: 'graph-a',
      signal: controller.signal,
    });
    await began;
    controller.abort(new Error('caller disconnected'));
    release();

    await expect(turn).rejects.toThrow('caller disconnected');
    expect((await service.health()).busy).toBe(false);
    expect(session.runtime.clearSession).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    await expect(service.chat({ message: 'retry', contextGraphId: 'graph-a' }))
      .resolves.toEqual(expect.objectContaining({ text: 'clean answer' }));
    expect(createSession).toHaveBeenCalledOnce();
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

  it('keeps clear exclusive until cleanup and graph-lock reset finish', async () => {
    let releaseClear!: () => void;
    const clearPending = new Promise<void>((resolve) => { releaseClear = resolve; });
    const first = fakeSession();
    first.runtime.clearSession.mockImplementationOnce(async () => clearPending);
    const second = fakeSession();
    const createSession = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const service = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg', fetch: onlineFetch(), createSession,
    });
    await service.chat({ message: 'bind A', contextGraphId: 'graph-a' });

    const clearing = service.clear();
    await vi.waitFor(() => expect(first.runtime.clearSession).toHaveBeenCalledOnce());
    expect((await service.health()).busy).toBe(true);
    await expect(service.chat({ message: 'race A', contextGraphId: 'graph-a' }))
      .rejects.toMatchObject({ code: 'LOCAL_LLM_BUSY', status: 409 });
    expect(createSession).toHaveBeenCalledOnce();

    releaseClear();
    await clearing;
    await service.chat({ message: 'bind B', contextGraphId: 'graph-b' });
    await expect(service.chat({ message: 'must stay B', contextGraphId: 'graph-a' }))
      .rejects.toMatchObject({ code: 'LOCAL_LLM_PROJECT_MISMATCH', status: 409 });
    expect(createSession).toHaveBeenCalledTimes(2);
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
