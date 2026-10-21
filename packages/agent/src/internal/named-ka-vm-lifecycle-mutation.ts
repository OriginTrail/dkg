// SPDX-License-Identifier: Apache-2.0
import { MemoryLayer, assertionLifecycleUri, contextGraphAssertionUri, contextGraphLayerUri,
  contextGraphMetaUri, formatSparqlTerm } from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { VM_CURRENT_ASSERTION_PRED, WM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';
import { NamedKaVmLifecycleIntegrityError } from '../named-ka-vm-lifecycle-integrity-error.js';
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
  readonly merkleRoot: string;
  readonly priorMerkleRoot?: string;
}
/** Each entry point retains its operation contract at the projection boundary. */
export interface PublishedNamedKaVmLifecycleInput extends NamedKaVmLifecycleFields {
  readonly packedKaId?: bigint;
  readonly assertionVersion: string;
  readonly tentative?: never;
}
export interface TentativeNamedKaVmLifecycleInput extends NamedKaVmLifecycleFields {
  readonly tentative: true;
  readonly packedKaId?: never;
  readonly assertionVersion?: never;
}
export interface VerifiedNamedKaDescriptorInput extends NamedKaVmLifecycleFields {
  readonly packedKaId?: bigint;
  readonly tentative?: never;
  readonly assertionVersion?: never;
  readonly preserveVerifiedVmProof?: boolean;
}
type ObservedWorkspace = { readonly kind: 'observed'; readonly values: WorkspaceLifecycleValues };
export type NamedKaVmLifecycleProjectionCommand =
  | (PublishedNamedKaVmLifecycleInput & { readonly kind: 'confirmed'; readonly workspace: ObservedWorkspace; readonly preserveVerifiedVmProof: boolean })
  | (TentativeNamedKaVmLifecycleInput & { readonly kind: 'tentative'; readonly workspace: ObservedWorkspace; readonly preserveVerifiedVmProof: false })
  | (VerifiedNamedKaDescriptorInput & { readonly kind: 'verified-descriptor'; readonly workspace: { readonly kind: 'verified' }; readonly preserveVerifiedVmProof: boolean });
export interface WorkspaceLifecycleValues {
  readonly wm?: string;
  readonly swm?: string;
  readonly activeSeal?: string;
  readonly activeSealVersion?: string;
  readonly state?: string;
  readonly layer?: string;
}

type LifecycleWrite =
  | { readonly kind: 'replace'; readonly target: Pick<Quad, 'subject' | 'predicate' | 'graph'>; readonly quads: Quad[] }
  | { readonly kind: 'remove'; readonly target: Pick<Quad, 'subject' | 'predicate' | 'graph'> };

function sameAssertionVersion(sealed: string | undefined, confirmed: string): boolean {
  const digits = /^[0-9]+$/;
  return sealed !== undefined && digits.test(sealed) && digits.test(confirmed) && BigInt(sealed) === BigInt(confirmed);
}
export function checkedRoot(value: string): string {
  const root = value.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(root)) throw new NamedKaVmLifecycleIntegrityError('Invalid confirmed lifecycle root');
  return root;
}

export function buildNamedKaVmLifecycleMutation(
  input: NamedKaVmLifecycleProjectionCommand,
) {
  const assertionUri = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const lifecycleUri = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const metaGraph = contextGraphMetaUri(input.contextGraphId), root = checkedRoot(input.merkleRoot);
  const prior = input.priorMerkleRoot === undefined ? undefined : checkedRoot(input.priorMerkleRoot);
  const workspace = input.workspace.kind === 'observed' ? input.workspace.values : {};
  const { preserveVerifiedVmProof } = input;
  const { wm, swm, activeSeal } = workspace;
  const reopenedDraft = workspace.state === 'created' && workspace.layer === MemoryLayer.WorkingMemory && activeSeal === undefined;
  const consumedTentativePrior = input.kind === 'tentative' && prior !== undefined && wm === prior;
  // An unchanged re-finalize seals a newer version under the same root, so a
  // confirmed command owns the active seal only at its own assertion version.
  // Tentative commands carry no version and keep the root comparison.
  const ownsActiveSeal = activeSeal === root
    && (input.kind === 'tentative' || (input.kind === 'confirmed' && sameAssertionVersion(workspace.activeSealVersion, input.assertionVersion)));
  const preserveWorkspace = reopenedDraft || (activeSeal !== undefined && !ownsActiveSeal)
    || (wm !== undefined && wm !== root && !consumedTentativePrior) || (swm !== undefined && swm !== root);
  const writes: LifecycleWrite[] = [], additions: Quad[] = [];
  const remove = (subject: string, predicate: string) => writes.push({ kind: 'remove', target: { subject, predicate, graph: metaGraph } });
  const replace = (subject: string, predicate: string, object: string) => {
    writes.push({ kind: 'replace', target: { subject, predicate, graph: metaGraph },
      quads: [{ subject, predicate, object, graph: metaGraph }] });
  };
  if (!preserveVerifiedVmProof) replace(lifecycleUri, VM_CURRENT_ASSERTION_PRED, JSON.stringify(root));
  if (!preserveWorkspace && (wm === root || consumedTentativePrior)) {
    remove(lifecycleUri, WM_CURRENT_ASSERTION_PRED);
  }
  if (prior !== undefined) {
    const priorUri = `${lifecycleUri}#assertion-${prior}`;
    additions.push(
      { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasRevisionOf', object: priorUri, graph: metaGraph },
      { subject: priorUri, predicate: VM_CURRENT_ASSERTION_PRED, object: JSON.stringify(prior), graph: metaGraph },
    );
  }
  if (!preserveWorkspace) {
    for (const subject of preserveVerifiedVmProof ? [assertionUri] : [lifecycleUri, assertionUri]) replace(subject, MEMORY_LAYER_PRED, JSON.stringify(MemoryLayer.VerifiableMemory));
    replace(lifecycleUri, STATE_PRED, '"published"');
  }
  replace(lifecycleUri, PUBLISHED_UAL_PRED, JSON.stringify(input.publishedUal));
  if (input.kind !== 'tentative' && input.packedKaId !== undefined && !preserveWorkspace) {
    const author = `0x${(input.packedKaId >> 96n).toString(16).padStart(40, '0')}`;
    const number = input.packedKaId & ((1n << 96n) - 1n);
    replace(lifecycleUri, ASSERTION_GRAPH_PRED, contextGraphLayerUri(input.contextGraphId, MemoryLayer.VerifiableMemory, author, number, input.subGraphName));
    // Promote moves the graph marker to SWM. Complete that move to the actual
    // VM graph; resurrecting a WM marker leaves stale SWM metadata behind.
    for (const layer of [MemoryLayer.WorkingMemory, MemoryLayer.SharedWorkingMemory]) {
      remove(contextGraphLayerUri(input.contextGraphId, layer, author, number, input.subGraphName), MEMORY_LAYER_PRED);
    }
    replace(contextGraphLayerUri(input.contextGraphId, MemoryLayer.VerifiableMemory, author, number, input.subGraphName), MEMORY_LAYER_PRED, JSON.stringify(MemoryLayer.VerifiableMemory));
  }
  const term = (value: string, position: 'subject' | 'predicate' | 'object' | 'graph') => formatSparqlTerm(value, { position });
  const graph = term(metaGraph, 'graph');
  const removals = writes.map(write => write.target);
  const quads = [...writes.flatMap(write => write.kind === 'replace' ? write.quads : []), ...additions];
  // Validate all terms before any path writes. Both dispatches use this exact projection.
  const deleteStatements = removals.map(q => `DELETE WHERE { GRAPH ${graph} { ${term(q.subject, 'subject')} ${term(q.predicate, 'predicate')} ?o } }`);
  const insertStatements = quads.map(q => `${term(q.subject, 'subject')} ${term(q.predicate, 'predicate')} ${term(q.object, 'object')} .`).join('\n');
  return { graph: metaGraph, writes, additions, mutation: { removals, quads },
    sparql: [...deleteStatements, `INSERT DATA { GRAPH ${graph} { ${insertStatements} } }`].join(';\n') };

}


/** Shared idempotent fallback, with independently verified retry proof excluded by the plan. */
export async function applyLifecycleMutationFallback(store: TripleStore, plan: ReturnType<typeof buildNamedKaVmLifecycleMutation>): Promise<void> {
  for (const write of plan.writes) {
    await deleteByPatternWithoutCount(store, write.target);
    if (write.kind === 'replace') await store.insert(write.quads);
  }
  if (plan.additions.length) await store.insert(plan.additions);
}
