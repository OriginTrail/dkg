// SPDX-License-Identifier: Apache-2.0
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import {
  ASSERTION_SEAL_PREDICATES, MemoryLayer, assertionLifecycleUri,
  contextGraphAssertionUri, contextGraphLayerUri, contextGraphMetaUri, formatSparqlTerm,
} from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, UnsupportedTripleStoreCapabilityError,
  type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { VM_CURRENT_ASSERTION_PRED, WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';

import { stripMetadataLiteral } from './sync/metadata-literal.js';

const MEMORY_LAYER_PRED = 'http://dkg.io/ontology/memoryLayer';
const STATE_PRED = 'http://dkg.io/ontology/state';
const PUBLISHED_UAL_PRED = 'http://dkg.io/ontology/publishedUal';
const ASSERTION_GRAPH_PRED = 'http://dkg.io/ontology/assertionGraph';

export interface NamedKaVmLifecycleFields {
  readonly contextGraphId: string;
  readonly agentAddress: string;
  readonly name: string;
  readonly subGraphName?: string;
  readonly publishedUal: string;
  /** The chain-current root to materialize, which may supersede the queued root. */
  readonly merkleRoot: string;
  readonly priorMerkleRoot?: string;
}
/** A confirmed command cannot bypass the certified persistence barrier. */
export interface PublishedNamedKaVmLifecycleInput extends NamedKaVmLifecycleFields {
  readonly packedKaId?: bigint;
  /** With the root, identifies this publication's own seal; a re-finalize can repeat the root. */
  readonly assertionVersion: string;
  readonly tentative?: never;
}
/** Tentative updates consume the prior sealed WM projection without claiming a VM graph. */
export interface TentativeNamedKaVmLifecycleInput extends NamedKaVmLifecycleFields {
  readonly tentative: true;
  readonly packedKaId?: never;
}
type NamedKaVmLifecycleCommand = PublishedNamedKaVmLifecycleInput | TentativeNamedKaVmLifecycleInput;

export interface NamedKaVmLifecycleApplyOptions {
  /** A durable repair journal always selects restart-durable; standalone SDK hosts may select process-local. */
  readonly persistence: 'restart-durable' | 'process-local';
}
/** A filesystem journal selects durability; a standalone SDK may commit within its process. */
export function confirmedNamedKaVmLifecycleApplyOptions(dataDir?: string): NamedKaVmLifecycleApplyOptions {
  return { persistence: dataDir ? 'restart-durable' : 'process-local' };
}

interface LifecycleMetadataPlan {
  readonly deletes: readonly Pick<Quad, 'subject' | 'predicate'>[];
  readonly inserts: readonly Omit<Quad, 'graph'>[];
  readonly metaGraph: string;
}
interface WorkspaceLifecycleValues {
  readonly wm?: string;
  readonly swm?: string;
  readonly activeSeal?: string;
  readonly activeSealVersion?: string;
  readonly state?: string;
  readonly layer?: string;
}

/** Decode RDF once at the storage boundary, then apply each field's normalization contract. */
function decodeWorkspaceLifecycleValues(bindings: Record<string, string> | undefined): WorkspaceLifecycleValues {
  const root = (term?: string) => stripMetadataLiteral(term)?.toLowerCase().replace(/^0x/, '');
  return { wm: root(bindings?.wm), swm: root(bindings?.swm), activeSeal: root(bindings?.activeSeal),
    activeSealVersion: stripMetadataLiteral(bindings?.activeSealVersion)?.trim(),
    state: stripMetadataLiteral(bindings?.state)?.toLowerCase(), layer: stripMetadataLiteral(bindings?.layer)?.toUpperCase() };
}
/** A missing or malformed version on either side never proves that the seal is this publication's. */
function sameAssertionVersion(sealed: string | undefined, confirmed: string): boolean {
  const digits = /^[0-9]+$/;
  return sealed !== undefined && digits.test(sealed) && digits.test(confirmed) && BigInt(sealed) === BigInt(confirmed);
}
function checkedRoot(value: string): string {
  const root = value.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(root)) throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed lifecycle root');
  return root;
}

/** Pure metadata plan: workspace admission is complete before any row is mutated. */
function planPublishedNamedKaVmLifecycle(
  input: NamedKaVmLifecycleCommand, workspace: WorkspaceLifecycleValues,
): LifecycleMetadataPlan {
  const assertionUri = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const lifecycleUri = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const metaGraph = contextGraphMetaUri(input.contextGraphId), root = checkedRoot(input.merkleRoot);
  const prior = input.priorMerkleRoot === undefined ? undefined : checkedRoot(input.priorMerkleRoot);
  const { wm, swm, activeSeal } = workspace;
  const reopenedDraft = workspace.state === 'created' && workspace.layer === MemoryLayer.WorkingMemory && activeSeal === undefined;
  const consumedTentativePrior = input.tentative === true && prior !== undefined && wm === prior;
  // An unchanged re-finalize seals a newer version under the same root, so a
  // confirmed command owns the active seal only at its own assertion version.
  // Tentative commands carry no version and keep the root comparison.
  const ownsActiveSeal = activeSeal === root
    && (input.tentative === true || sameAssertionVersion(workspace.activeSealVersion, input.assertionVersion));
  const preserveWorkspace = reopenedDraft || (activeSeal !== undefined && !ownsActiveSeal)
    || (wm !== undefined && wm !== root && !consumedTentativePrior) || (swm !== undefined && swm !== root);
  const deletes: Pick<Quad, 'subject' | 'predicate'>[] = [], inserts: Omit<Quad, 'graph'>[] = [];
  const replace = (subject: string, predicate: string, object: string) => {
    deletes.push({ subject, predicate });
    inserts.push({ subject, predicate, object });
  };
  replace(lifecycleUri, VM_CURRENT_ASSERTION_PRED, JSON.stringify(root));
  if (!preserveWorkspace && (wm === root || consumedTentativePrior)) {
    deletes.push({ subject: lifecycleUri, predicate: WM_CURRENT_ASSERTION_PRED });
  }
  if (prior !== undefined) {
    const priorUri = `${lifecycleUri}#assertion-${prior}`;
    inserts.push(
      { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasRevisionOf', object: priorUri },
      { subject: priorUri, predicate: VM_CURRENT_ASSERTION_PRED, object: JSON.stringify(prior) },
    );
  }
  if (!preserveWorkspace) {
    for (const subject of [lifecycleUri, assertionUri]) replace(subject, MEMORY_LAYER_PRED, JSON.stringify(MemoryLayer.VerifiableMemory));
    replace(lifecycleUri, STATE_PRED, '"published"');
  }
  replace(lifecycleUri, PUBLISHED_UAL_PRED, JSON.stringify(input.publishedUal));
  if (input.tentative !== true && input.packedKaId !== undefined && !preserveWorkspace) {
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
    const deletes = plan.deletes.map(q => `DELETE WHERE { GRAPH ${graph} { ${term(q.subject, 'subject')} ${term(q.predicate, 'predicate')} ?o } }`);
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
  for (const target of plan.deletes) await deleteByPatternWithoutCount(store, { ...target, graph: plan.metaGraph });
  await store.insert(plan.inserts.map(triple => ({ ...triple, graph: plan.metaGraph })));
}

/** Caller holds the publisher's same-KA lifecycle lock across admission and commit. */
export async function applyPublishedNamedKaVmLifecycle(
  store: TripleStore, input: PublishedNamedKaVmLifecycleInput,
  options: NamedKaVmLifecycleApplyOptions = { persistence: 'restart-durable' },
): Promise<void> {
  if ('tentative' in input) throw new NamedKaVmLifecycleIntegrityError('Confirmed lifecycle commands cannot carry tentative mode');
  await applyNamedKaVmLifecycle(store, input, options.persistence);
}
export async function applyTentativeNamedKaVmLifecycle(store: TripleStore, input: TentativeNamedKaVmLifecycleInput): Promise<void> {
  if (input.tentative !== true || 'packedKaId' in input) throw new NamedKaVmLifecycleIntegrityError('Tentative lifecycle commands require tentative mode without confirmed graph coordinates');
  await applyNamedKaVmLifecycle(store, input, 'process-local');
}
async function applyNamedKaVmLifecycle(
  store: TripleStore, input: NamedKaVmLifecycleCommand,
  persistenceMode: NamedKaVmLifecycleApplyOptions['persistence'],
): Promise<void> {
  const tentative = input.tentative === true;
  const assertionUri = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const lifecycleUri = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const metaGraph = contextGraphMetaUri(input.contextGraphId);
  // Validate inputs before I/O and use the shared RDF serializer at the query boundary.
  checkedRoot(input.merkleRoot);
  if (input.priorMerkleRoot !== undefined) checkedRoot(input.priorMerkleRoot);
  const capability = store.commitment;
  const barrier = capability !== undefined
    && (capability.durability === 'restart-durable' || persistenceMode === 'process-local')
    ? capability.commit.bind(capability) : undefined;
  if (!tentative && barrier === undefined) {
    throw Object.assign(new Error('Confirmed lifecycle repair awaits an explicitly certified persistence barrier'), {
      code: 'KA_VM_LIFECYCLE_DURABILITY_UNAVAILABLE',
    });
  }
  const iri = (value: string) => formatSparqlTerm(value, { position: 'subject' });
  const rows = await store.query(`SELECT ?wm ?swm ?state ?layer ?activeSeal ?activeSealVersion WHERE { GRAPH ${iri(metaGraph)} {
    OPTIONAL { ${iri(lifecycleUri)} <${WM_CURRENT_ASSERTION_PRED}> ?wm }
    OPTIONAL { ${iri(lifecycleUri)} <${SWM_CURRENT_ASSERTION_PRED}> ?swm }
    OPTIONAL { ${iri(lifecycleUri)} <${STATE_PRED}> ?state }
    OPTIONAL { ${iri(lifecycleUri)} <${MEMORY_LAYER_PRED}> ?layer }
    OPTIONAL { ${iri(assertionUri)} <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?activeSeal }
    OPTIONAL { ${iri(assertionUri)} <${ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION}> ?activeSealVersion }
  } } LIMIT 2`, { source: 'agent.publish.confirmedLifecycleWorkspaceGuard' });
  if (rows.type !== 'bindings' || rows.bindings.length > 1) {
    throw new NamedKaVmLifecycleIntegrityError('Invalid workspace pointers during confirmed lifecycle repair');
  }
  await commitLifecycleMetadata(store, planPublishedNamedKaVmLifecycle(input, decodeWorkspaceLifecycleValues(rows.bindings[0])));
  // Graph writes can be visible before the debounced snapshot is on disk. The
  // repair owner may retire its fsynced journal only after this barrier succeeds.
  if (barrier !== undefined) await barrier({ source: 'agent.publish.confirmedLifecycleFlush' });
  else await store.flush?.({ source: 'agent.publish.confirmedLifecycleFlush' });
}
