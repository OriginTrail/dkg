// SPDX-License-Identifier: Apache-2.0

import {
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
import { VM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';

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
    throw new Error(
      `Cannot stamp named KA VM lifecycle for "${input.name}": invalid merkle root ${input.merkleRoot}`,
    );
  }

  await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: VM_CURRENT_ASSERTION_PRED, graph: metaGraph });
  await store.insert([{
    subject: lifecycleUri,
    predicate: VM_CURRENT_ASSERTION_PRED,
    object: `"${bareMerkleRoot}"`,
    graph: metaGraph,
  }]);

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
  await deleteByPatternWithoutCount(store, { subject: lifecycleUri, predicate: PUBLISHED_UAL_PRED, graph: metaGraph });
  await store.insert([{
    subject: lifecycleUri,
    predicate: PUBLISHED_UAL_PRED,
    object: `"${input.publishedUal}"`,
    graph: metaGraph,
  }]);

  if (input.packedKaId === undefined) return;
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
