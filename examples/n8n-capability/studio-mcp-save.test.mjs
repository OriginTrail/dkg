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
  const mcp = () => createStudioMcpService({ repository: f.repository, accountId: owner.accountId, profile: null, runner });
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
