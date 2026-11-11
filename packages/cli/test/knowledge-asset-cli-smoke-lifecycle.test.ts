import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  openSmokeEnvironment,
  runCli,
  testInvocation,
  type SmokeCall,
  type SmokeEnvironment,
} from './knowledge-asset-cli-smoke-harness.js';

// End-to-end command sequences: the full create-to-history lifecycle and the
// document import, extraction status and async SWM share job commands. The
// stub daemon, fixtures and CLI runner are shared in
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

  it('creates, writes, finalizes, shares, and publishes through lifecycle-native KA commands', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);
    const triples = JSON.stringify([{ subject: 'urn:company:acme', predicate: 'http://schema.org/name', object: '"Acme"' }]);

    const created = await runCli(['ka', 'create', 'paper', '--context-graph-id', 'research', '--triples', triples, '--share', '--await-curator-ack'], invocation);
    expect(created.stdout).toContain('Knowledge asset create complete:');

    const createCall = calls.find((call) => call.url === '/api/knowledge-assets');
    expect(createCall?.body).toMatchObject({
      contextGraphId: 'research',
      name: 'paper',
      alsoShareSwm: true,
      awaitCuratorAck: true,
    });
    expect(createCall?.body.alsoPublishVm).toBeUndefined();

    await runCli(['knowledge-asset', 'write', 'paper', '-c', 'research', '--subject', 'urn:company:acme', '--predicate', 'http://schema.org/description', '--object', 'Logistics'], invocation);
    await runCli(['ka', 'finalize', 'paper', '-c', 'research'], invocation);
    await runCli(['ka', 'finalize', 'paper', '-c', 'research', '--layer', 'wm'], invocation);
    await expect(runCli(['ka', 'finalize', 'paper', '-c', 'research', '--layer', 'swm'], invocation))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Legacy root-scoped Knowledge Assets are read-only') });
    await expect(runCli(['ka', 'share', 'paper', '-c', 'research', '--entity', 'urn:company:acme'], invocation))
      .rejects.toMatchObject({ stderr: expect.stringContaining("unknown option '--entity'") });
    await expect(runCli(['ka', 'share', 'paper', '-c', 'research', '--skip-seal'], invocation))
      .rejects.toMatchObject({ stderr: expect.stringContaining("unknown option '--skip-seal'") });
    const shared = await runCli(['ka', 'share', 'paper', '-c', 'research', '--await-curator-ack'], invocation);
    expect(shared.stdout).toContain('Next:');
    await runCli(['ka', 'publish', 'paper', '-c', 'research', '--publish-epochs', '3', '--publisher-node-identity-id', '7'], invocation);
    await runCli(['ka', 'publish-async', 'paper', '-c', 'research', '--publish-epochs', '4', '--json'], invocation);
    await runCli(['ka', 'pull-from', 'paper', '-c', 'research', '--layer', 'swm', '--on-conflict', 'replace', '--json'], invocation);
    await runCli(['ka', 'discard', 'paper', '-c', 'research'], invocation);
    await runCli(['ka', 'query', 'paper', '-c', 'research'], invocation);
    await runCli(['ka', 'history', 'paper', '-c', 'research'], invocation);

    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/wm/write');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/wm/finalize');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/swm/share');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/vm/publish');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/vm/publish-async');
    expect(calls.map((call) => call.url)).not.toContain('/api/knowledge-assets/publish');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/write')?.body.quads).toEqual([
      expect.objectContaining({
        subject: 'urn:company:acme',
        predicate: 'http://schema.org/description',
        object: '"Logistics"',
      }),
    ]);
    const finalizeCalls = calls.filter((call) => call.url === '/api/knowledge-assets/paper/wm/finalize');
    expect(finalizeCalls).toHaveLength(2);
    expect(finalizeCalls.every((call) => call.body.layer === undefined)).toBe(true);
    const shareCalls = calls.filter((call) => call.url === '/api/knowledge-assets/paper/swm/share');
    expect(shareCalls[0]?.body).toMatchObject({
      contextGraphId: 'research',
      awaitCuratorAck: true,
    });
    expect(shareCalls[0]?.body.entities).toBeUndefined();
    expect(shareCalls[0]?.body.skipSeal).toBeUndefined();
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish')?.body.options).toMatchObject({
      publishEpochs: 3,
      publisherNodeIdentityIdOverride: '7',
    });
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish')?.body.options)
      .not.toHaveProperty('clearSharedMemoryAfter');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish-async')?.body.options).toMatchObject({
      publishEpochs: 4,
    });
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish-async')?.body.options)
      .not.toHaveProperty('clearSharedMemoryAfter');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/pull-from')?.body).toMatchObject({
      layer: 'swm',
      onConflict: 'replace',
    });
  }, 60000);

  it('wraps document import, extraction status, and async SWM share job routes', async () => {
    calls = [];
    const invocation = testInvocation(dkgHome, smokeApiPort);

    await runCli(['ka', 'import-file', 'paper-doc', '-c', 'research', '--input-file', join(dkgHome, 'paper.md')], invocation);
    await runCli(['ka', 'extraction-status', 'paper-doc', '-c', 'research'], invocation);
    await runCli(['ka', 'share-async', 'paper', '-c', 'research'], invocation);
    await expect(runCli(['ka', 'share-async', 'paper', '-c', 'research', '--entity', 'urn:company:acme'], invocation))
      .rejects.toMatchObject({ stderr: expect.stringContaining("unknown option '--entity'") });
    await runCli(['ka', 'share-jobs', '-c', 'research', '--state', 'queued', '--limit', '5'], invocation);
    await runCli(['ka', 'share-job', 'share-job-1'], invocation);
    await runCli(['ka', 'cancel-share-job', 'share-job-1'], invocation);
    await runCli(['ka', 'recover-share-job', 'share-job-1'], invocation);

    const importCall = calls.find((call) => call.url === '/api/knowledge-assets/paper-doc/wm/import-file');
    expect(importCall?.contentType).toContain('multipart/form-data; boundary=');
    expect(String(importCall?.body)).toContain('name="contextGraphId"');
    expect(String(importCall?.body)).toContain('research');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/swm/share-async')?.body)
      .toMatchObject({ contextGraphId: 'research' });
    const shareAsyncCalls = calls.filter((call) => call.url === '/api/knowledge-assets/paper/swm/share-async');
    expect(shareAsyncCalls[0]?.body.entities).toBeUndefined();
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/swm/share-jobs?contextGraphId=research&state=queued&limit=5');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/swm/share-jobs/share-job-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain('DELETE /api/knowledge-assets/swm/share-jobs/share-job-1');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/swm/share-jobs/share-job-1/recover');
  }, 60000);
});
