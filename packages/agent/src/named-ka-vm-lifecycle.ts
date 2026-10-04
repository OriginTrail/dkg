// SPDX-License-Identifier: Apache-2.0
import {
  ASSERTION_SEAL_PREDICATES, MemoryLayer, assertionLifecycleUri,
  contextGraphAssertionUri, contextGraphLayerUri, contextGraphMetaUri, formatSparqlTerm,
} from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, UnsupportedTripleStoreCapabilityError,
  type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
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

interface LifecycleMetadataPlan {
  readonly deletes: readonly Partial<Quad>[];
  readonly inserts: readonly Quad[];
  readonly metaGraph: string;
}
const bare = (value?: string) => value?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '').toLowerCase().replace(/^0x/, '');
function checkedRoot(value: string): string {
  const root = value.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(root)) throw Object.assign(new Error('Invalid confirmed lifecycle root'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
  return root;
}

/** Pure metadata plan: workspace admission is complete before any row is mutated. */
function planPublishedNamedKaVmLifecycle(
  input: PublishedNamedKaVmLifecycleInput, workspace: Record<string, string> | undefined,
): LifecycleMetadataPlan {
  const assertionUri = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const lifecycleUri = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const metaGraph = contextGraphMetaUri(input.contextGraphId), root = checkedRoot(input.merkleRoot);
  const prior = input.priorMerkleRoot === undefined ? undefined : checkedRoot(input.priorMerkleRoot);
  const wm = bare(workspace?.wm), swm = bare(workspace?.swm), activeSeal = bare(workspace?.activeSeal);
  const reopenedDraft = bare(workspace?.state) === 'created' && bare(workspace?.layer) === 'wm' && activeSeal === undefined;
  const consumedTentativePrior = input.tentative === true && prior !== undefined && wm === prior;
  const preserveWorkspace = reopenedDraft || (activeSeal !== undefined && activeSeal !== root)
    || (wm !== undefined && wm !== root && !consumedTentativePrior) || (swm !== undefined && swm !== root);
  const deletes: Partial<Quad>[] = [], inserts: Quad[] = [];
  const replace = (subject: string, predicate: string, object: string) => {
    deletes.push({ subject, predicate, graph: metaGraph });
    inserts.push({ subject, predicate, object, graph: metaGraph });
  };
  replace(lifecycleUri, VM_CURRENT_ASSERTION_PRED, JSON.stringify(root));
  if (!preserveWorkspace && (wm === root || consumedTentativePrior)) {
    deletes.push({ subject: lifecycleUri, predicate: WM_CURRENT_ASSERTION_PRED, graph: metaGraph });
  }
  if (prior !== undefined) {
    const priorUri = `${lifecycleUri}#assertion-${prior}`;
    inserts.push(
      { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasRevisionOf', object: priorUri, graph: metaGraph },
      { subject: priorUri, predicate: VM_CURRENT_ASSERTION_PRED, object: JSON.stringify(prior), graph: metaGraph },
    );
  }
  if (!preserveWorkspace) {
    for (const subject of [lifecycleUri, assertionUri]) replace(subject, MEMORY_LAYER_PRED, JSON.stringify(MemoryLayer.VerifiableMemory));
    replace(lifecycleUri, STATE_PRED, '"published"');
  }
  replace(lifecycleUri, PUBLISHED_UAL_PRED, JSON.stringify(input.publishedUal));
  if (input.packedKaId !== undefined && !preserveWorkspace) {
    const author = `0x${(input.packedKaId >> 96n).toString(16).padStart(40, '0')}`;
    const number = input.packedKaId & ((1n << 96n) - 1n);
    replace(lifecycleUri, ASSERTION_GRAPH_PRED, contextGraphLayerUri(input.contextGraphId, MemoryLayer.VerifiableMemory, author, number, input.subGraphName));
    replace(contextGraphLayerUri(input.contextGraphId, MemoryLayer.WorkingMemory, author, number, input.subGraphName), MEMORY_LAYER_PRED, JSON.stringify(MemoryLayer.VerifiableMemory));
  }
  return { deletes, inserts, metaGraph };
}

/** One request on certified atomic backends; typed preflight refusal alone permits fallback. */
async function commitLifecycleMetadata(store: TripleStore, plan: LifecycleMetadataPlan): Promise<void> {
  if (store.atomicUpdate) {
    const term = (value: string, position: 'subject' | 'predicate' | 'object' | 'graph') => formatSparqlTerm(value, { position });
    const graph = term(plan.metaGraph, 'graph');
    const deletes = plan.deletes.map(q => `DELETE WHERE { GRAPH ${graph} { ${term(q.subject!, 'subject')} ${term(q.predicate!, 'predicate')} ?o } }`);
    const inserts = plan.inserts.map(q => `${term(q.subject, 'subject')} ${term(q.predicate, 'predicate')} ${term(q.object, 'object')} .`).join('\n');
    try {
      await store.atomicUpdate([...deletes, `INSERT DATA { GRAPH ${graph} { ${inserts} } }`].join(';\n'), {
        source: 'agent.publish.confirmedLifecycleCommit', touchedGraphs: [plan.metaGraph],
      });
      return;
    } catch (error) {
      if (!(error instanceof UnsupportedTripleStoreCapabilityError) || error.capability !== 'atomicUpdate') throw error;
    }
  }
  // Compatibility stores expose partial writes. The admitted durable repair journal
  // retries this idempotent plan after failures; update() alone is never certification.
  for (const pattern of plan.deletes) await deleteByPatternWithoutCount(store, pattern);
  await store.insert([...plan.inserts]);
}

/** Caller holds the publisher's same-KA lifecycle lock across admission and commit. */
export async function applyPublishedNamedKaVmLifecycle(store: TripleStore, input: PublishedNamedKaVmLifecycleInput): Promise<void> {
  const assertionUri = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const lifecycleUri = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const metaGraph = contextGraphMetaUri(input.contextGraphId);
  // Validate inputs before I/O and use the shared RDF serializer at the query boundary.
  checkedRoot(input.merkleRoot);
  if (input.priorMerkleRoot !== undefined) checkedRoot(input.priorMerkleRoot);
  const iri = (value: string) => formatSparqlTerm(value, { position: 'subject' });
  const rows = await store.query(`SELECT ?wm ?swm ?state ?layer ?activeSeal WHERE { GRAPH ${iri(metaGraph)} {
    OPTIONAL { ${iri(lifecycleUri)} <${WM_CURRENT_ASSERTION_PRED}> ?wm }
    OPTIONAL { ${iri(lifecycleUri)} <${SWM_CURRENT_ASSERTION_PRED}> ?swm }
    OPTIONAL { ${iri(lifecycleUri)} <${STATE_PRED}> ?state }
    OPTIONAL { ${iri(lifecycleUri)} <${MEMORY_LAYER_PRED}> ?layer }
    OPTIONAL { ${iri(assertionUri)} <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?activeSeal }
  } } LIMIT 2`, { source: 'agent.publish.confirmedLifecycleWorkspaceGuard' });
  if (rows.type !== 'bindings' || rows.bindings.length > 1) {
    throw Object.assign(new Error('Invalid workspace pointers during confirmed lifecycle repair'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
  }
  await commitLifecycleMetadata(store, planPublishedNamedKaVmLifecycle(input, rows.bindings[0]));
}
