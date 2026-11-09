import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Each node:test file runs in its own process. Load the explicit fictional profile
// before the component registry, just as the companion startup does.
process.env.NOS_DKG_PROFILE_MODULE = fileURLToPath(new URL('./test-support/agent-read-profile.mjs', import.meta.url));
const { default: profile, calls } = await import('./test-support/agent-read-profile.mjs');
const { profileParameters } = await import('./dkg-profile.mjs');
const { compileStudio } = await import('./studio-definition.mjs');
const { createStudioProvider } = await import('./studio-provider.mjs');
const { createStudioMcpService } = await import('./studio-mcp-service.mjs');
const { handleDkgComponentCallback } = await import('./bridge.mjs');

test('shared callback preserves MCP routing and does not fall back after an MCP rejection', async t => {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-callback-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const webhookTokenFile = join(state, 'token'), token = 'fixture-callback-token'.repeat(3);
  writeFileSync(webhookTokenFile, token);
  const config = { n8nNative: { webhookTokenFile } };
  let manualCalls = 0, nativeCalls = 0;
  const studio = { dkgComponent: async () => { manualCalls++; return { route: 'manual' }; } };
  async function send(mcp) {
    const req = { method: 'POST', headers: { authorization: 'Bearer ' + token },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"effectId":"run-one"}'); } };
    let status, body;
    await handleDkgComponentCallback(req, { writeHead(s) { status = s; }, end(s) { body = JSON.parse(s); } }, studio, config, mcp);
    return { status, body };
  }
  assert.deepEqual(await send({ dkgComponent: async () => { nativeCalls++; return { route: 'native' }; } }),
    { status: 200, body: { route: 'native' } });
  assert.equal(manualCalls, 0); assert.equal(nativeCalls, 1);
  assert.deepEqual(await send({ dkgComponent: async () => undefined }), { status: 200, body: { route: 'manual' } });
  const rejected = await send({ dkgComponent: async () => { throw Object.assign(new Error('Denied'), { status: 403 }); } });
  assert.equal(rejected.status, 403); assert.equal(manualCalls, 1);
});

test('native DKG callback uses the admitted pins, typed profile and full agent actor; no Program path', async t => {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-dkg-')); t.after(() => rmSync(state, { recursive: true, force: true }));
  const node = { id: 'read', componentId: 'dkg-read', kaRef: 'urn:demo:n8n:component:dkg-read:test', sourceHash: 'a'.repeat(64), x: 0, y: 0,
    params: Object.fromEntries(Object.entries(profileParameters(profile, 'dkg-read')).map(([key, value]) => [key, value.default])) };
  const compiled = compileStudio({ id: '123e4567-e89b-42d3-a456-426614174099', name: 'Read a sample', entryId: 'read', nodes: [node], edges: [] },
    { graphId: 'test', owner: '0x' + 'a'.repeat(40), fixture: true, headerCredential: { id: 'test', name: 'test' }, providerId: 'native-read' });
  const published = { ...compiled.workflow, id: 'native-read', versionId: 'v1', active: true };
  const provider = createStudioProvider({ state, config: { n8nNative: { workflows: [] } }, graphId: 'test', owner: '0x' + 'a'.repeat(40) });
  t.after(() => { if (provider.db.isOpen) provider.close(); });
  const runKey = '123e4567-e89b-42d3-a456-426614174088';
  let inputEvidence;
  provider.api = async path => path.startsWith('/workflows') ? published : { id: '42', workflowId: 'native-read', workflowVersionId: 'v1', status: 'running', workflowData: published,
    data: inputEvidence };
  // Test fixture installs the same durable saved record that a completed owner save writes.
  provider.db.prepare('INSERT INTO studio_saved_native (ka_ref,compiled_json,published_json) VALUES (?,?,?)')
    .run(compiled.kaRef, JSON.stringify(compiled), JSON.stringify(published));
  const actor = { id: 'owner', role: 'owner', accountId: 'account-test', startedBy: 'agent:a', agentVersion: 'v1', toolDigest: 'd'.repeat(64), approvalDecisionId: 'decision-1' };
  let earlyCallback;
  const s = createStudioMcpService({ provider, accountId: actor.accountId, profile,
    runner: { async prepare() { return 'v1'; }, async dispatch() { earlyCallback = s.dkgComponent({ effectId: runKey, workflowId: 'native-read', executionId: '42', blockId: 'read', items: [{ sample: 'a' }] }); return '42'; }, async inspect() { return { status: 'running' }; } } });
  const input = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256, runKey, arguments: { sample: 'a' } };
  await assert.rejects(s.run({ ...input, arguments: { sample: 'a" } UNION { ?s ?p ?o' } }, actor));
  assert.equal((await s.run(input, actor)).status, 'running');
  const callback = { effectId: runKey, workflowId: 'native-read', executionId: '42', blockId: 'read', items: [{ sample: 'a' }] };
  // Default n8n progress saving has no Receive input runData while running.
  const result = await earlyCallback;
  assert.equal(result.items.length, 2); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].context.actor, { ...actor, runKey });
  assert.equal(calls[0].operation, 'read');
  await assert.rejects(s.dkgComponent({ ...callback, executionId: '43' }));
  await assert.rejects(s.dkgComponent({ ...callback, blockId: 'write' }));
  await s.dkgComponent(callback); assert.equal(calls.length, 1); // retained read cache, no second node request
  inputEvidence = { resultData: { runData: { 'Receive input': [{ data: { main: [[{ json: { body: { invocationId: 'foreign-run' } } }]] } }] } } };
  await assert.rejects(s.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  inputEvidence = undefined;
  provider.db.prepare("UPDATE studio_tool_runs SET execution_id=NULL, status='unconfirmed'").run();
  await assert.rejects(s.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  provider.db.prepare("UPDATE studio_tool_runs SET execution_id='42', status='running'").run();
  const revision = profile.revision;
  profile.revision = 'f'.repeat(64);
  await assert.rejects(s.dkgComponent(callback));
  const pin = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256 };
  assert.throws(() => s.withdraw({ ...pin, workflowSha256: '0'.repeat(64) }, actor));
  const owner = { id: actor.id, accountId: actor.accountId, role: 'owner' };
  assert.throws(() => s.withdraw({ ...pin, workflowSha256: '0'.repeat(64) }, owner), { code: 'STUDIO_NATIVE_PIN_CHANGED' });
  assert.equal(s.withdraw(pin, owner).approved, false);
  profile.revision = revision;
  provider.close();
  const reopened = createStudioProvider({ state, config: { n8nNative: { workflows: [] } }, graphId: 'test', owner: '0x' + 'a'.repeat(40) });
  t.after(() => reopened.close());
  const restored = createStudioMcpService({ provider: reopened, accountId: actor.accountId, profile,
    runner: { async inspect() { return { status: 'succeeded', output: { secret: 'retained' } }; } } });
  assert.equal(restored.list(owner).length, 0);
  await assert.rejects(restored.run({ ...input, runKey: 'new-run' }, actor), { code: 'STUDIO_WORKFLOW_WITHDRAWN' });
  await assert.rejects(restored.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  assert.equal((await restored.readRun({ runKey }, actor)).output, undefined);
  assert.equal(calls.length, 1);
});
