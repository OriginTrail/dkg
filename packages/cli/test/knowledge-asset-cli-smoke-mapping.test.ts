import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { join } from 'node:path';
import { ApiClient } from '../src/api-client.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';
import {
  PENDING_OBLIGATION,
  openSmokeEnvironment,
  runCli,
  testInvocation,
  type SmokeCall,
  type SmokeEnvironment,
} from './knowledge-asset-cli-smoke-harness.js';

// How create, share, publish and pull-from map CLI input into daemon request
// bodies, and how they report partial, no-op and confirmed-obligation
// responses. The stub daemon, fixtures and CLI runner are shared in
// knowledge-asset-cli-smoke-harness.ts.
describe.sequential('knowledge-asset CLI smoke', () => {
  let dkgHome: string;
  let smokeApiPort: string;
  let calls: SmokeCall[] = [];
  let smoke: SmokeEnvironment | undefined;

  beforeAll(async () => {
    smoke = await openSmokeEnvironment((call) => { calls.push(call); });
    ({ dkgHome, port: smokeApiPort } = smoke);
  });

  afterAll(async () => {
    await smoke?.close();
  });

  it('maps file-backed one-shot create/share into the KA lifecycle request body', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    const created = await runCli([
      'ka',
      'create',
      'paper-file',
      '--context-graph-id',
      'research',
      '--input-file',
      join(dkgHome, 'paper.nt'),
      '--share',
    ], invocation);

    expect(created.stdout).toContain('Parsed 1 quad(s)');
    expect(created.stdout).toContain('Knowledge asset create complete:');

    const createCall = calls.find((call) => call.url === '/api/knowledge-assets');
    expect(createCall?.body).toMatchObject({
      contextGraphId: 'research',
      name: 'paper-file',
      alsoShareSwm: true,
    });
    expect(createCall?.body.alsoPublishVm).toBeUndefined();
    expect(createCall?.body.quads).toEqual([
      expect.objectContaining({
        subject: 'urn:company:acme',
        predicate: 'http://schema.org/name',
        object: '"Acme"',
        graph: '',
      }),
    ]);
  }, 30000);

  it('preserves named-graph JSON-LD in a WM-only create', async () => {
    calls = [];
    await runCli([
      'ka', 'create', 'named', '-c', 'research', '-f', join(dkgHome, 'named.jsonld'),
      '--no-finalize',
    ], testInvocation(dkgHome, smokeApiPort));
    expect(calls.find((call) => call.url === '/api/knowledge-assets')?.body).toMatchObject({
      finalize: false,
      quads: [{ subject: 'urn:company:named', predicate: 'http://schema.org/name',
        object: '"Named"', graph: 'urn:graph:named' }],
    });
  }, 30000);

  it('still submits legacy JSON-LD named-graph quad arrays for default-finalizing create', async () => {
    calls = [];
    await runCli([
      'ka', 'create', 'legacy', '-c', 'research', '-f', join(dkgHome, 'legacy.jsonld'),
    ], testInvocation(dkgHome, smokeApiPort));
    const body = calls.find((call) => call.url === '/api/knowledge-assets')?.body;
    expect(body?.finalize).toBeUndefined();
    expect(body?.quads).toEqual([{
      subject: 'urn:company:legacy', predicate: 'http://schema.org/name',
      object: '"Legacy"', graph: 'urn:graph:legacy',
    }]);
  }, 30000);

  it('preserves named graph metadata when the first parsed quad is default graph', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    await runCli([
      'ka',
      'create',
      'paper-graphs',
      '--context-graph-id',
      'research',
      '--input-file',
      join(dkgHome, 'mixed-graphs.nq'),
      '--no-finalize',
    ], invocation);

    const createCall = calls.find((call) => call.url === '/api/knowledge-assets');
    expect(createCall?.body.quads).toEqual([
      {
        subject: 'urn:company:default',
        predicate: 'http://schema.org/name',
        object: '"Default"',
        graph: '',
      },
      {
        subject: 'urn:company:named',
        predicate: 'http://schema.org/name',
        object: '"Named"',
        graph: 'urn:graph:named',
      },
    ]);
  }, 30000);

  it('treats an idempotent zero-promote one-shot create/share as successful no-op guidance', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    const created = await runCli([
      'ka',
      'create',
      'already-shared-create',
      '-c',
      'research',
      '--input-file',
      join(dkgHome, 'paper.nt'),
      '--share',
    ], invocation);

    expect(created.stdout).toContain('Knowledge asset create complete:');
    expect(created.stdout).toContain('No new triples promoted');
    expect(calls.find((call) => call.url === '/api/knowledge-assets')?.body)
      .toMatchObject({ name: 'already-shared-create', alsoShareSwm: true });
  }, 30000);

  it('forwards valid pricing policy and rejects invalid policy before daemon requests', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    await runCli([
      'ka', 'publish', 'paper', '-c', 'research',
      '--pricing-policy', 'full-content',
    ], invocation);
    await runCli([
      'ka', 'publish-async', 'paper', '-c', 'research',
      '--pricing-policy', 'full-content',
    ], invocation);

    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish')?.body)
      .toMatchObject({ options: { pricingPolicy: 'full-content' } });
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish-async')?.body)
      .toMatchObject({ options: { pricingPolicy: 'full-content' } });

    calls = [];
    await expect(runCli([
      'ka', 'publish', 'paper', '-c', 'research',
      '--pricing-policy', 'caller-reported',
    ], invocation)).rejects.toMatchObject({
      stderr: expect.stringContaining('--pricing-policy must be "full-content" when supplied'),
    });
    expect(calls).toEqual([]);

    await expect(runCli([
      'ka', 'publish-async', 'paper', '-c', 'research',
      '--pricing-policy', 'caller-reported',
    ], invocation)).rejects.toMatchObject({
      stderr: expect.stringContaining('--pricing-policy must be "full-content" when supplied'),
    });
    expect(calls).toEqual([]);
  }, 60000);

  it('treats an idempotent zero-promote sync share as successful no-op guidance', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    const shared = await runCli(['ka', 'share', 'paper', '-c', 'already-shared'], invocation);

    expect(shared.stdout).toContain('Knowledge asset shared to SWM:');
    expect(shared.stdout).toContain('Triples:        0');
    expect(shared.stdout).toContain('No new triples promoted');
    expect(shared.stdout).toContain('Next:');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/swm/share')?.body)
      .toMatchObject({ contextGraphId: 'already-shared' });
  }, 30000);

  it('exits non-zero for partial create/share and sync share lifecycle responses', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    await expect(runCli([
      'ka',
      'create',
      'partial-create',
      '-c',
      'research',
      '--input-file',
      join(dkgHome, 'paper.nt'),
      '--share',
    ], invocation))
      .rejects.toMatchObject({
        stdout: expect.not.stringContaining('Knowledge asset create complete:'),
        stderr: expect.stringMatching(/create\/share completed partially.*curator acknowledgement timed out/),
      });

    await expect(runCli(['ka', 'share', 'paper', '-c', 'partial-share'], invocation))
      .rejects.toMatchObject({
        stdout: expect.not.stringContaining('Knowledge asset shared to SWM:'),
        stderr: expect.stringMatching(/share completed partially.*curator acknowledgement timed out/),
      });

    expect(calls.find((call) => call.url === '/api/knowledge-assets' && call.body?.name === 'partial-create')?.body)
      .toMatchObject({ alsoShareSwm: true });
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/swm/share')?.body)
      .toMatchObject({ contextGraphId: 'partial-share' });
  }, 60000);

  it('reports VM publish partial context-graph binding and keeps named publish cleanup out of KA commands', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    await expect(runCli(['ka', 'publish', 'paper', '-c', 'partial-binding'], invocation))
      .rejects.toMatchObject({
        stdout: expect.not.stringContaining('Knowledge asset VM publish complete:'),
        stderr: expect.stringContaining('context graph binding failed'),
      });

    await expect(runCli(['ka', 'publish', 'paper', '-c', 'research', '--clear-after'], invocation))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("unknown option '--clear-after'"),
      });

    await expect(runCli(['ka', 'publish-async', 'paper', '-c', 'research', '--clear-after'], invocation))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("unknown option '--clear-after'"),
      });

    const publishCalls = calls.filter((call) => call.url === '/api/knowledge-assets/paper/vm/publish');
    expect(publishCalls.find((call) => call.body?.contextGraphId === 'partial-binding')?.body.options)
      .toBeUndefined();
    expect(publishCalls.find((call) => call.body?.contextGraphId === 'research'))
      .toBeUndefined();
  }, 60000);

  it.each([false, true])('retains the complete confirmed-obligation response before failure (JSON=%s)', async json => {
    calls = [];
    const result = await runCli(['ka', 'publish', 'paper', '-c', 'pending-obligation', ...(json ? ['--json'] : [])],
      testInvocation(dkgHome, smokeApiPort)).then(() => { throw new Error('pending obligation must fail'); },
      error => error as { stdout: string; stderr: string; code: number });
    expect(result.code).toBe(1);
    const emitted = JSON.parse(result.stdout);
    expect(emitted).toEqual(PENDING_OBLIGATION);
    expect(result.stderr).toContain('observation');
    const recovery = await fetch(`http://127.0.0.1:${smokeApiPort}${emitted.retryUrl}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId: emitted.recovery.contextGraphId, recovery: emitted.recovery }),
    });
    expect(recovery.status).toBe(200);
    expect(calls.filter(call => call.url === '/api/knowledge-assets/paper/vm/publish')).toHaveLength(1);
    expect(calls.find(call => call.url === PENDING_OBLIGATION.retryUrl)?.body.recovery).toEqual(PENDING_OBLIGATION.recovery);
    // Execute the same registered command in-process so its physical HTTP/result path is covered.
    calls = [];
    const output: unknown[] = [];
    vi.spyOn(ApiClient, 'connect').mockResolvedValue(new ApiClient(Number(smokeApiPort)));
    vi.spyOn(console, 'log').mockImplementation(value => { output.push(value); });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    try {
      const program = new Command(); registerKnowledgeAssetCommand(program);
      await expect(program.parseAsync(['ka', 'publish', 'paper', '-c', 'pending-obligation', ...(json ? ['--json'] : [])],
        { from: 'user' })).rejects.toThrow('exit:1');
      expect(output).toHaveLength(1); expect(JSON.parse(String(output[0]))).toEqual(PENDING_OBLIGATION);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('do not republish'));
      expect(calls.filter(call => call.url === '/api/knowledge-assets/paper/vm/publish')).toHaveLength(1);
    } finally { vi.restoreAllMocks(); }
  }, 30000);

  it('passes a pinned exact recovery and refuses incomplete or destructive combinations', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);
    const flags = ['ka', 'pull-from', 'paper', '-c', 'research', '--layer', 'swm'];
    await runCli([...flags, '--recover-exact-ual', 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/1',
      '--recover-exact-version', '1', '--recover-exact-root', `0x${'ab'.repeat(32)}`, '--json'], invocation);
    expect(calls.at(-1)?.body.recoverExact).toMatchObject({ assertionVersion: '1', kaUal: expect.any(String) });
    const before = calls.length;
    for (const args of [ ['--recover-exact-version', '1'], ['--recover-exact-ual', 'some-ual'],
      ['--recover-exact-ual', 'some-ual', '--recover-exact-version', '1', '--on-conflict', 'replace'] ]) {
      await expect(runCli([...flags, ...args], invocation)).rejects.toMatchObject({ stderr: expect.stringContaining('Exact recovery requires') });
    }
    expect(calls.length).toBe(before);
  }, 60000);
});
