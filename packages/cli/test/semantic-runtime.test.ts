import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  forkStoredSemanticProgram,
  invokeStoredSemanticProgram,
  loadStoredSemanticProgram,
  startConfiguredSemanticRuntime,
  validateSemanticRuntimeConfig,
} from '../src/semantic-runtime.js';
import { createDkgQueryAdapter } from '../src/semantic-runtime-query-adapter.js';

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
  it.each(['wm', 'swm', 'vm'] as const)(
    'forks a VM Program into a %s KA authored by the copying wallet',
    async (targetLayer) => {
    const author = '0x1111111111111111111111111111111111111111';
    const copier = '0x2222222222222222222222222222222222222222';
    const contextGraphId = `${copier}/private-programs`;
    const sourceProgramIri = 'urn:sr:program:original';
    const newProgramIri = 'urn:sr:program:my-copy';
    const source = '(strategy fork-me)';
    const tool = 'urn:sr:tool:investigator-v1';
    const written: Array<{ subject: string; predicate: string; object: string }> = [];
    let finalized = false;
    const agent = {
      getContextGraphOwner: vi.fn(async () => `did:dkg:agent:${copier}`),
      curatorDidMatchesChecksumAgent: vi.fn((owner: string, caller: string) =>
        owner.toLowerCase() === `did:dkg:agent:${caller}`.toLowerCase()),
      callerIsAllowlistedAgentParticipant: vi.fn(async () => false),
      refreshMetaFromCurator: vi.fn(async () => false),
      listLocalAgents: () => [{ agentAddress: copier }],
      getCustodialAgentPrivateKey: () => '0x02',
      query: vi.fn(async (sparql: string) => sparql.includes('?language') ? {
        type: 'bindings',
        bindings: [{
          g: `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/${author}/7`,
          language: '"sexpr-v1"',
          version: '"1.0.0"',
          source: JSON.stringify(source),
          tool: `<${tool}>`,
        }],
      } : { type: 'bindings', bindings: [] }),
      assertion: {
        history: vi.fn(async () => finalized ? {
          wmCurrentAssertion: '11'.repeat(32),
          state: 'finalized',
        } : null),
        create: vi.fn(async () => 'urn:test:fork-assertion'),
        write: vi.fn(async (_cg: string, _name: string, quads: typeof written) => {
          written.push(...quads);
        }),
        finalize: vi.fn(async () => {
          finalized = true;
          return { merkleRoot: new Uint8Array(32), authorAddress: copier };
        }),
        promote: vi.fn(async () => ({
          promotedCount: written.length,
          sealed: true,
          publishReady: true,
        })),
      },
      publishFromFinalizedAssertion: vi.fn(async () => ({
        status: 'confirmed',
        ual: 'did:dkg:31337/0x2222222222222222222222222222222222222222/9',
      })),
    } as any;

    await expect(forkStoredSemanticProgram(
      agent,
      contextGraphId,
      sourceProgramIri,
      newProgramIri,
      'vm',
      targetLayer,
      copier,
    )).resolves.toEqual({
      programIri: newProgramIri,
      programLayer: targetLayer,
      ...(targetLayer === 'vm' ? {
        programUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/9',
      } : {}),
      authorAgentAddress: copier,
      derivedFrom: sourceProgramIri,
      persisted: true,
    });
    expect(written).toEqual(expect.arrayContaining([
      { subject: newProgramIri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://origintrail.io/semantic-runtime/v1#Program' },
      { subject: newProgramIri, predicate: 'https://origintrail.io/semantic-runtime/v1#source', object: JSON.stringify(source) },
      { subject: newProgramIri, predicate: 'https://origintrail.io/semantic-runtime/v1#requiresTool', object: tool },
      { subject: newProgramIri, predicate: 'http://www.w3.org/ns/prov#wasDerivedFrom', object: sourceProgramIri },
    ]));
    expect(agent.assertion.create).toHaveBeenCalledWith(
      contextGraphId,
      expect.stringMatching(/^semantic-program-fork-[0-9a-f]{24}$/),
      { agentAddress: copier },
    );
    expect(agent.assertion.promote).toHaveBeenCalledTimes(targetLayer === 'wm' ? 0 : 1);
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledTimes(targetLayer === 'vm' ? 1 : 0);
  });

  it('resolves and executes a saved query only inside the invocation Context Graph', async () => {
    const savedSparql = 'SELECT ?value WHERE { VALUES ?value { "query-ok" } }';
    const query = vi.fn(async (_sparql: string, options: Record<string, unknown>) => {
      if (options.source === 'semantic-runtime-query-catalog') {
        return options.view === 'verifiable-memory' ? {
          type: 'bindings',
          bindings: [{
            q: 'urn:dkg:profile:devnet-test:query:configuration-trace',
            scopeGraph: 'did:dkg:context-graph:devnet-test/network',
            catalog: 'urn:dkg:profile:devnet-test:catalog:operations',
            name: 'Configuration trace',
            sparql: savedSparql,
            executionView: 'verifiable-memory',
            catalogName: 'Operations',
          }],
        } : { type: 'bindings', bindings: [] };
      }
      return { type: 'bindings', bindings: [{ value: '"query-ok"' }] };
    });
    const agent = {
      canReadContextGraph: vi.fn(async () => true),
      query,
      store: { query: vi.fn(async () => ({ type: 'bindings', bindings: [] })) },
    } as any;
    const adapter = createDkgQueryAdapter(agent, 'devnet-test', '0xreader');
    const result = await adapter.dispatch({} as any, {
      selector: 'configuration-trace',
    });
    expect(result.output).toBe(
      '{"queryIri":"urn:dkg:profile:devnet-test:query:configuration-trace",'
      + '"result":{"bindings":[{"value":"\\"query-ok\\""}],"type":"bindings"}}',
    );
    expect(agent.canReadContextGraph).toHaveBeenCalledWith('devnet-test', {
      callerAgentAddress: '0xreader',
    });
    expect(query).toHaveBeenCalledWith(savedSparql, {
      contextGraphId: 'devnet-test',
      source: 'semantic-runtime-dkg-query',
      subGraphName: 'network',
      view: 'verifiable-memory',
      callerAgentAddress: '0xreader',
    });
  });

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

  it.each([
    ['wm', '_working_memory', 'working-memory'],
    ['swm', '_shared_memory', 'shared-working-memory'],
    ['vm', '_verifiable_memory', 'verifiable-memory'],
  ] as const)('loads an S-expression program only from the requested %s graph', async (
    layer,
    directory,
    view,
  ) => {
    const source = '(strategy demo)';
    const author = '0x1111111111111111111111111111111111111111';
    const query = vi.fn().mockResolvedValue({
      type: 'bindings',
      bindings: [{
        g: `did:dkg:context-graph:devnet-test/${directory}/${author}/7`,
        language: '"sexpr-v1"',
        version: '"1.0.0"',
        source: JSON.stringify(source),
      }],
    });

    await expect(loadStoredSemanticProgram(
      { query } as any,
      'devnet-test',
      'urn:sr:program:demo',
      layer,
    )).resolves.toEqual({
      contextGraphId: 'devnet-test',
      programIri: 'urn:sr:program:demo',
      layer,
      authorAgentAddress: author,
      language: 'sexpr-v1',
      version: '1.0.0',
      source,
      requiredTools: [],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('<urn:sr:program:demo>'), {
      contextGraphId: 'devnet-test',
      view,
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
    const author = '0x1111111111111111111111111111111111111111';
    const agent = {
      query: vi.fn(async () => ({
        type: 'bindings',
        bindings: [{
          g: `did:dkg:context-graph:devnet-test/_verifiable_memory/${author}/7`,
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
        'vm',
        'vm',
        { enabled: true, operatorPolicyIri: 'urn:sr:policy:operator' },
      )).rejects.toMatchObject({ code: 'PROGRAM_REJECTED', status: 422 });
      expect(startPlan).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });

  it.each(['wm', 'swm', 'vm'] as const)(
    'persists the exact Wasm-resumed Codex output and SHA-256 in %s before succeeding',
    async (executionLayer) => {
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
    let promoted = false;
    let published = false;
    const history = vi.fn(async () => finalized ? {
      wmCurrentAssertion: '11'.repeat(32),
      ...((promoted || published) ? {
        swmCurrentAssertion: '11'.repeat(32),
      } : {}),
      ...(published ? {
        vmCurrentAssertion: '11'.repeat(32),
        publishedUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/1',
      } : {}),
      state: published ? 'published' : 'finalized',
      events: [],
      contextGraphId: 'devnet-test',
      agentAddress: operator,
      name: 'semantic-execution',
      memoryLayer: published ? 'VM' : promoted ? 'SWM' : 'WM',
      assertionGraph: graph,
      status: 'wm-ahead',
    } : null);
    const agent = {
      getDefaultAgentAddress: () => operator,
      listLocalAgents: () => [{ agentAddress: operator }],
      getCustodialAgentPrivateKey: () => '0x01',
      query: vi.fn(async (sparql: string) => {
        if (sparql.includes('?language')) return {
          type: 'bindings',
          bindings: [{
            g: graph,
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
        promote: vi.fn(async () => {
          promoted = true;
          return {
            promotedCount: written.length,
            sealed: true,
            publishReady: true,
            shareOperationId: 'share-1',
          };
        }),
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
        'vm',
        executionLayer,
        config,
      );
      await expect(invoke()).resolves.toEqual({
        invocationId: '123e4567-e89b-42d3-a456-426614174000',
        executionIri: 'urn:sr:execution:123e4567-e89b-42d3-a456-426614174000',
        executionLayer,
        ...(executionLayer === 'vm' ? {
          executionUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/1',
        } : {}),
        persisted: true,
      });
      await expect(invoke()).resolves.toEqual({
        invocationId: '123e4567-e89b-42d3-a456-426614174000',
        executionIri: 'urn:sr:execution:123e4567-e89b-42d3-a456-426614174000',
        executionLayer,
        ...(executionLayer === 'vm' ? {
          executionUal: 'did:dkg:31337/0x2222222222222222222222222222222222222222/1',
        } : {}),
        persisted: true,
      });
      await expect(invokeStoredSemanticProgram(
        agent,
        runtime!,
        'devnet-test',
        programIri,
        '123e4567-e89b-42d3-a456-426614174000',
        'vm',
        executionLayer === 'wm' ? 'vm' : 'wm',
        config,
      )).rejects.toMatchObject({ code: 'INVOCATION_LAYER_CONFLICT', status: 409 });
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
    expect(agent.assertion.promote).toHaveBeenCalledTimes(executionLayer === 'wm' ? 0 : 1);
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledTimes(executionLayer === 'vm' ? 1 : 0);
  }, 60_000);
});
