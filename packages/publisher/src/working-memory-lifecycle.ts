// SPDX-License-Identifier: Apache-2.0
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { assertSafeIri, assertionLifecycleUri, contextGraphMetaUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { stripOptionalLiteral } from './sparql-binding-literal.js';

/**
 * A draft mutation is only valid while the lifecycle is exactly created/WM.
 * The checks are separate and bounded so corrupt duplicate rows cannot form
 * an unbounded Cartesian product in a recovery path.
 */
export async function assertWorkingMemoryLifecycleMutable(
  store: TripleStore,
  contextGraphId: string,
  name: string,
  agentAddress: string,
  subGraphName?: string,
): Promise<void> {
  const lifecycle = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const [stateResult, layerResult] = await Promise.all([
    store.query(
      `SELECT ?state WHERE { GRAPH <${assertSafeIri(metaGraph)}> {
        <${assertSafeIri(lifecycle)}> <http://dkg.io/ontology/state> ?state
      } } LIMIT 2`,
    ),
    store.query(
      `SELECT ?layer WHERE { GRAPH <${assertSafeIri(metaGraph)}> {
        <${assertSafeIri(lifecycle)}> <http://dkg.io/ontology/memoryLayer> ?layer
      } } LIMIT 2`,
    ),
  ]);
  if (
    stateResult.type !== 'bindings' || layerResult.type !== 'bindings'
    || stateResult.bindings.length > 1 || layerResult.bindings.length > 1
  ) {
    throw Object.assign(
      new Error(`Assertion "${name}" has a corrupt Working Memory lifecycle record`),
      { code: 'KA_WM_LIFECYCLE_CORRUPT' },
    );
  }
  const state = stateResult.type === 'bindings' && stateResult.bindings.length === 1
    ? stripOptionalLiteral(stateResult.bindings[0]?.['state'])
    : undefined;
  const layer = layerResult.type === 'bindings' && layerResult.bindings.length === 1
    ? stripOptionalLiteral(layerResult.bindings[0]?.['layer'])
    : undefined;
  if (state !== 'created' || layer !== MemoryLayer.WorkingMemory) {
    throw Object.assign(
      new Error(
        `Assertion "${name}" is not an active Working Memory draft; reopen it before mutating it`,
      ),
      { code: 'KA_WM_LIFECYCLE_REQUIRED' },
    );
  }
}

