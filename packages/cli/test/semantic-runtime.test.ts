import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  invokeStoredSemanticProgram,
  loadStoredSemanticProgram,
  startConfiguredSemanticRuntime,
  validateSemanticRuntimeConfig,
} from '../src/semantic-runtime.js';

const ORIGINAL_PROVIDER = process.env.SEMANTIC_RUNTIME_LLM_PROVIDER;
const ORIGINAL_CODEX_BIN = process.env.SEMANTIC_RUNTIME_CODEX_BIN;
const ORIGINAL_CODEX_COUNT_PATH = process.env.SEMANTIC_RUNTIME_CODEX_COUNT_PATH;

afterEach(() => {
  if (ORIGINAL_PROVIDER === undefined) delete process.env.SEMANTIC_RUNTIME_LLM_PROVIDER;
  else process.env.SEMANTIC_RUNTIME_LLM_PROVIDER = ORIGINAL_PROVIDER;
  if (ORIGINAL_CODEX_BIN === undefined) delete process.env.SEMANTIC_RUNTIME_CODEX_BIN;
  else process.env.SEMANTIC_RUNTIME_CODEX_BIN = ORIGINAL_CODEX_BIN;
  if (ORIGINAL_CODEX_COUNT_PATH === undefined) delete process.env.SEMANTIC_RUNTIME_CODEX_COUNT_PATH;
  else process.env.SEMANTIC_RUNTIME_CODEX_COUNT_PATH = ORIGINAL_CODEX_COUNT_PATH;
});

describe('semantic runtime daemon configuration', () => {
  it('is default-off with no artifact or Worker side effects', async () => {
    const start = vi.fn();
    await expect(
      startConfiguredSemanticRuntime(undefined, { log: vi.fn(), start }),
    ).resolves.toBeNull();
    await expect(
      startConfiguredSemanticRuntime({ enabled: false }, { log: vi.fn(), start }),
    ).resolves.toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('forwards only validated opt-in configuration and reports Phase 0 limits', async () => {
    const host = { stop: vi.fn() } as any;
    const start = vi.fn().mockResolvedValue(host);
    const log = vi.fn();
    const service = await startConfiguredSemanticRuntime(
        { enabled: true, watchdogMs: 250, maxEvents: 12 },
        { log, start, openStore: () => new SemanticRuntimeStore(':memory:') },
      );
    expect(service?.host).toBe(host);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      config: { enabled: true, watchdogMs: 250, maxEvents: 12 },
      log,
    }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Wasm execution + durable effect journal enabled'));
  });

  it('rejects unsafe bounds before a Worker is started', () => {
    expect(() => validateSemanticRuntimeConfig({ watchdogMs: 0 })).toThrow(/watchdogMs/);
    expect(() => validateSemanticRuntimeConfig({ maxEvents: 100_001 })).toThrow(/maxEvents/);
    expect(() => validateSemanticRuntimeConfig({ partitionId: 'not-a-hash' })).toThrow(/partitionId/);
    expect(() => validateSemanticRuntimeConfig({ maxAccumulator: '-1' })).toThrow(/maxAccumulator/);
  });

  it('loads an S-expression program only from the requested VM graph', async () => {
    const source = '(strategy demo)';
    const query = vi.fn().mockResolvedValue({
      type: 'bindings',
      bindings: [{
        language: '"sexpr-v1"',
        version: '"1.0.0"',
        source: JSON.stringify(source),
      }],
    });

    await expect(loadStoredSemanticProgram(
      { query } as any,
      'devnet-test',
      'urn:sr:program:demo',
    )).resolves.toEqual({
      contextGraphId: 'devnet-test',
      programIri: 'urn:sr:program:demo',
      language: 'sexpr-v1',
      version: '1.0.0',
      source,
      requiredTools: [],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('<urn:sr:program:demo>'), {
      contextGraphId: 'devnet-test',
      view: 'verifiable-memory',
      source: 'semantic-runtime-program-load',
    });
  });

  it('rejects an external shell.exec request before starting Wasm execution', async () => {
    const startPlan = vi.fn();
    const store = new SemanticRuntimeStore(':memory:');
    const runtime = {
      host: { startPlan },
      store,
      inFlight: new Map(),
      stop: async () => store.close(),
    } as any;
    const source = `(strategy external/shell
      (version "1.0.0")
      (scope network:devnet)
      (goal attempt-uninstalled-shell)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (delegate attacker
          (grant shell.exec)
          (call shell.exec@1 "whoami"))))`;
    const agent = {
      query: vi.fn(async () => ({
        type: 'bindings',
        bindings: [{
          language: '"sexpr-v1"',
          version: '"1.0.0"',
          source: JSON.stringify(source),
          tool: '<urn:sr:tool:shell-exec-v1>',
        }],
      })),
    } as any;
    try {
      await expect(invokeStoredSemanticProgram(
        agent,
        runtime,
        'devnet-test',
        'urn:sr:program:external-shell',
        '123e4567-e89b-42d3-a456-426614174001',
        { enabled: true, operatorPolicyIri: 'urn:sr:policy:operator' },
      )).rejects.toMatchObject({ code: 'PROGRAM_REJECTED', status: 422 });
      expect(startPlan).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });

  it('persists the exact Wasm-resumed Codex output and SHA-256 before succeeding', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-runtime-cli-'));
    const codex = path.join(temporary, 'codex-test');
    const codexCount = path.join(temporary, 'codex-count');
    fs.writeFileSync(
      codex,
      '#!/bin/sh\nprintf x >> "$SEMANTIC_RUNTIME_CODEX_COUNT_PATH"\nprintf semantic-runtime-llm-ok\n',
    );
    fs.chmodSync(codex, 0o755);
    process.env.SEMANTIC_RUNTIME_LLM_PROVIDER = 'codex';
    process.env.SEMANTIC_RUNTIME_CODEX_BIN = codex;
    process.env.SEMANTIC_RUNTIME_CODEX_COUNT_PATH = codexCount;

    const operator = '0x1111111111111111111111111111111111111111';
    const graph = `did:dkg:context-graph:devnet-test/_verifiable_memory/${operator}/7`;
    const tool = 'urn:sr:tool:investigator-v1';
    const programIri = 'urn:sr:program:codex-persist';
    const policyIri = 'urn:sr:policy:operator-codex';
    const source = fs.readFileSync(
      new URL('../../semantic-runtime/smoke/llm-agent.scm', import.meta.url),
      'utf8',
    );
    const written: Array<{ subject: string; predicate: string; object: string }> = [];
    let finalized = false;
    let published = false;
    const history = vi.fn(async () => finalized ? {
      wmCurrentAssertion: '11'.repeat(32),
      ...(published ? {
        swmCurrentAssertion: '11'.repeat(32),
        vmCurrentAssertion: '11'.repeat(32),
        publishedUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/1',
      } : {}),
      state: published ? 'published' : 'finalized',
      events: [],
      contextGraphId: 'devnet-test',
      agentAddress: operator,
      name: 'semantic-execution',
      memoryLayer: null,
      assertionGraph: graph,
      status: 'wm-ahead',
    } : null);
    const agent = {
      getDefaultAgentAddress: () => operator,
      query: vi.fn(async (sparql: string) => {
        if (sparql.includes('?language')) return {
          type: 'bindings',
          bindings: [{
            language: '"sexpr-v1"',
            version: '"1.0.0"',
            source: JSON.stringify(source),
            tool: `<${tool}>`,
          }],
        };
        if (sparql.includes('usesExecutionPolicy')) return {
          type: 'bindings',
          bindings: [{ g: graph, policyVersion: '"1"', tool: `<${tool}>` }],
        };
        if (sparql.includes('offersTool')) return {
          type: 'bindings',
          bindings: [{
            g: graph,
            tool: `<${tool}>`,
            operation: '"agent/investigate"',
            toolVersion: '"1"',
            witInterface: '"origintrail:semantic-tools/investigator@1"',
          }],
        };
        return { type: 'bindings', bindings: [] };
      }),
      assertion: {
        history,
        create: vi.fn(async () => 'urn:test:assertion'),
        write: vi.fn(async (_cg: string, _name: string, quads: typeof written) => {
          written.push(...quads);
        }),
        finalize: vi.fn(async () => {
          finalized = true;
          return { merkleRoot: new Uint8Array(32), authorAddress: operator };
        }),
        promote: vi.fn(async () => ({
          promotedCount: written.length,
          sealed: true,
          publishReady: true,
          shareOperationId: 'share-1',
        })),
      },
      publishFromFinalizedAssertion: vi.fn(async () => {
        published = true;
        return {
          status: 'confirmed',
          ual: 'did:dkg:31337/0x2222222222222222222222222222222222222222/1',
          kaId: 1n,
          merkleRoot: new Uint8Array(32),
          kaManifest: [],
        };
      }),
    } as any;
    const config = {
      enabled: true,
      watchdogMs: 1_000,
      startupTimeoutMs: 30_000,
      operatorPolicyIri: policyIri,
    };
    const runtime = await startConfiguredSemanticRuntime(config, {
      log: vi.fn(),
      openStore: () => new SemanticRuntimeStore(':memory:'),
    });
    expect(runtime).not.toBeNull();
    try {
      const invoke = () => invokeStoredSemanticProgram(
        agent,
        runtime!,
        'devnet-test',
        programIri,
        '123e4567-e89b-42d3-a456-426614174000',
        config,
      );
      await expect(invoke()).resolves.toEqual({
        invocationId: '123e4567-e89b-42d3-a456-426614174000',
        executionIri: 'urn:sr:execution:123e4567-e89b-42d3-a456-426614174000',
        executionUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/1',
        persisted: true,
      });
      await expect(invoke()).resolves.toEqual({
        invocationId: '123e4567-e89b-42d3-a456-426614174000',
        executionIri: 'urn:sr:execution:123e4567-e89b-42d3-a456-426614174000',
        executionUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/1',
        persisted: true,
      });
      expect(fs.readFileSync(codexCount, 'utf8')).toBe('x');
    } finally {
      await runtime?.stop();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    const output = written.find((quad) => quad.predicate.endsWith('#output'));
    const outputHash = written.find((quad) => quad.predicate.endsWith('#outputHash'));
    const status = written.find((quad) => quad.predicate.endsWith('#status'));
    expect(output?.object).toBe('"semantic-runtime-llm-ok"');
    expect(outputHash?.object).toBe(
      '"sha256:04491f14f4f9a71e2a38f2ebdcbfa9b1d89c7d3661e5cb2cc0e803cf59a245d1"',
    );
    expect(status?.object).toBe('https://origintrail.io/semantic-runtime/v1#Succeeded');
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
  }, 60_000);
});
