import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDaemonLocalLlmService,
  DaemonLocalLlmError,
  resolveDaemonLocalLlmSettings,
} from '../src/daemon/local-llm-service.js';
import { createLocalLlmProgramAdapter } from '../src/semantic-runtime-local-llm-adapter.js';
import { listLocalAgentIntegrations } from '../src/daemon/local-agents.js';
import { DkgLocalLlmRuntime } from '@origintrail-official/dkg-local-llm';

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
  it.each([false, true].flatMap(afterClear => ['adapter', 'profile', 'model', 'endpoint'].map(change => ({ afterClear, change }))))('rejects changed $change configuration before session creation (after clear=$afterClear)', async ({ afterClear, change }) => {
    const folder = mkdtempSync(join(tmpdir(), 'program-adapter-'));
    const owner = '0x' + '1'.repeat(40), graph = owner + '/jpb-data';
    const adapterFile = join(folder, 'adapter.mjs'), profileFile = join(folder, 'profile.json');
    writeFileSync(adapterFile, 'export function registerTools() {}');
    writeFileSync(profileFile, JSON.stringify({ name: 'JPB', routingKeywords: ['order'], readTools: ['jpb_read'] }), { mode: 0o600 });
    const run = vi.fn(async () => ({ answer: 'approved', profile: 'catalog', toolCalls: [] }));
    const createSession = vi.fn(async (_options: unknown) => fakeSession({ run }));
    const env = { DKG_PROJECT: graph, DKG_LLM_PROGRAM_AGENT: owner, DKG_LLM_DOMAIN_PROFILE: profileFile, DKG_LLM_ADAPTERS: adapterFile,
      DKG_LLM_MODEL: 'local-model', DKG_LLM_URL: 'http://127.0.0.1:8080/v1/chat/completions' };
    const service = createDaemonLocalLlmService({ dkgHome: folder, env, fetch: onlineFetch(), createSession });
    try {
      const grant = (await service.health()).programCapability!;
      const adapter = createLocalLlmProgramAdapter(graph, owner, grant, async () => {}, service.programProvider);
      if (afterClear) {
        await adapter.dispatch({} as any, { prompt: 'First approved turn' });
        expect(createSession.mock.calls[0][0]).toMatchObject({ adapterHashes: [{ path: adapterFile, sha256: expect.any(String) }] });
        await service.clear();
      }
      if (change === 'adapter') writeFileSync(adapterFile, 'export function registerTools() { throw new Error("changed") }');
      if (change === 'profile') writeFileSync(profileFile, JSON.stringify({ name: 'JPB changed', routingKeywords: ['order'], readTools: ['jpb_read'] }));
      if (change === 'model') env.DKG_LLM_MODEL = 'changed-model';
      if (change === 'endpoint') env.DKG_LLM_URL = 'http://127.0.0.1:9090/v1/chat/completions';
      expect((await service.health()).ready).toBe(false);
      await expect(adapter.dispatch({} as any, { prompt: 'Must not infer' })).rejects.toThrow('BEFORE_DISPATCH');
      expect(createSession).toHaveBeenCalledTimes(afterClear ? 1 : 0);
      expect(run).toHaveBeenCalledTimes(afterClear ? 1 : 0);
    } finally { await service.close(); rmSync(folder, { recursive: true, force: true }); }
  });

  it('isolates independently owned daemon providers and closing one disables only that owner', async () => {
    const owner = '0x' + '1'.repeat(40), graph = owner + '/jpb-data';
    const firstRun = vi.fn(async () => ({ answer: 'first' })), secondRun = vi.fn(async () => ({ answer: 'second' }));
    const env = { DKG_PROJECT: graph, DKG_LLM_PROGRAM_AGENT: owner };
    const first = createDaemonLocalLlmService({ dkgHome: '/tmp/dkg', env, fetch: onlineFetch(), createSession: async () => fakeSession({ run: firstRun }) });
    const second = createDaemonLocalLlmService({ dkgHome: '/tmp/dkg', env, fetch: onlineFetch(), createSession: async () => fakeSession({ run: secondRun }) });
    try {
      const adapter = createLocalLlmProgramAdapter(graph, owner, first.programProvider!.capability, async () => {}, first.programProvider);
      await adapter.dispatch({} as any, { prompt: 'Read first' });
      expect(firstRun).toHaveBeenCalledOnce();
      expect(secondRun).not.toHaveBeenCalled();
      await first.close();
      expect(adapter.enabled()).toBe(false);
      expect(second.programProvider!.isEnabled()).toBe(true);
      await second.programProvider!.run('Read second');
      expect(secondRun).toHaveBeenCalledOnce();
    } finally { await first.close(); await second.close(); }
  });

  it('aborts and drains standalone Program inference on shutdown without retaining conversation history', async () => {
    const owner = '0x' + '1'.repeat(40), graph = owner + '/jpb-data';
    let modelSignal: AbortSignal | undefined;
    const runtime = await DkgLocalLlmRuntime.create({
      mcp: { listTools: async () => ({ tools: [{ name: 'dkg_status', description: 'Read node status',
        inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }), callTool: vi.fn() },
      llamaUrl: 'http://local/v1/chat/completions', model: 'test-model',
      fetch: (async (_url: unknown, init: any) => {
        modelSignal = init.signal;
        await new Promise((_resolve, reject) => modelSignal!.addEventListener('abort', () => reject(modelSignal!.reason), { once: true }));
        throw new Error('Unreachable after aborted model request');
      }) as typeof fetch,
    });
    const close = vi.fn(async () => expect(modelSignal?.aborted).toBe(true));
    const service = createDaemonLocalLlmService({ dkgHome: '/tmp/dkg', env: { DKG_PROJECT: graph, DKG_LLM_PROGRAM_AGENT: owner },
      fetch: onlineFetch(), createSession: async () => ({ runtime, trace: {} as any, close }) });
    const adapter = createLocalLlmProgramAdapter(graph, owner, service.programProvider!.capability, async () => {}, service.programProvider);
    const pending = adapter.dispatch({} as any, { prompt: 'cancelled Program question' });
    const outcome = pending.catch(error => error);
    await vi.waitFor(() => expect(modelSignal).toBeDefined());
    await expect(service.clear()).rejects.toMatchObject({ code: 'LOCAL_LLM_BUSY' });
    await service.close();
    expect(await outcome).toMatchObject({ message: 'The local LLM service is shutting down.' });
    expect(close).toHaveBeenCalledOnce();
    expect(adapter.enabled()).toBe(false);
    expect((await service.health()).busy).toBe(false);
    expect(runtime.getSessionHistory()).toEqual([]);
  });

  it('reports an unavailable Program executor without falling back to direct inference', async () => {
    const owner = '0x' + '1'.repeat(40);
    const createSession = vi.fn();
    const service = createDaemonLocalLlmService({ dkgHome: '/tmp/dkg', env: {
      DKG_PROJECT: owner + '/jpb-data', DKG_LLM_PROGRAM_AGENT: owner,
      DKG_LLM_PROGRAM_EXECUTOR: '/reviewed/program.mjs',
    }, fetch: onlineFetch(), createSession,
    createProgramExecutor: async () => { throw new Error('JPB_CHAT_APPROVAL_CHANGED'); } });
    try {
      expect(await service.health()).toMatchObject({ ready: false, executionMode: 'program', error: 'JPB_CHAT_APPROVAL_CHANGED' });
      await expect(service.chat({ message: 'Read 62994' })).rejects.toMatchObject({ status: 502, message: 'JPB_CHAT_APPROVAL_CHANGED' });
      expect(createSession).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });

  it('routes Program-mode chat through the approved effect and captures evidence without recursion', async () => {
    const owner = '0x' + '1'.repeat(40), graph = owner + '/jpb-data';
    const run = vi.fn(async () => ({ answer: '280', profile: 'catalog', toolCalls: [],
      evidence: [{ name: 'order', arguments: { orderNo: '62994' }, result: 'SQL snapshot' }] }));
    const invoke = vi.fn();
    const service = createDaemonLocalLlmService({ dkgHome: '/tmp/dkg', env: {
      DKG_PROJECT: graph, DKG_LLM_PROGRAM_AGENT: owner, DKG_LLM_PROGRAM_EXECUTOR: '/reviewed/program.mjs',
    }, fetch: onlineFetch(), createSession: async () => fakeSession({ run }),
    createProgramExecutor: async ({ capability }) => ({ chat: async input => {
      invoke(input);
      const adapter = createLocalLlmProgramAdapter(graph, owner, capability, async () => {}, service.programProvider);
      const effect = await adapter.dispatch({} as any, { prompt: input.message });
      const result = JSON.parse(JSON.parse(effect.output!).output);
      return { text: result.answer, contextGraphId: graph, profile: result.profile, toolCalls: result.toolCalls,
        execution: { invocationId: 'test', executionIri: 'urn:execution:test', persisted: true,
          executionLayer: 'wm', programIri: 'urn:program:chat', contextGraphId: graph, assetName: 'semantic-execution-test' } };
    } }) });
    try {
      expect(await service.health()).toMatchObject({ executionMode: 'program' });
      expect(await service.chat({ message: 'NAF 62994', contextGraphId: graph }))
        .toMatchObject({ text: '280', execution: { persisted: true } });
      expect(invoke).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith('NAF 62994', expect.objectContaining({ captureEvidence: true }));
      await expect(service.chat({ message: 'Read elsewhere', contextGraphId: 'other' }))
        .rejects.toMatchObject({ code: 'LOCAL_LLM_PROJECT_MISMATCH' });
      expect(run).toHaveBeenCalledOnce();
    } finally { await service.close(); }
  });

  it('loads a reviewed read-only domain profile and keeps its adapter tools project-bound', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'dkg-llm-profile-'));
    try {
      const profile = { name: 'JPB', routingKeywords: ['order', 'PLCA'], readTools: ['dkg_query_catalog_list', 'jpb_prepare_plca'], systemContext: 'Use source evidence.' };
      const file = join(folder, 'domain.json');
      writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
      const createSession = vi.fn(async () => fakeSession());
      const service = createDaemonLocalLlmService({ dkgHome: folder, env: {
        DKG_LLM_DOMAIN_PROFILE: file, DKG_LLM_ADAPTERS: '/reviewed/jpb-adapter.mjs',
      }, fetch: onlineFetch(), createSession });
      await service.chat({ message: 'Prepare PLCA', contextGraphId: 'testing' });
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
        adapterPaths: ['/reviewed/jpb-adapter.mjs'], domainProfile: profile,
        strictProjectScope: true, strictProjectScopeTools: profile.readTools,
        strictProjectScopeUnscopedTools: ['dkg_status'], allowWrite: false,
      }));
      await expect(service.chat({ message: 'Another order', contextGraphId: 'another' }))
        .rejects.toMatchObject({ code: 'LOCAL_LLM_PROJECT_MISMATCH' });
      await service.close();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it.each(['relative/adapter.mjs', '/reviewed/adapter.mjs'])('rejects an adapter without a reviewed domain profile (%s)', async adapter => {
    const createSession = vi.fn();
    const service = createDaemonLocalLlmService({ dkgHome: '/tmp/dkg', env: { DKG_LLM_ADAPTERS: adapter }, fetch: onlineFetch(), createSession });
    expect(await service.health()).toMatchObject({ ready: false, configured: true });
    await expect(service.chat({ message: 'hello' })).rejects.toMatchObject({ code: 'LOCAL_LLM_OFFLINE' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([true, false])('fails closed for a write-enabled or writable domain profile (writeTools=%s)', writeTools => {
    const folder = mkdtempSync(join(tmpdir(), 'dkg-llm-profile-'));
    try {
      const file = join(folder, 'domain.json');
      writeFileSync(file, JSON.stringify({ name: 'Bad', routingKeywords: ['order'], readTools: ['jpb_read'],
        ...(writeTools ? { writeTools: ['jpb_mutate'] } : {}) }), { mode: writeTools ? 0o600 : 0o666 });
      if (!writeTools) {
        // umask may remove writable bits from creation; set the unsafe mode explicitly.
        chmodSync(file, 0o666);
      }
      expect(resolveDaemonLocalLlmSettings(folder, { DKG_LLM_DOMAIN_PROFILE: file }).probeConfigurationError).toBeTruthy();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

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
      configured: true,
      llamaUrl: 'http://127.0.0.1:9090/v1/chat/completions',
      model: 'qwen',
      probeStrategy: { kind: 'llama.cpp' },
      defaultProjectId: 'testing',
      logDir: '/tmp/dkg/logs/local-llm',
    });
  });

  it('distinguishes an untouched default endpoint from explicit local-LLM configuration', () => {
    expect(resolveDaemonLocalLlmSettings('/tmp/dkg', {}).configured).toBe(false);
    expect(resolveDaemonLocalLlmSettings('/tmp/dkg', {
      DKG_LLM_MODEL: ' local-model ',
    }).configured).toBe(true);
    expect(resolveDaemonLocalLlmSettings('/tmp/dkg', {
      LLAMA_URL: ' http://127.0.0.1:8080/v1/chat/completions ',
    }).configured).toBe(true);
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
      configured: true,
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

  it('keeps both llama.cpp readiness shapes compatible with the default auto backend', async () => {
    const loadedFetch = vi.fn(async () => Response.json({
      object: 'list',
      data: [{ id: 'local-model', meta: { n_ctx_train: 32_768 } }],
    }));
    const loaded = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      fetch: loadedFetch as typeof fetch,
      createSession: vi.fn(),
    });

    expect(await loaded.health()).toEqual(expect.objectContaining({
      ok: true, ready: true, reachable: true, offline: false,
    }));
    expect(loadedFetch).toHaveBeenCalledOnce();

    const fallbackFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return new Response('not found', { status: 404 });
      return Response.json({ status: 'ok' });
    });
    const fallback = createDaemonLocalLlmService({
      dkgHome: '/tmp/dkg',
      fetch: fallbackFetch as typeof fetch,
      createSession: vi.fn(),
    });

    expect(await fallback.health()).toEqual(expect.objectContaining({
      ok: true, ready: true, reachable: true, offline: false,
    }));
    expect(fallbackFetch.mock.calls.map(([input]) => new URL(String(input)).pathname))
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
      ok: false, configured: false, reachable: false, offline: true,
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
