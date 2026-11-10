import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runInThisContext, constants as vmConstants } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupRuntimeFixtures, graph, owner, SR, toolFixture, restartNode, invalidateExecutionCapability } from './_helpers/semantic-runtime-api-fixture.js';
import { createNativeCallbackAuthority } from '../src/semantic-runtime-native-callback-authority.js';

afterEach(async () => { vi.unstubAllGlobals(); await cleanupRuntimeFixtures(); });

async function studio() {
  // Real compiler, signed SDK route, TypeScript/Wasm runtime and SQLite journals.
  // Only the n8n HTTP provider and remote DKG transport are fictional.
  const { createStudioExecutionHarness } = await runInThisContext('(url) => import(url)',
    { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER })(
    new URL('../../../examples/n8n-capability/test-support/studio-execution-harness.mjs', import.meta.url).href);
  const f = await toolFixture('export function run() { return null; }', { graphId: graph }, []);
  const authority = createNativeCallbackAuthority({ agent: f.target.agent, runtime: () => f.target.runtime,
    config: f.target.config.semanticRuntime, graphId: graph, caller: owner });
  const h = createStudioExecutionHarness({ state: join(f.target.dir, 'studio'), graphId: graph, owner,
    config: f.target.config.semanticRuntime, client: f.manager, programAuthority: authority,
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
  return { f, h, workflow, approval, invocation, replaceApproval };
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
