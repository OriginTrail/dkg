import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioMcpService } from './studio-mcp-service.mjs';
import { readStudio } from './studio-definition.mjs';
import { definition, environment } from './test-support/studio-service-fixture.mjs';

test('MCP eligibility requires completed owner save and survives repository reopen after a successful retry', async t => {
  const f = environment(); t.after(() => f.close());
  const owner = { id: 'owner', accountId: 'account-test', role: 'owner' };
  const graph = definition(['edit-fields'], []);
  let dispatches = 0;
  const runner = {
    async prepare() { return 'version1'; },
    async dispatch() { dispatches++; return '42'; },
    async inspect() { return { status: 'running' }; },
  };
  const mcp = () => createStudioMcpService({ repository: f.repository, accountId: owner.accountId, runner });
  const approve = f.client.programs.approve;
  let attemptedApproval;
  f.client.programs.approve = async value => { attemptedApproval = value; throw new Error('owner approval unavailable'); };
  await assert.rejects(f.service.save(graph), /owner approval unavailable/);
  assert.equal(f.native.size, 1);
  assert.equal([...f.native.values()][0].active, true, 'failure occurs after native publication');
  const compiled = readStudio(f.sources.get(attemptedApproval.operationIri).source);
  const pin = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256 };
  const input = { ...pin, runKey: 'save-retry', arguments: { value: 'sample' } };
  async function assertIneligible() {
    assert.equal(f.repository.workflow(pin.kaRef).executor, null);
    assert.deepEqual(await f.service.list(), []);
    const service = mcp();
    assert.deepEqual(service.list(owner), []);
    assert.throws(() => service.get(pin, owner), { code: 'STUDIO_WORKFLOW_NOT_FOUND' });
    await assert.rejects(service.run(input, owner), { code: 'STUDIO_WORKFLOW_NOT_FOUND' });
    assert.equal(f.repository.mcp.savedNative(pin.kaRef), undefined);
    assert.equal(f.repository.mcp.run(owner.accountId, input.runKey), undefined);
    assert.equal(dispatches, 0);
  }
  await assertIneligible();
  f.restart();
  await assertIneligible();

  f.client.programs.approve = approve;
  const saved = await f.service.save(graph);
  assert.equal(saved.approved, true);
  assert.equal(saved.kaRef, pin.kaRef);
  assert.equal(saved.workflowSha256, pin.workflowSha256);
  assert.equal(f.native.size, 1);
  assert.equal(f.calls.filter(([method, path]) => method === 'POST' && path === '/workflows').length, 1);
  assert.equal(mcp().get(pin, owner).approved, true);
  f.restart();
  const service = mcp();
  assert.equal(service.list(owner)[0].kaRef, pin.kaRef);
  assert.equal(service.get(pin, owner).approved, true);
  assert.equal((await service.run(input, owner)).status, 'running');
  assert.equal(dispatches, 1);
  assert.equal(f.repository.mcp.run(owner.accountId, input.runKey).checkpoint.executionId, '42');
});

for (const failure of ['native snapshot fetch', 'snapshot database write']) test(`interrupted ${failure} leaves neither save record completed after reopen and retries without another native create`, async t => {
  const f = environment(); t.after(() => f.close());
  const owner = { id: 'owner', accountId: 'account-test', role: 'owner' };
  const graph = definition(['edit-fields'], []);
  const mcp = () => createStudioMcpService({ repository: f.repository, provider: f.provider,
    installation: f.config.n8nNative, accountId: owner.accountId });
  if (failure === 'native snapshot fetch') {
    const approve = f.client.programs.approve;
    f.client.programs.approve = async value => {
      await approve(value);
      f.failNextNativeRead(new Error('completion interrupted'));
    };
  } else f.repository.db.exec("CREATE TRIGGER interrupt_save AFTER INSERT ON studio_saved_native BEGIN SELECT RAISE(ABORT, 'completion interrupted'); END");
  await assert.rejects(f.service.save(graph), /completion interrupted/);
  const compiled = readStudio([...f.sources.values()][0].source);
  const pin = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256 };
  assert.equal(f.approvals.get(compiled.kaRef).binding.enabled, true, 'remote approval precedes interrupted local completion');
  assert.equal([...f.native.values()][0].active, true);
  const nativeRevision = f.repository.nativeRevision(compiled.kaRef);
  const verifyIncomplete = async () => {
    assert.equal(f.repository.workflow(compiled.kaRef).executor, null);
    assert.equal(f.repository.workflow(compiled.kaRef).requiresExportAuthorization, false);
    assert.equal(f.repository.mcp.savedNative(compiled.kaRef), undefined);
    assert.deepEqual(f.repository.nativeRevision(compiled.kaRef), nativeRevision);
    assert.deepEqual(await f.service.list(), []);
    await assert.rejects(f.service.get(compiled.kaRef), /Unknown saved graph/);
    assert.deepEqual(mcp().list(owner), []);
    await assert.rejects(mcp().run({ ...pin, runKey: 'incomplete', arguments: {} }, owner), { code: 'STUDIO_WORKFLOW_NOT_FOUND' });
  };
  await verifyIncomplete(); f.restart(); await verifyIncomplete();
  if (failure === 'snapshot database write') f.repository.db.exec('DROP TRIGGER interrupt_save');
  const completed = await f.service.save(graph);
  assert.equal(completed.approved, true);
  assert.equal(completed.kaRef, compiled.kaRef);
  const snapshot = f.repository.mcp.savedNative(compiled.kaRef);
  assert.ok(snapshot);
  f.restart();
  assert.equal((await f.service.get(compiled.kaRef)).workflow.approved, true);
  assert.equal(mcp().get(pin, owner).approved, true);
  assert.deepEqual(f.repository.mcp.savedNative(compiled.kaRef), snapshot);
  assert.equal(f.calls.filter(([method, path]) => method === 'POST' && path === '/workflows').length, 1);
  assert.equal(f.invocations.length, 0);
});

test('completed owner resave retains the original native snapshot and sticky withdrawal after reopen', async t => {
  const f = environment(); t.after(() => f.close());
  const owner = { id: 'owner', accountId: 'account-test', role: 'owner' };
  const graph = definition(['edit-fields'], []), saved = await f.service.save(graph);
  const pin = { kaRef: saved.kaRef, workflowSha256: saved.workflowSha256 };
  const mcp = () => createStudioMcpService({ repository: f.repository, provider: f.provider,
    installation: f.config.n8nNative, accountId: owner.accountId });
  mcp().withdraw(pin, owner);
  const snapshot = f.repository.mcp.savedNative(saved.kaRef);
  // Identical native graph published under another provider version must not
  // rewrite the snapshot originally admitted by the completed owner save.
  [...f.native.values()][0].activeVersion.versionId = 'version2';
  await f.service.save(graph);
  f.restart();
  assert.deepEqual(f.repository.mcp.savedNative(saved.kaRef), snapshot);
  assert.equal((await f.service.get(saved.kaRef)).workflow.approved, true);
  assert.equal(mcp().get(pin, owner).approved, false);
  await assert.rejects(mcp().run({ ...pin, runKey: 'withdrawn', arguments: {} }, owner), { code: 'STUDIO_WORKFLOW_WITHDRAWN' });
  assert.equal(f.calls.filter(([method, path]) => method === 'POST' && path === '/workflows').length, 1);
});
