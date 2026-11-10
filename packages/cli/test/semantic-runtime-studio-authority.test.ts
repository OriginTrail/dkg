import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runInThisContext, constants as vmConstants } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupRuntimeFixtures, graph, owner, SR, toolFixture, restartNode, invalidateExecutionCapability } from './_helpers/semantic-runtime-api-fixture.js';
import { createNativeCallbackAuthority } from '../src/semantic-runtime-native-callback-authority.js';
import { assertExecutionCapabilityAuthorized } from '../src/semantic-runtime-invocation-policy.js';

afterEach(async () => { vi.unstubAllGlobals(); await cleanupRuntimeFixtures(); });

async function studio({ childDepth = 0 } = {}) {
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
    config: f.target.config.semanticRuntime, client: { programs }, programAuthority: authority,
    loadOutputs: async (iri: string) => (await f.store.query(`SELECT ?output WHERE { GRAPH ?g { <${iri}> <${SR}output> ?output } }`)).bindings
      .map((row: any) => JSON.parse(row.output)) });
  vi.stubGlobal('fetch', h.runtimeFetch);
  h.controls.interrupted = false;
  const workflow = await h.service.save(h.definition, () => {});
  const approval = await f.manager.programs.getApproval({ graphId: graph, operationIri: workflow.kaRef });
  const invocation = { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, itemsJson: '[{}]', invocationId: randomUUID() };
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
      expect(h.repository.db.prepare('SELECT 1 FROM dkg_component_writes WHERE id=?').get(writeKey)).toBeUndefined();
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
