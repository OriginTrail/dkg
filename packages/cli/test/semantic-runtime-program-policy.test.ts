import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';
import { decodeQueryCatalogBindings } from '@origintrail-official/dkg-core/query-catalog';
import type { SemanticProgramPolicy } from '@origintrail-official/dkg-semantic-runtime';
import { describe, expect, it, vi } from 'vitest';

import { assertSemanticPrompt, projectSemanticOutput, validateSemanticProgramPolicy } from '../src/semantic-runtime-program-policy.js';

import { invokeStoredSemanticProgram, startConfiguredSemanticRuntime } from '../src/semantic-runtime.js';
import { createSemanticQueryPin } from '../src/semantic-runtime-query-pins.js';
import { readContextGraphQueryCatalogBindings } from '../src/daemon/query-catalog-service.js';

vi.mock('../src/daemon/query-catalog-service.js', () => ({ readContextGraphQueryCatalogBindings: vi.fn() }));

const sourceHash = 'a'.repeat(64);
const program = { capabilityId: 'opaque', programIri: 'urn:program:read', sourceHash, name: 'read', description: '' };
function policy(): SemanticProgramPolicy {
  return {
    contextGraphIds: ['tenant'], programs: [{ programIri: program.programIri, sourceHash }],
    disclosure: { policyId: 'urn:policy:release',
      promptSha256s: [createHash('sha256').update('approved prompt').digest('hex')],
      programs: [{ programIri: program.programIri, sourceHash, outputIndexes: [1], allowedJsonPointers: ['/count'] }],
    },
  };
}
const result = (outputs: string[]) => ({ persisted: true as const, executionIri: 'urn:private:execution', outputs });

describe('operator-owned Program disclosure policy', () => {
  it('supports read-only operation without granting model disclosure', () => {
    const config = policy(); delete config.disclosure;
    expect(() => validateSemanticProgramPolicy(config)).not.toThrow();
  });

  it('binds model prompts to an exact reviewed digest', () => {
    expect(() => assertSemanticPrompt(policy().disclosure!, 'approved prompt')).not.toThrow();
    expect(() => assertSemanticPrompt(policy().disclosure!, 'approved prompt plus private data')).toThrow('SEMANTIC_PROMPT_NOT_PINNED');
  });

  it('releases only selected scalar fields, without siblings, other outputs or execution identifiers', () => {
    const output = projectSemanticOutput(policy().disclosure!, program,
      result(['private first output', JSON.stringify({ count: 3, secret: 'private value' })]));
    expect(JSON.parse(output)).toEqual({ outputs: [{ '/count': 3 }] });
    expect(output).not.toContain('private');
  });

  it.each([
    ['{}'], ['unused', '{"count":{"private":"nested secret"}}'],
    ['unused', '{"count":[1,2]}'], ['unused', '{"different":3}'], ['unused', 'invalid json'],
  ])('refuses absent outputs, changed shapes and unselected containers: %j', (...outputs) => {
    expect(() => projectSemanticOutput(policy().disclosure!, program, result(outputs))).toThrow('SEMANTIC_OUTPUT_RELEASE_DENIED');
  });

  it('refuses a changed child source and oversized releases', () => {
    expect(() => projectSemanticOutput(policy().disclosure!, { ...program, sourceHash: 'b'.repeat(64) }, result(['unused', '{"count":3}'])))
      .toThrow('SEMANTIC_OUTPUT_RELEASE_DENIED');
    const config = policy(); delete config.disclosure!.programs[0].allowedJsonPointers;
    expect(() => projectSemanticOutput(config.disclosure!, program, result(['unused', 'x'.repeat(65536)])))
      .toThrow('SEMANTIC_RELEASE_TOO_LARGE');
  });

  it.each(['/__proto__/secret', '/constructor', '/prototype', '/bad~2pointer', ''])('rejects unsafe pointer %s', (pointer) => {
    const config = policy(); config.disclosure!.programs[0].allowedJsonPointers = [pointer];
    expect(() => validateSemanticProgramPolicy(config)).toThrow('INVALID_SEMANTIC_OUTPUT_PROJECTION');
  });

  it('rejects unpinned release programs and duplicate positions', () => {
    const config = policy(); config.disclosure!.programs[0].sourceHash = 'b'.repeat(64);
    expect(() => validateSemanticProgramPolicy(config)).toThrow('INVALID_SEMANTIC_OUTPUT_PROJECTION');
    config.disclosure!.programs[0].sourceHash = sourceHash;
    config.disclosure!.programs[0].outputIndexes = [1, 1];
    expect(() => validateSemanticProgramPolicy(config)).toThrow('INVALID_SEMANTIC_OUTPUT_PROJECTION');
  });
});


describe('pinned local Program composition', () => {
  it('keeps the original caller through a real Wasm parent and child and releases only the selected field', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-pinned-composition-'));
    const binary = path.join(temporary, 'runner.mjs');
    fs.writeFileSync(binary, `#!${process.execPath}
import {createInterface} from 'node:readline';
let first = true;
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  const reply = first ? {type:'call',id:1,capabilityId:message.tools[0].capabilityId}
    : {type:'complete',output:JSON.stringify(message)};
  first = false;
  process.stdout.write(JSON.stringify(reply)+'\\n');
});
`);
    fs.chmodSync(binary, 0o755);
    vi.stubEnv('SEMANTIC_RUNTIME_RIG_BIN', binary);
    const operator = '0x1111111111111111111111111111111111111111';
    const caller = '0x2222222222222222222222222222222222222222';
    const graph = `did:dkg:context-graph:tenant/_verifiable_memory/${operator}/7`;
    const parentIri = 'urn:program:assessment'; const childIri = 'urn:program:count';
    const parentSource = `(strategy assessment (version "1.0.0") (scope network:devnet) (goal assess)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (delegate assistant (grant llm.invoke.safe) (call llm/safe@1 "approved"))))`;
    const childSource = `(strategy count (version "1.0.0") (scope network:devnet) (goal count)
      (supervise one-for-one (max-restarts 1) (window-ms 60000)
        (delegate reader (grant dkg.query) (call dkg/query@1 "maintenance-count"))))`;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const rows = [{ q: 'urn:dkg:profile:tenant:query:maintenance-count', name: 'Count',
      scopeGraph: 'did:dkg:context-graph:tenant/equipment', catalog: 'urn:dkg:profile:tenant:catalog:maintenance',
      catalogName: 'Maintenance', sparql: 'SELECT (COUNT(?s) AS ?total) WHERE { ?s ?p ?o }', executionView: 'verifiable-memory' }];
    vi.mocked(readContextGraphQueryCatalogBindings).mockResolvedValue(rows);
    const pin = createSemanticQueryPin('maintenance-count', decodeQueryCatalogBindings(rows, { contextGraphId: 'tenant' })[0], {
      type: 'object', additionalProperties: false, required: ['bindings'], properties: { bindings: {
        type: 'array', maxItems: 1, items: { type: 'object', additionalProperties: false, required: ['total'],
          properties: { total: { type: 'integer', minimum: 0 } } },
      } },
    });
    const toolRows = [
      { tool: '<urn:tool:safe>', operation: '"llm/safe"', witInterface: '"origintrail:semantic-runtime/safe-llm@0.1.0"' },
      { tool: '<urn:tool:query>', operation: '"dkg/query"', witInterface: '"origintrail:semantic-runtime/query-catalog@0.1.0"' },
    ].map(row => ({ ...row, g: graph, policyVersion: '"1"', toolVersion: '"1"' }));
    const finalized = new Set<string>();
    const agent = {
      canReadContextGraph: vi.fn(async () => true),
      listLocalAgents: () => [{ agentAddress: operator }], getCustodialAgentPrivateKey: () => '0x01',
      query: vi.fn(async (sparql: string, options: { source: string }) => {
        if (options.source === 'semantic-runtime-program-load') {
          const parent = sparql.includes(`<${parentIri}>`);
          return { bindings: [{ g: graph, language: '"sexpr-v1"', version: '"1.0.0"',
            source: JSON.stringify(parent ? parentSource : childSource), tool: parent ? '<urn:tool:safe>' : '<urn:tool:query>',
            ...(parent ? { permittedProgram: `<${childIri}>` } : {}),
          }] };
        }
        if (sparql.includes('usesExecutionPolicy') || sparql.includes('offersTool')) return { bindings: toolRows };
        if (options.source === 'semantic-runtime-dkg-query') return { bindings: [{ total: 3 }] };
        return { bindings: [] };
      }),
      assertion: {
        history: vi.fn(async (_cg: string, name: string) => finalized.has(name) ? { wmCurrentAssertion: '11'.repeat(32), state: 'finalized' } : null),
        create: vi.fn(async () => 'urn:assertion'), write: vi.fn(async () => {}),
        finalize: vi.fn(async (_cg: string, name: string) => { finalized.add(name); }),
      },
    } as any;
    const config = { enabled: true, startupTimeoutMs: 30_000, watchdogMs: 1_000, operatorPolicyIri: 'urn:policy:operator',
      programPolicy: { contextGraphIds: ['tenant'], programs: [
        { programIri: parentIri, sourceHash: hash(parentSource) },
        { programIri: childIri, sourceHash: hash(childSource), queries: [pin] },
      ], disclosure: { policyId: 'release', promptSha256s: [hash('approved')], programs: [{
        programIri: childIri, sourceHash: hash(childSource), outputIndexes: [0], allowedJsonPointers: ['/result/bindings/0/total'],
      }] } },
    };
    const runtime = await startConfiguredSemanticRuntime(config, { log: vi.fn(), openStore: () => new SemanticRuntimeStore(':memory:') });
    const suppliedTransport = vi.fn();
    try {
      const response = await invokeStoredSemanticProgram(agent, runtime!, 'tenant', parentIri,
        '123e4567-e89b-42d3-a456-426614174111', 'vm', 'wm', config,
        { baseURL: 'http://127.0.0.1:12345/v1', model: 'fixture' } as any, caller, undefined, suppliedTransport);
      const modelToolResult = JSON.parse(response.outputs![0]);
      expect(modelToolResult.ok).toBe(true);
      expect(JSON.parse(modelToolResult.output)).toEqual({ outputs: [{ '/result/bindings/0/total': 3 }] });
      expect(suppliedTransport).not.toHaveBeenCalled();
      expect(agent.assertion.write).toHaveBeenCalledTimes(2);
      expect(agent.query.mock.calls.filter(([, options]: any[]) => options.source === 'semantic-runtime-dkg-query'))
        .toEqual([[rows[0].sparql, expect.objectContaining({ callerAgentAddress: caller })]]);
      expect(agent.canReadContextGraph.mock.calls.every(([, options]: any[]) => options.callerAgentAddress === caller)).toBe(true);
    } finally {
      await runtime?.stop(); vi.unstubAllEnvs(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 60_000);
});
