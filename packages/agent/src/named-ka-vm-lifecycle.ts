// SPDX-License-Identifier: Apache-2.0

import {
  ASSERTION_SEAL_PREDICATES,
  MemoryLayer,
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  deleteByPatternWithoutCount,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { VM_CURRENT_ASSERTION_PRED, WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';

const MEMORY_LAYER_PRED = 'http://dkg.io/ontology/memoryLayer';
const STATE_PRED = 'http://dkg.io/ontology/state';
const PUBLISHED_UAL_PRED = 'http://dkg.io/ontology/publishedUal';
const ASSERTION_GRAPH_PRED = 'http://dkg.io/ontology/assertionGraph';

export interface PublishedNamedKaVmLifecycleInput {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly publishedUal: string;
  /** The chain-current root to materialize, which may supersede the queued root. */
  readonly merkleRoot: string;
  readonly packedKaId?: bigint;
  readonly priorMerkleRoot?: string;
  /** Tentative updates consume the prior sealed WM projection without claiming a VM graph. */
  readonly tentative?: boolean;
}

/** Canonical idempotent writer used by both normal publish and tx recovery. */
export async function applyPublishedNamedKaVmLifecycle(
  store: TripleStore,
  input: PublishedNamedKaVmLifecycleInput,
): Promise<void> {
  const assertionUri = contextGraphAssertionUri(
    input.contextGraphId,
    input.agentAddress,
    input.name,
    input.subGraphName,
  );
  const lifecycleUri = assertionLifecycleUri(
    input.contextGraphId,
    input.agentAddress,
    input.name,
    input.subGraphName,
  );
  const metaGraph = contextGraphMetaUri(input.contextGraphId);
  const bareMerkleRoot = input.merkleRoot.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(bareMerkleRoot)) {
    throw Object.assign(new Error(
      `Cannot stamp named KA VM lifecycle for "${input.name}": invalid merkle root ${input.merkleRoot}`,
    ), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
  }

  const prior = input.priorMerkleRoot?.toLowerCase().replace(/^0x/, '');
  if (prior !== undefined && !/^[0-9a-f]{64}$/.test(prior)) {
    throw Object.assign(new Error('Invalid prior confirmed root during lifecycle repair'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
  }

  const workspacePointers = await store.query(`SELECT ?wm ?swm ?state ?layer ?activeSeal WHERE { GRAPH <${metaGraph}> {
    OPTIONAL { <${lifecycleUri}> <${WM_CURRENT_ASSERTION_PRED}> ?wm }
    OPTIONAL { <${lifecycleUri}> <${SWM_CURRENT_ASSERTION_PRED}> ?swm }
    OPTIONAL { <${lifecycleUri}> <${STATE_PRED}> ?state }
    OPTIONAL { <${lifecycleUri}> <${MEMORY_LAYER_PRED}> ?layer }
    OPTIONAL { <${assertionUri}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?activeSeal }
  } } LIMIT 2`, { source: 'agent.publish.confirmedLifecycleWorkspaceGuard' });
  if (workspacePointers.type !== 'bindings' || workspacePointers.bindings.length > 1) {
    throw Object.assign(new Error('Invalid workspace pointers during confirmed lifecycle repair'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
  }
  const bare = (value?: string) => value?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '').toLowerCase().replace(/^0x/, '');
  const workspace = workspacePointers.bindings[0];
  const wm = bare(workspace?.wm);
  const swm = bare(workspace?.swm);
  const activeSeal = bare(workspace?.activeSeal);
  const reopenedDraft = bare(workspace?.state) === 'created' && bare(workspace?.layer) === 'wm' && activeSeal === undefined;
  const consumedTentativePrior = input.tentative === true && prior !== undefined && wm === prior;
  const preserveWorkspace = reopenedDraft
    || (activeSeal !== undefined && activeSeal !== bareMerkleRoot)
    || (wm !== undefined && wm !== bareMerkleRoot && !consumedTentativePrior)
    || (swm !== undefined && swm !== bareMerkleRoot);

  await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: VM_CURRENT_ASSERTION_PRED, graph: metaGraph });
  await store.insert([{
    subject: lifecycleUri,
    predicate: VM_CURRENT_ASSERTION_PRED,
    object: `"${bareMerkleRoot}"`,
    graph: metaGraph,
  }]);

  if (!preserveWorkspace && (wm === bareMerkleRoot || consumedTentativePrior)) {
    await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: WM_CURRENT_ASSERTION_PRED, graph: metaGraph });
  }
  if (prior !== undefined) {
    const priorUri = `${lifecycleUri}#assertion-${prior}`;
    await store.insert([
      { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasRevisionOf', object: priorUri, graph: metaGraph },
      { subject: priorUri, predicate: VM_CURRENT_ASSERTION_PRED, object: `"${prior}"`, graph: metaGraph },
    ]);
  }
  if (!preserveWorkspace) {
    for (const subject of [lifecycleUri, assertionUri]) {
      await deleteByPatternWithoutCount(store, { subject, predicate: MEMORY_LAYER_PRED, graph: metaGraph });
      await store.insert([{
        subject,
        predicate: MEMORY_LAYER_PRED,
        object: `"${MemoryLayer.VerifiableMemory}"`,
        graph: metaGraph,
      }]);
    }
    await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: STATE_PRED, graph: metaGraph });
    await store.insert([{
      subject: lifecycleUri,
      predicate: STATE_PRED,
      object: '"published"',
      graph: metaGraph,
    }]);
  }
  await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: PUBLISHED_UAL_PRED, graph: metaGraph });
  await store.insert([{
    subject: lifecycleUri,
    predicate: PUBLISHED_UAL_PRED,
    object: `"${input.publishedUal}"`,
    graph: metaGraph,
  }]);

  if (input.packedKaId === undefined || preserveWorkspace) return;
  const vmAuthor = `0x${(input.packedKaId >> 96n).toString(16).padStart(40, '0')}`;
  const vmNumber = input.packedKaId & ((1n << 96n) - 1n);
  const vmGraph = contextGraphLayerUri(
    input.contextGraphId,
    MemoryLayer.VerifiableMemory,
    vmAuthor,
    vmNumber,
    input.subGraphName,
  );
  await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: ASSERTION_GRAPH_PRED, graph: metaGraph });
  await store.insert([{
    subject: lifecycleUri,
    predicate: ASSERTION_GRAPH_PRED,
    object: vmGraph,
    graph: metaGraph,
  }]);

  const wmGraph = contextGraphLayerUri(
    input.contextGraphId,
    MemoryLayer.WorkingMemory,
    vmAuthor,
    vmNumber,
    input.subGraphName,
  );
  await deleteByPatternWithoutCount(store, { subject: wmGraph, predicate: MEMORY_LAYER_PRED, graph: metaGraph });
  await store.insert([{
    subject: wmGraph,
    predicate: MEMORY_LAYER_PRED,
    object: `"${MemoryLayer.VerifiableMemory}"`,
    graph: metaGraph,
  }]);
}
