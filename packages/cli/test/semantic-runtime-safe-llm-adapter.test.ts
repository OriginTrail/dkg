import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSafeLlmAdapter } from '../src/semantic-runtime-safe-llm-adapter.js';

const servers: Array<ReturnType<typeof createServer>> = [];
const fixtureDirectories: string[] = [];

beforeEach(() => {
  for (const name of ['DKG_LLM_URL', 'LLAMA_URL', 'DKG_LLM_API_KEY', 'DKG_LLM_MODEL', 'LLAMA_MODEL', 'SEMANTIC_RUNTIME_RIG_BIN']) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  for (const directory of fixtureDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const opaqueProgram = {
  capabilityId: 'opaque-capability', programIri: 'urn:sr:program:private',
  name: 'program_0123456789abcdef', description: 'Read the permitted value.',
};

/** A real subprocess speaking the runner protocol, with no model or network. */
function fixtureRunner(onLine: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-rig-protocol-'));
  fixtureDirectories.push(directory);
  const binary = path.join(directory, 'runner.mjs');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nconst send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');\nconst lines = createInterface({input:process.stdin});\nlet request;\nlines.on('line', (line) => { const message=JSON.parse(line); ${onLine} });\n`);
  fs.chmodSync(binary, 0o755);
  vi.stubEnv('SEMANTIC_RUNTIME_RIG_BIN', binary);
  vi.stubEnv('DKG_LLM_URL', 'http://127.0.0.1:12345/v1/chat/completions');
  return binary;
}

function completeFixture() {
  return fixtureRunner('send({type:"complete",output:"fixture-ok"});');
}

describe('safe LLM Rig adapter', () => {
  it('projects disclosure and hides raw errors, identifiers and graph descriptions from the runner', async () => {
    fixtureRunner(`
      if (!request) { request = message; send({type:'call',id:1,capabilityId:'opaque-capability'}); }
      else { send({type:'complete',output:JSON.stringify({request,result:message})}); }
    `);
    const program = { ...opaqueProgram, sourceHash: 'a'.repeat(64), description: 'PRIVATE-DESCRIPTION' };
    const policy = { policyId: 'release', promptSha256s: [createHash('sha256').update('approved').digest('hex')],
      programs: [{ programIri: program.programIri, sourceHash: program.sourceHash, outputIndexes: [0], allowedJsonPointers: ['/count'] }] };
    const assertAuthorized = vi.fn(async () => {});
    const invokeChild = vi.fn(async () => ({ persisted: true as const, executionIri: 'PRIVATE-EXECUTION',
      outputs: ['{"count":2,"secret":"PRIVATE-SECRET"}'] }));
    const adapter = createSafeLlmAdapter(undefined, [program], invokeChild, { policy, assertAuthorized });
    const response = await adapter.dispatch({ effectId: 'effect' } as any, { prompt: 'approved' });
    const runner = JSON.parse(JSON.parse(response.output).output);
    expect(JSON.parse(runner.result.output)).toEqual({ outputs: [{ '/count': 2 }] });
    expect(JSON.stringify(runner)).not.toContain('PRIVATE-');
    expect(assertAuthorized).toHaveBeenCalledTimes(3);
    await expect(adapter.dispatch({ effectId: 'effect' } as any, { prompt: 'private unapproved prompt' }))
      .rejects.toThrow('SEMANTIC_PROMPT_NOT_PINNED');
    expect(invokeChild).toHaveBeenCalledTimes(1);
  });

  it('rechecks authority after the child finishes and releases no child data after revocation', async () => {
    fixtureRunner(`
      if (!request) { request = message; send({type:'call',id:1,capabilityId:'opaque-capability'}); }
      else { send({type:'complete',output:JSON.stringify(message)}); }
    `);
    const program = { ...opaqueProgram, sourceHash: 'a'.repeat(64) };
    const policy = { policyId: 'release', promptSha256s: [createHash('sha256').update('approved').digest('hex')],
      programs: [{ programIri: program.programIri, sourceHash: program.sourceHash, outputIndexes: [0] }] };
    let revoked = false;
    const adapter = createSafeLlmAdapter(undefined, [program], async () => {
      revoked = true;
      return { persisted: true, executionIri: 'PRIVATE-EXECUTION', outputs: ['PRIVATE-OUTPUT'] };
    }, { policy, assertAuthorized: async () => { if (revoked) throw new Error('PRIVATE-REVOCATION-DETAIL'); } });
    const response = await adapter.dispatch({ effectId: 'effect' } as any, { prompt: 'approved' });
    const runner = JSON.parse(response.output).output;
    expect(runner).toContain('program result unavailable');
    expect(runner).not.toContain('PRIVATE-');
  });

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

  it.each([null, {}, { prompt: '' }, { prompt: 1 }, { prompt: 'x'.repeat(65_537) }])(
    'rejects malformed or excessive prompts before starting a model', (input) => {
      const adapter = createSafeLlmAdapter(undefined, [], vi.fn());
      expect(() => adapter.validateInput(input)).toThrow('INVALID_SAFE_LLM_ARGUMENT');
      expect(adapter.validateInput({ prompt: 'bounded' })).toEqual({ prompt: 'bounded' });
    },
  );

  it.each(['not a URL', 'file:///tmp/model', 'http://user:password@localhost/v1', 'https://models.example/v1'])(
    'refuses invalid, credential-bearing, or keyless remote providers: %s', (baseURL) => {
      completeFixture();
      const adapter = createSafeLlmAdapter({ apiKey: '', model: '', baseURL }, [opaqueProgram], vi.fn());
      expect(adapter.enabled()).toBe(false);
    },
  );

  it('requires a configured provider, installed runner, bounded tool set, and child dispatcher', async () => {
    vi.stubEnv('SEMANTIC_RUNTIME_RIG_BIN', '/missing-semantic-rig-runner');
    const missing = createSafeLlmAdapter(undefined, [opaqueProgram], vi.fn());
    expect(missing.enabled()).toBe(false);
    await expect(missing.dispatch({} as any, { prompt: 'test' })).rejects.toThrow('SAFE_LLM_NOT_CONFIGURED');
    completeFixture();
    expect(createSafeLlmAdapter(undefined, []).enabled()).toBe(false);
    expect(createSafeLlmAdapter(undefined, Array(33).fill(opaqueProgram)).enabled()).toBe(false);
    await expect(createSafeLlmAdapter(undefined, [opaqueProgram]).dispatch({} as any, { prompt: 'test' }))
      .rejects.toThrow('SAFE_LLM_NOT_CONFIGURED');
  });

  it('passes only the provider credential and opaque tools into the subprocess', async () => {
    fixtureRunner('send({type:"complete", output:JSON.stringify({request:message, env:process.env})});');
    vi.stubEnv('SEMANTIC_RUNTIME_TEST_SECRET', 'must-not-reach-runner');
    const adapter = createSafeLlmAdapter({ apiKey: 'provider-test-key', model: 'selected-model', baseURL: 'https://models.example/v1/chat/completions?secret=ignored#ignored' }, [opaqueProgram], vi.fn());
    const result = await adapter.dispatch({ effectId: 'effect-one' } as any, { prompt: 'test' });
    const observed = JSON.parse(JSON.parse(result.output!).output);
    expect(observed.env.OPENAI_API_KEY).toBe('provider-test-key');
    expect(observed.env.SEMANTIC_RUNTIME_TEST_SECRET).toBeUndefined();
    expect(observed.env.HOME).toBeUndefined();
    expect(observed.env.PATH).toBeUndefined();
    expect(observed.request).toMatchObject({ baseUrl: 'https://models.example/v1', model: 'selected-model', maxTurns: 4, maxTokens: 512 });
    expect(observed.request.tools).toEqual([{ capabilityId: opaqueProgram.capabilityId, name: opaqueProgram.name, description: opaqueProgram.description }]);
    expect(JSON.stringify(observed.request)).not.toContain(opaqueProgram.programIri);
    await expect(adapter.reconcile({} as any)).resolves.toMatchObject({ status: 'unknown' });
    expect(adapter.couldHaveReachedTarget(new Error('SAFE_LLM_NOT_CONFIGURED'))).toBe(false);
    expect(adapter.couldHaveReachedTarget(new Error('INVALID_SAFE_LLM_ARGUMENT'))).toBe(false);
    expect(adapter.couldHaveReachedTarget(new Error('lost response'))).toBe(true);
    expect(adapter.couldHaveReachedTarget('unknown failure')).toBe(true);
  });

  it.each([
    ['process.stdout.write("not-json\\n");', 'SAFE_LLM_RUNNER_PROTOCOL_INVALID'],
    ['send({type:"call",id:1.5,capabilityId:"opaque-capability"});', 'SAFE_LLM_RUNNER_PROTOCOL_INVALID'],
    ['send({type:"error",message:"provider rejected"});', 'SAFE_LLM_RUNNER_FAILED:provider rejected'],
    ['process.stdout.write("x".repeat(1048577)+"\\n");', 'SAFE_LLM_RUNNER_MESSAGE_TOO_LARGE'],
    ['process.stderr.write("fixture exited"); process.exit(7);', 'SAFE_LLM_RUNNER_EXITED:fixture exited'],
  ])('rejects malformed or failed runner output', async (script, expected) => {
    fixtureRunner(script);
    const invoke = vi.fn();
    const adapter = createSafeLlmAdapter(undefined, [opaqueProgram], invoke);
    await expect(adapter.dispatch({ effectId: 'protocol-failure' } as any, { prompt: 'test' })).rejects.toThrow(expected);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects unknown capabilities and calls above the four-call budget', async () => {
    fixtureRunner(`
      if (!request) { request={responses:[]}; send({type:'call',id:0,capabilityId:'unknown'}); return; }
      request.responses.push(message);
      if (message.id < 5) send({type:'call',id:message.id+1,capabilityId:'opaque-capability'});
      else send({type:'complete',output:JSON.stringify(request.responses)});
    `);
    const invoke = vi.fn(async () => ({ executionIri: 'urn:execution:child', executionUal: 'did:dkg:child', outputs: ['persisted-value'], persisted: true as const }));
    const adapter = createSafeLlmAdapter(undefined, [opaqueProgram], invoke);
    const result = JSON.parse((await adapter.dispatch({ effectId: 'effect-budget' } as any, { prompt: 'test' })).output!);
    const responses = JSON.parse(result.output);
    expect(responses.map((response: any) => response.ok)).toEqual([false, true, true, true, false, false]);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.childExecutions).toEqual(Array(3).fill('urn:execution:child'));
    expect(new Set(invoke.mock.calls.map((call) => call[1])).size).toBe(3);
    expect(JSON.parse(responses[1].output)).toEqual({ executionIri: 'urn:execution:child', executionUal: 'did:dkg:child', outputs: ['persisted-value'] });
  });

  it.each([
    [async () => ({ executionIri: 'urn:execution:child', persisted: true }), 'child Execution output was not persisted'],
    [async () => { throw new Error('child persistence failed'); }, 'child persistence failed'],
    [async () => { throw 'child unavailable'; }, 'child unavailable'],
  ])('reports failed or unpersisted child calls to the runner without recording receipt evidence', async (invoke, expected) => {
    fixtureRunner(`
      if (!request) { request=message; send({type:'call',id:1,capabilityId:'opaque-capability'}); }
      else send({type:'complete',output:JSON.stringify(message)});
    `);
    const adapter = createSafeLlmAdapter(undefined, [opaqueProgram], invoke as any);
    const result = JSON.parse((await adapter.dispatch({ effectId: 'effect-child-error' } as any, { prompt: 'test' })).output!);
    expect(JSON.parse(result.output)).toEqual({ type: 'result', id: 1, ok: false, error: expected });
    expect(result.childExecutions).toEqual([]);
  });
});
