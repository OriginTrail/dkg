import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('native DKG callback uses the admitted pins, typed profile and full agent actor; no Program path', async t => {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-dkg-')); t.after(() => rmSync(state, { recursive: true, force: true }));
  const node = { id: 'read', componentId: 'dkg-read', kaRef: 'urn:demo:n8n:component:dkg-read:test', sourceHash: 'a'.repeat(64), x: 0, y: 0,
    params: Object.fromEntries(Object.entries(profileParameters(profile, 'dkg-read')).map(([key, value]) => [key, value.default])) };
  const compiled = compileStudio({ id: '123e4567-e89b-42d3-a456-426614174099', name: 'Read a sample', entryId: 'read', nodes: [node], edges: [] },
    { graphId: 'test', owner: '0x' + 'a'.repeat(40), fixture: true, headerCredential: { id: 'test', name: 'test' }, providerId: 'native-read' });
  const published = { ...compiled.workflow, id: 'native-read', versionId: 'v1', active: true };
  const provider = createStudioProvider({ state, config: { n8nNative: { workflows: [] } }, graphId: 'test', owner: '0x' + 'a'.repeat(40) });
  t.after(() => provider.close());
  const runKey = '123e4567-e89b-42d3-a456-426614174088';
  provider.api = async path => path.startsWith('/workflows') ? published : { id: '42', workflowId: 'native-read', workflowVersionId: 'v1', status: 'running', workflowData: published,
    data: { resultData: { runData: { 'Receive input': [{ data: { main: [[{ json: { body: { invocationId: runKey } } }]] } }] } } } };
  // Test fixture installs the same durable saved record that a completed owner save writes.
  provider.db.prepare('INSERT INTO studio_saved_native (ka_ref,compiled_json,published_json) VALUES (?,?,?)')
    .run(compiled.kaRef, JSON.stringify(compiled), JSON.stringify(published));
  const actor = { id: 'owner', role: 'owner', accountId: 'account-test', startedBy: 'agent:a', agentVersion: 'v1', toolDigest: 'd'.repeat(64), approvalDecisionId: 'decision-1' };
  const s = createStudioMcpService({ provider, accountId: actor.accountId, profile,
    runner: { async prepare() { return 'v1'; }, async dispatch() { return '42'; }, async inspect() { return { status: 'running' }; } } });
  const input = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256, runKey, arguments: { sample: 'a' } };
  await assert.rejects(s.run({ ...input, arguments: { sample: 'a" } UNION { ?s ?p ?o' } }, actor));
  assert.equal((await s.run(input, actor)).status, 'running');
  const callback = { effectId: runKey, workflowId: 'native-read', executionId: '42', blockId: 'read', items: [{ sample: 'a' }] };
  const result = await s.dkgComponent(callback);
  assert.equal(result.items.length, 2); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].context.actor, { ...actor, runKey });
  assert.equal(calls[0].operation, 'read');
  await assert.rejects(s.dkgComponent({ ...callback, executionId: '43' }));
  await assert.rejects(s.dkgComponent({ ...callback, blockId: 'write' }));
  await s.dkgComponent(callback); assert.equal(calls.length, 1); // retained read cache, no second node request
  profile.revision = 'f'.repeat(64);
  await assert.rejects(s.dkgComponent(callback));
});
