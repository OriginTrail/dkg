// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { VM_CURRENT_ASSERTION_PRED, WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import * as pointerWriter from '../src/lifecycle-pointer-writer.js';

const CG = 'pointer-writer', AUTHOR = `0x${'11'.repeat(20)}`, NAME = 'asset';
const GRAPH = contextGraphMetaUri(CG), SUBJECT = assertionLifecycleUri(CG, AUTHOR, NAME);
const ROOT = 'ab'.repeat(32), STALE = 'cd'.repeat(32);
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

async function fixture(pred: string, vm = ROOT) {
  const store = new OxigraphStore(); stores.push(store);
  await store.insert([
    { graph: GRAPH, subject: SUBJECT, predicate: pred, object: JSON.stringify(STALE) },
    { graph: GRAPH, subject: SUBJECT, predicate: VM_CURRENT_ASSERTION_PRED, object: JSON.stringify(vm) },
  ]);
  const read = () => store.query(`SELECT ?root WHERE { GRAPH <${GRAPH}> { <${SUBJECT}> <${pred}> ?root } }`);
  return { store, read };
}

describe('one divergence-only lifecycle pointer policy', () => {
  it.each([WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED])('deletes a stale %s row when its new root equals VM', async pred => {
    const f = await fixture(pred);
    await pointerWriter.stampLifecyclePointerIfDivergedFromVm(f.store, SUBJECT, pred, `0x${ROOT}`, GRAPH);
    expect(await f.read()).toEqual({ type: 'bindings', bindings: [] });
  });

  it.each([WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED])('replaces a divergent %s root without retaining its stale value', async pred => {
    const f = await fixture(pred, STALE);
    await pointerWriter.stampLifecyclePointerIfDivergedFromVm(f.store, SUBJECT, pred, `0x${ROOT}`, GRAPH);
    expect(await f.read()).toEqual({ type: 'bindings', bindings: [{ root: JSON.stringify(ROOT) }] });
  });

  it.each([WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED])('writes %s when its VM guard read fails', async pred => {
    const f = await fixture(pred);
    vi.spyOn(f.store, 'query').mockRejectedValueOnce(new Error('VM read unavailable'));
    await pointerWriter.stampLifecyclePointerIfDivergedFromVm(f.store, SUBJECT, pred, `0x${ROOT}`, GRAPH);
    expect(await f.read()).toEqual({ type: 'bindings', bindings: [{ root: JSON.stringify(ROOT) }] });
  });

  it('delegates inherited agent pointer writes to the shared store policy', async () => {
    const f = await fixture(SWM_CURRENT_ASSERTION_PRED, STALE);
    const agent = Object.create(DKGAgent.prototype) as DKGAgent;
    Object.assign(agent, { store: f.store });
    const divergent = vi.spyOn(pointerWriter, 'stampLifecyclePointerIfDivergedFromVm');
    const stamp = vi.spyOn(pointerWriter, 'stampLifecyclePointer');
    await agent._stampPointerIfDivergedFromVm(SUBJECT, SWM_CURRENT_ASSERTION_PRED, ROOT, GRAPH);
    expect(divergent).toHaveBeenCalledExactlyOnceWith(f.store, SUBJECT, SWM_CURRENT_ASSERTION_PRED, ROOT, GRAPH);
    expect(await f.read()).toEqual({ type: 'bindings', bindings: [{ root: JSON.stringify(ROOT) }] });
    await agent._stampPointer(SUBJECT, SWM_CURRENT_ASSERTION_PRED, STALE, GRAPH);
    expect(stamp).toHaveBeenCalledWith(f.store, SUBJECT, SWM_CURRENT_ASSERTION_PRED, STALE, GRAPH);
    expect(await f.read()).toEqual({ type: 'bindings', bindings: [{ root: JSON.stringify(STALE) }] });
  });

  it.each([ROOT, STALE])('atomically consumes only a WM pointer matching publication (%s)', async wm => {
    const f = await fixture(WM_CURRENT_ASSERTION_PRED, STALE);
    await f.store.replaceSubjectPredicates(GRAPH, SUBJECT, [WM_CURRENT_ASSERTION_PRED], [
      { graph: GRAPH, subject: SUBJECT, predicate: WM_CURRENT_ASSERTION_PRED, object: JSON.stringify(wm) },
    ]);
    const commit = vi.spyOn(f.store, 'atomicUpdate');
    const divergent = vi.spyOn(pointerWriter, 'stampLifecyclePointerIfDivergedFromVm');
    await applyPublishedNamedKaVmLifecycle(f.store, {
      contextGraphId: CG, agentAddress: AUTHOR, name: NAME, publishedUal: 'urn:published:asset',
      merkleRoot: `0x${ROOT}`,
    }, { persistence: 'process-local' });
    expect(commit).toHaveBeenCalledTimes(1);
    // The confirmed command keeps convergence in its one atomic metadata plan.
    // A later draft must survive, even when its old root happens to equal prior VM.
    expect(divergent).not.toHaveBeenCalled();
    expect(await f.read()).toEqual({ type: 'bindings', bindings: wm === ROOT ? [] : [{ root: JSON.stringify(STALE) }] });
    expect(await f.store.query(`SELECT ?root WHERE { GRAPH <${GRAPH}> { <${SUBJECT}> <${VM_CURRENT_ASSERTION_PRED}> ?root } }`))
      .toEqual({ type: 'bindings', bindings: [{ root: JSON.stringify(ROOT) }] });
  });
});
