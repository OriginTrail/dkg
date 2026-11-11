import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUTHOR_AGENT_ADDRESS,
  PRE_SIGNED_AUTHOR_ATTESTATION,
  openSmokeEnvironment,
  runCli,
  testInvocation,
  type SmokeCall,
  type SmokeEnvironment,
} from './knowledge-asset-cli-smoke-harness.js';

// Command registration and help, invocation cancellation, and the input and
// flag checks that refuse before any daemon request. The stub daemon, fixtures
// and CLI runner are shared in knowledge-asset-cli-smoke-harness.ts.
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

  it('preserves invocation cancellation through copied environment overrides', async () => {
    let finish!: () => void, entered!: () => void, disconnected!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    let requests = 0;
    const pendingServer = createServer(req => {
      requests++; req.socket.once('close', disconnected); entered();
    });
    await new Promise<void>((resolve, reject) => {
      pendingServer.once('error', reject); pendingServer.listen(0, '127.0.0.1', resolve);
    });
    const cleanup = async () => {
      pendingServer.closeAllConnections();
      if (pendingServer.listening) await new Promise<void>(resolve => pendingServer.close(() => resolve()));
    };
    onTestFinished(cleanup);
    const invocation = testInvocation(dkgHome, smokeApiPort, callback => { finish = callback; onTestFinished(callback); });
    const address = pendingServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP smoke endpoint');
    const overridden = { ...invocation, env: { ...invocation.env, DKG_API_PORT: String(address.port) } };
    try {
      const cancelled = expect(runCli(['ka', 'query', 'paper', '-c', 'research'], overridden))
        .rejects.toMatchObject({ name: 'AbortError' });
      await arrived; finish();
      await cancelled; await closed;
      expect(overridden.signal.aborted).toBe(true);
      await expect(runCli(['--help'], { ...overridden, env: { ...overridden.env, SOME_FLAG: '1' } }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(requests).toBe(1);
    } finally { finish(); await cleanup(); }
  });

  it('registers canonical command and ka alias help', async () => {
    const invocation = testInvocation(dkgHome, smokeApiPort);
    const top = await runCli(['--help'], invocation);
    expect(top.stdout).toContain('knowledge-asset');

    const canonical = await runCli(['knowledge-asset', '--help'], invocation);
    expect(canonical.stdout).toContain('Knowledge Asset lifecycle commands');
    expect(canonical.stdout).toContain('publish-async');

    const alias = await runCli(['ka', 'create', '--help'], invocation);
    expect(alias.stdout).toContain('--input-file <path>');
    expect(alias.stdout).toContain('--share');
    expect(alias.stdout).not.toContain('alsoPublishVm');

    const publish = await runCli(['ka', 'publish', '--help'], invocation);
    expect(publish.stdout).toContain('--publish-epochs <count>');
    expect(publish.stdout).toContain('--pricing-policy <policy>');
    expect(publish.stdout).not.toContain('--clear-after');

    const publishAsync = await runCli(['ka', 'publish-async', '--help'], invocation);
    expect(publishAsync.stdout).toContain('--publish-epochs <count>');
    expect(publishAsync.stdout).toContain('--pricing-policy <policy>');
    expect(publishAsync.stdout).not.toContain('--clear-after');
  }, 30000);

  it('rejects one-shot share without payload before contacting the daemon', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    await expect(runCli(['ka', 'create', 'paper', '-c', 'research', '--share'], invocation))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--share requires non-empty payload quads and finalize enabled'),
      });
    expect(calls).toEqual([]);
  }, 30000);

  it('rejects finalizing named-graph JSON-LD before any daemon request', async () => {
    calls = [];
    await expect(runCli([
      'ka', 'create', 'named', '-c', 'research', '-f', join(dkgHome, 'named.jsonld'),
    ], testInvocation(dkgHome, smokeApiPort))).rejects.toMatchObject({
      stderr: expect.stringContaining('--no-finalize'),
    });
    expect(calls).toEqual([]);
  }, 30000);

  it('rejects a mixed default/named JSON-LD dataset before any daemon request', async () => {
    calls = [];
    await expect(runCli([
      'ka', 'create', 'mixed', '-c', 'research', '-f', join(dkgHome, 'mixed.jsonld'),
    ], testInvocation(dkgHome, smokeApiPort))).rejects.toMatchObject({ stderr: expect.stringContaining('--no-finalize') });
    expect(calls).toEqual([]);
  }, 30000);

  it.each([null, [{ subject: 'urn:invalid', object: '"missing predicate"' }]])('uses the same legacy validation for JSON files and --triples: %j', async (input) => {
    calls = [];
    const raw = JSON.stringify(input);
    const path = join(dkgHome, 'invalid-quads.json');
    await writeFile(path, raw);
    for (const inputArgs of [['--file', path], ['--triples', raw]]) {
      await expect(runCli(['ka', 'write', 'invalid', '-c', 'research', ...inputArgs], testInvocation(dkgHome, smokeApiPort)))
        .rejects.toMatchObject({ stderr: expect.stringContaining('JSON input must contain an array of subject/predicate/object quads') });
    }
    expect(calls).toEqual([]);
  }, 30000);

  it('maps draft-only create and rejects incompatible draft share before contacting the daemon', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);
    const triples = JSON.stringify([{ subject: 'urn:company:acme', predicate: 'http://schema.org/name', object: '"Acme"' }]);

    await runCli(['ka', 'create', 'draft', '-c', 'research', '--triples', triples, '--no-finalize'], invocation);

    expect(calls.find((call) => call.url === '/api/knowledge-assets')?.body)
      .toMatchObject({ name: 'draft', finalize: false });
    expect(calls.find((call) => call.url === '/api/knowledge-assets')?.body.alsoShareSwm)
      .toBeUndefined();

    calls = [];
    await expect(runCli(['ka', 'create', 'draft-share', '-c', 'research', '--triples', triples, '--share', '--no-finalize'], invocation))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--share requires non-empty payload quads and finalize enabled'),
      });
    expect(calls).toEqual([]);
  }, 30000);

  it('rejects malformed positive integer flags before daemon requests', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    await expect(runCli(['ka', 'publish', 'paper', '-c', 'research', '--publish-epochs', '1e6'], invocation))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--publish-epochs must be a positive integer'),
      });
    await expect(runCli(['ka', 'publish-async', 'paper', '-c', 'research', '--publish-epochs', '3abc'], invocation))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--publish-epochs must be a positive integer'),
      });
    await expect(runCli(['ka', 'finalize', 'paper', '-c', 'research', '--scheme-version', '2.5'], invocation))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--scheme-version must be a positive integer'),
      });
    expect(calls).toEqual([]);
  }, 30000);

  it('maps author attestation flags through CLI parsing and rejects conflicts', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);
    const triples = JSON.stringify([{ subject: 'urn:company:acme', predicate: 'http://schema.org/name', object: '"Acme"' }]);

    await runCli([
      'ka',
      'create',
      'author-inline',
      '-c',
      'research',
      '--triples',
      triples,
      '--pre-signed-author-attestation',
      JSON.stringify(PRE_SIGNED_AUTHOR_ATTESTATION),
      '--scheme-version',
      '2',
    ], invocation);

    const createCall = calls.find((call) => call.url === '/api/knowledge-assets');
    expect(createCall?.body).toMatchObject({
      name: 'author-inline',
      preSignedAuthorAttestation: PRE_SIGNED_AUTHOR_ATTESTATION,
      schemeVersion: 2,
    });
    expect(createCall?.body.authorAgentAddress).toBeUndefined();

    calls = [];
    await runCli([
      'ka',
      'finalize',
      'paper',
      '-c',
      'research',
      '--pre-signed-author-attestation',
      join(dkgHome, 'attestation.json'),
      '--scheme-version',
      '2',
    ], invocation);
    const fileBackedFinalize = calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/finalize');
    expect(fileBackedFinalize?.body).toMatchObject({
      contextGraphId: 'research',
      preSignedAuthorAttestation: PRE_SIGNED_AUTHOR_ATTESTATION,
      schemeVersion: 2,
    });

    calls = [];
    await runCli([
      'ka',
      'finalize',
      'paper',
      '-c',
      'research',
      '--author-agent-address',
      AUTHOR_AGENT_ADDRESS,
      '--scheme-version',
      '1',
    ], invocation);
    const authorAddressFinalize = calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/finalize');
    expect(authorAddressFinalize?.body).toMatchObject({
      contextGraphId: 'research',
      authorAgentAddress: AUTHOR_AGENT_ADDRESS,
      schemeVersion: 1,
    });
    expect(authorAddressFinalize?.body.preSignedAuthorAttestation).toBeUndefined();

    calls = [];
    await expect(runCli([
      'ka',
      'finalize',
      'paper',
      '-c',
      'research',
      '--author-agent-address',
      AUTHOR_AGENT_ADDRESS,
      '--pre-signed-author-attestation',
      join(dkgHome, 'attestation.json'),
    ], invocation))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--author-agent-address and --pre-signed-author-attestation are mutually exclusive'),
      });
    expect(calls).toEqual([]);
  }, 60000);
});
