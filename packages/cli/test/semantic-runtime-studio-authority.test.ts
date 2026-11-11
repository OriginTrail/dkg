import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runInThisContext, constants as vmConstants } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupRuntimeFixtures, graph, owner, SR, toolFixture, restartNode, invalidateExecutionCapability } from './_helpers/semantic-runtime-api-fixture.js';
import { createNativeCallbackAuthority } from '../src/semantic-runtime-native-callback-authority.js';
import { assertExecutionCapabilityAuthorized } from '../src/semantic-runtime-invocation-policy.js';

afterEach(async () => { vi.unstubAllGlobals(); await cleanupRuntimeFixtures(); });

async function studio({ childDepth = 0, withProgram = false, namedInput = false } = {}) {
  // Real compiler, signed SDK route, TypeScript/Wasm runtime and SQLite journals.
  // Only the n8n HTTP provider and remote DKG transport are fictional.
  const { createStudioExecutionHarness } = await runInThisContext('(url) => import(url)',
    { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER })(
    new URL('../../../examples/n8n-capability/test-support/studio-execution-harness.mjs', import.meta.url).href);
  const f = await toolFixture('export function run() { return null; }', { graphId: graph }, []);
  const children = [];
  for (let level = 0; level < childDepth; level++) {
    const child = children.at(-1);
    const program = await f.manager.programs.upload({ graphId: graph, language: 'typescript-v1', requiredTools: [],
      source: `export function run() { return ${level}; }`, permittedPrograms: child ? [child.program.programIri] : [] });
    const operation = { graphId: graph, operationIri: 'urn:test:studio-child:' + level };
    const typescript = { children: child ? [child.operation] : [] };
    const approval = await f.manager.programs.approve({ ...operation, program, allowedCallers: [owner], typescript });
    children.push({ operation, program, typescript, approval });
  }
  const child = children.at(-1);
  // Older native Studio wrappers declare pinned children without invoking them.
  // Retain that supported approval shape through the real upload/approval API.
  const programs = child ? {
    getSource: f.manager.programs.getSource.bind(f.manager.programs),
    getApproval: f.manager.programs.getApproval.bind(f.manager.programs),
    invoke: f.manager.programs.invoke.bind(f.manager.programs),
    upload: (value: any) => f.manager.programs.upload({ ...value, permittedPrograms: [child.program.programIri] }),
    approve: (value: any) => f.manager.programs.approve({ ...value, typescript: { ...value.typescript, children: [child.operation] } }),
  } : f.manager.programs;
  const authority = createNativeCallbackAuthority({ agent: f.target.agent, runtime: () => f.target.runtime,
    config: f.target.config.semanticRuntime, graphId: graph, caller: owner });
  const h = createStudioExecutionHarness({ state: join(f.target.dir, 'studio'), graphId: graph, owner,
    config: f.target.config.semanticRuntime, client: { programs }, programAuthority: authority, withProgram,
    loadOutputs: async (iri: string) => (await f.store.query(`SELECT ?output WHERE { GRAPH ?g { <${iri}> <${SR}output> ?output } }`)).bindings
      .map((row: any) => JSON.parse(row.output)) });
  vi.stubGlobal('fetch', h.runtimeFetch);
  h.controls.interrupted = false;
  if (namedInput) h.definition.inputs = [{ name: 'note', label: 'Note', required: true,
    spec: { type: 'string', label: 'Note', default: '', maxLength: 80 },
    targets: [{ nodeId: 'read', parameter: 'note', kind: 'input' }] }];
  const workflow = await h.service.save(h.definition, () => {});
  const approval = await f.manager.programs.getApproval({ graphId: graph, operationIri: workflow.kaRef });
  const invocation = { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, itemsJson: '[{}]', invocationId: randomUUID(),
    ...(namedInput ? { arguments: { note: 'first' } } : {}) };
  const replaceApproval = (revision: number, typescript = approval.binding.typescript) =>
    f.manager.programs.updateApproval({ graphId: graph, operationIri: workflow.kaRef, expectedRevision: revision,
      program: { graphId: graph, programIri: workflow.kaRef, programLayer: 'wm', sourceHash: workflow.sourceHash, authorAgentAddress: owner },
      allowedCallers: [owner], n8n: approval.binding.n8n, typescript });
  return { f, h, workflow, approval, invocation, replaceApproval, children };
}

function noWrite(h: any) {
  expect(h.effects).toEqual(['read']);
  expect(h.assets.size).toBe(0);
  expect(h.controls.dispatches).toBe(1);
  expect(h.controls.callbackStatuses).toEqual([200, 403, 403]);
  expect(h.controls.callbackErrors.map((e: any) => e.code)).toEqual(['PROGRAM_AUTHORITY_REVOKED', 'PROGRAM_AUTHORITY_REVOKED']);
}

it('compiler 8 bound-entry input retains signed invocation identity and pins across replay and reopen', async () => {
  const { f, h, workflow, invocation } = await studio({ namedInput: true });
  try {
    const original = await f.manager.programs.getSource({ graphId: graph, programIri: workflow.kaRef, programLayer: 'wm' });
    const first = await h.service.run(invocation, () => {}, h.actor);
    expect(first.output.ok).toBe(true);
    expect(h.controls.dispatches).toBe(1);
    await restartNode(f.target); h.reopen();
    expect(await h.service.run(invocation, () => {}, h.actor)).toEqual(first);
    await expect(h.service.run({ ...invocation, arguments: { note: 'changed' } }, () => {}, h.actor)).rejects.toBeDefined();
    expect(h.controls.dispatches).toBe(1);
    const second = await h.service.run({ ...invocation, invocationId: randomUUID(), arguments: { note: 'second' } }, () => {}, h.actor);
    expect(second.output.ok).toBe(true);
    expect(second.workflowSha256).toBe(first.workflowSha256);
    expect(h.controls.dispatches).toBe(2);
    expect(await f.manager.programs.getSource({ graphId: graph, programIri: workflow.kaRef, programLayer: 'wm' })).toEqual(original);
  } finally { h.close(); }
});

it('rejects the old Studio Write after same-source revoke/reapprove and journal reopen, but admits a new invocation', async () => {
  const { f, h, workflow, approval, invocation, replaceApproval } = await studio();
  try {
    h.controls.beforeWrite = async () => {
      const revoked = await f.manager.programs.revoke({ graphId: graph, operationIri: workflow.kaRef, expectedRevision: approval.revision });
      await replaceApproval(revoked.revision);
      h.reopen();
    };
    await expect(h.service.run(invocation, () => {}, h.actor)).rejects.toBeDefined();
    noWrite(h);
    const oldRequest = h.controls.writeRequest;
    await restartNode(f.target); h.reopen();
    await expect(h.service.dkgComponent(oldRequest)).rejects.toMatchObject({ code: 'PROGRAM_AUTHORITY_REVOKED' });
    await expect(h.service.run(invocation, () => {}, h.actor)).rejects.toThrow('different original authority');
    noWrite(h);
    h.controls.beforeWrite = undefined;
    const fresh = { ...invocation, invocationId: randomUUID() };
    const result = await h.service.run(fresh, () => {}, h.actor);
    expect(result).toMatchObject({ invocationId: fresh.invocationId, n8nExecutionId: '43', persisted: true, readbackVerified: true });
    expect(h.effects).toEqual(['read', 'read', 'write']);
    expect(h.assets.size).toBe(1);
    expect(await h.service.run(fresh, () => {}, h.actor)).toEqual(result);
    expect(h.controls.dispatches).toBe(2);
    expect(h.controls.allowCreates).toEqual([true]);
  } finally { h.close(); }
});

it.each([1, 2])('rejects Write after replacing a pinned child at depth %s with identical source and callers', async childDepth => {
  const { f, h, workflow, invocation, approval, children } = await studio({ childDepth });
  try {
    const leaf = children[0];
    h.controls.beforeWrite = () => {
      h.controls.authorizing = async () => {
        h.controls.authorizing = undefined;
        const replaced = await f.manager.programs.updateApproval({ ...leaf.operation, program: leaf.program,
          allowedCallers: [owner], typescript: leaf.typescript, expectedRevision: leaf.approval.revision });
        expect(replaced.binding.program.sourceHash).toBe(leaf.approval.binding.program.sourceHash);
        expect(replaced.binding.allowedCallerAgentAddresses).toEqual(leaf.approval.binding.allowedCallerAgentAddresses);
        expect(replaced.bindingDigest).not.toBe(leaf.approval.bindingDigest);
      };
    };
    await expect(h.service.run(invocation, () => {}, h.actor)).rejects.toMatchObject({ code: 'PROGRAM_CHILD_FORBIDDEN' });
    expect(await f.manager.programs.getApproval({ graphId: graph, operationIri: workflow.kaRef })).toEqual(approval);
    expect(h.effects).toEqual(['read']);
    expect(h.assets.size).toBe(0);
    expect(h.controls.dispatches).toBe(1);
    expect(h.controls.callbackErrors.map((e: any) => e.code)).toEqual(['PROGRAM_CHILD_FORBIDDEN', 'PROGRAM_CHILD_FORBIDDEN']);
    await restartNode(f.target); h.reopen();
    await expect(h.service.dkgComponent(h.controls.writeRequest)).rejects.toMatchObject({ code: 'PROGRAM_CHILD_FORBIDDEN' });
    expect(h.effects).toEqual(['read']);
  } finally { h.close(); }
});

it('a completed parent rejects its first Write callback without journalling or dispatching a new effect', async () => {
  const { f, h, invocation, approval, workflow } = await studio();
  try {
    h.controls.skipWrite = true;
    const result = await h.service.run(invocation, () => {}, h.actor);
    expect(result.output.ok).toBe(false);
    const executionId = 'urn:sr:execution:' + invocation.invocationId;
    const writeKey = invocation.invocationId + ':write';
    for (const reopen of [false, true]) {
      if (reopen) { await restartNode(f.target); h.reopen(); }
      expect(f.target.runtime!.store.execution(executionId)?.status).toBe('completed');
      assertExecutionCapabilityAuthorized(f.target.runtime!, executionId, 'completed');
      expect(await f.manager.programs.getApproval({ graphId: graph, operationIri: workflow.kaRef })).toEqual(approval);
      await expect(h.service.dkgComponent(h.controls.writeRequest)).rejects.toMatchObject({ code: 'PROGRAM_AUTHORITY_REVOKED' });
      expect(h.repository.db.prepare('SELECT 1 FROM dkg_component_calls WHERE id=?').get(writeKey)).toBeUndefined();
      expect(h.effects).toEqual(['read']);
      expect(h.assets.size).toBe(0);
      expect(h.controls.dispatches).toBe(1);
    }
  } finally { h.close(); }
});

it.each(['revoke', 'expire', 'epoch'] as const)('rejects Write when the original capability changes during account authorization: %s', async change => {
  const { f, h, invocation } = await studio();
  try {
    h.controls.beforeWrite = () => {
      h.controls.authorizing = async () => {
        h.controls.authorizing = undefined;
        invalidateExecutionCapability(f.target, invocation.invocationId, change);
      };
    };
    await expect(h.service.run(invocation, () => {}, h.actor)).rejects.toBeDefined();
    noWrite(h);
    await restartNode(f.target); h.reopen();
    await expect(h.service.dkgComponent(h.controls.writeRequest)).rejects.toMatchObject({ code: 'PROGRAM_AUTHORITY_REVOKED' });
    noWrite(h);
  } finally { h.close(); }
});

it('rejects a replacement binding committed while the Write callback awaits account authorization', async () => {
  const { h, approval, invocation, replaceApproval } = await studio();
  try {
    h.controls.beforeWrite = () => {
      h.controls.authorizing = async () => {
        h.controls.authorizing = undefined;
        await replaceApproval(approval.revision, { ...approval.binding.typescript!, maxCalls: 2 });
      };
    };
    await expect(h.service.run(invocation, () => {}, h.actor)).rejects.toBeDefined();
    noWrite(h);
  } finally { h.close(); }
});

it.each(['canceled', 'crashed'])('recovers a journalled Write after native %s without another POST or asset creation', async status => {
  const { f, h, invocation } = await studio();
  try {
    h.controls.interrupted = true;
    h.controls.loseWriteReply = true;
    h.controls.terminalStatus = status;
    await expect(h.service.run(invocation, () => {}, h.actor)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION' });
    expect(h.assets.size).toBe(1);
    expect(h.controls.allowCreates.filter(Boolean)).toEqual([true]);
    expect(h.controls.dispatches).toBe(1);
    const writeKey = invocation.invocationId + ':write';
    const pending = h.repository.db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get(writeKey);
    expect(h.repository.db.prepare('SELECT response FROM dkg_component_calls WHERE id=?').get(writeKey).response).toBeNull();
    await restartNode(f.target); h.reopen();
    h.controls.interrupted = false; h.controls.nodeUnavailable = false;
    const result = await h.service.run(invocation, () => {}, h.actor);
    expect(result).toMatchObject({ invocationId: invocation.invocationId, n8nExecutionId: '42', persisted: true,
      readbackVerified: true, output: { ok: false, itemsJson: '[]' },
      dkgRecovery: { status: 'confirmed', invocationId: invocation.invocationId, n8nExecutionId: '42' } });
    expect(result.executionIri).toBe('urn:sr:execution:' + invocation.invocationId);
    expect(JSON.parse(h.repository.db.prepare('SELECT response FROM dkg_component_calls WHERE id=?').get(writeKey).response)).toEqual(result.dkgRecovery.receipt);
    expect(h.repository.db.prepare('SELECT request FROM dkg_component_calls WHERE id=?').get(writeKey).request).toBe(pending.request);
    expect(h.controls.allowCreates.at(-1)).toBe(false);
    const transportCalls = h.effects.length;
    await restartNode(f.target); h.reopen();
    expect(await h.service.run(invocation, () => {}, h.actor)).toEqual(result);
    expect(h.effects).toHaveLength(transportCalls);
    expect(h.controls.allowCreates.filter(Boolean)).toEqual([true]);
    expect(h.assets.size).toBe(1);
    expect(h.controls.dispatches).toBe(1);
  } finally { h.close(); }
});


it('retains a 35-second Program callback beyond both former polling windows under its original invocation', async () => {
  const { f, h, invocation } = await studio({ withProgram: true });
  let parentAtCompletion: string | undefined;
  try {
    h.controls.earlyAcknowledgement = true;
    h.controls.invokeProgram = async (request: any) => {
      await delay(35_000);
      const executionId = 'urn:sr:execution:' + invocation.invocationId;
      parentAtCompletion = f.target.runtime!.store.execution(executionId)?.status;
      return { invocationId: request.invocationId, operationIri: request.selected.operationIri,
        sourceHash: request.selected.program.sourceHash, bindingDigest: request.selected.bindingDigest,
        executionIri: 'urn:sr:execution:' + request.invocationId, outputs: [{ sum: 7 }] };
    };
    const result = await h.service.run(invocation, () => {}, h.actor);
    await h.controls.finished;
    expect(result).toMatchObject({ invocationId: invocation.invocationId, n8nExecutionId: '42',
      executionIri: 'urn:sr:execution:' + invocation.invocationId, persisted: true, readbackVerified: true,
      output: { ok: true } });
    const response = JSON.parse(h.repository.db.prepare('SELECT response FROM dkg_component_calls WHERE id=?')
      .get(invocation.invocationId + ':program').response);
    expect(parentAtCompletion).toBe('active');
    expect(response.items[0].result).toEqual([{ sum: 7 }]);
    expect(JSON.parse(result.output.itemsJson)).toEqual(response.items);
    expect(h.controls.callbackStatuses).toEqual([200, 200]);
    expect(h.controls.callbackErrors).toEqual([]);
    expect(h.effects).toEqual(['read', 'invoke']);
    expect(h.controls.dispatches).toBe(1);
    await restartNode(f.target); h.reopen();
    expect(await h.service.run(invocation, () => {}, h.actor)).toEqual(result);
    expect(h.effects).toEqual(['read', 'invoke']);
    expect(h.controls.dispatches).toBe(1);
  } finally { await h.controls.finished; h.close(); }
}, 90_000);
