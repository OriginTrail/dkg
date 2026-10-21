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
/** Projection policy is supplied by the entry point after its own proof/admission checks. */
export interface NamedKaVmLifecycleProjectionInput extends NamedKaVmLifecycleFields {
  readonly packedKaId?: bigint;
  readonly assertionVersion?: string;
  readonly tentative?: boolean;
  readonly preserveVerifiedVmProof?: boolean;
}
export interface WorkspaceLifecycleValues {
  readonly wm?: string;
  readonly swm?: string;
  readonly activeSeal?: string;
  readonly activeSealVersion?: string;
  readonly state?: string;
  readonly layer?: string;
}

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
  input: NamedKaVmLifecycleProjectionInput, workspace: WorkspaceLifecycleValues = {}, preserveVerifiedVmProof = input.preserveVerifiedVmProof ?? false,
) {
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
    && (input.tentative === true || sameAssertionVersion(workspace.activeSealVersion, input.assertionVersion ?? ''));
  const preserveWorkspace = reopenedDraft || (activeSeal !== undefined && !ownsActiveSeal)
    || (wm !== undefined && wm !== root && !consumedTentativePrior) || (swm !== undefined && swm !== root);
  const deletes: Pick<Quad, 'subject' | 'predicate'>[] = [], inserts: Omit<Quad, 'graph'>[] = [];
  const replace = (subject: string, predicate: string, object: string) => {
    deletes.push({ subject, predicate });
    inserts.push({ subject, predicate, object });
  };
  if (!preserveVerifiedVmProof) replace(lifecycleUri, VM_CURRENT_ASSERTION_PRED, JSON.stringify(root));
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
    for (const subject of preserveVerifiedVmProof ? [assertionUri] : [lifecycleUri, assertionUri]) replace(subject, MEMORY_LAYER_PRED, JSON.stringify(MemoryLayer.VerifiableMemory));
    replace(lifecycleUri, STATE_PRED, '"published"');
  }
  replace(lifecycleUri, PUBLISHED_UAL_PRED, JSON.stringify(input.publishedUal));
  if (input.tentative !== true && input.packedKaId !== undefined && !preserveWorkspace) {
    const author = `0x${(input.packedKaId >> 96n).toString(16).padStart(40, '0')}`;
    const number = input.packedKaId & ((1n << 96n) - 1n);
    replace(lifecycleUri, ASSERTION_GRAPH_PRED, contextGraphLayerUri(input.contextGraphId, MemoryLayer.VerifiableMemory, author, number, input.subGraphName));
    // Promote moves the graph marker to SWM. Complete that move to the actual
    // VM graph; resurrecting a WM marker leaves stale SWM metadata behind.
    for (const layer of [MemoryLayer.WorkingMemory, MemoryLayer.SharedWorkingMemory]) {
      deletes.push({ subject: contextGraphLayerUri(input.contextGraphId, layer, author, number, input.subGraphName), predicate: MEMORY_LAYER_PRED });
    }
    replace(contextGraphLayerUri(input.contextGraphId, MemoryLayer.VerifiableMemory, author, number, input.subGraphName), MEMORY_LAYER_PRED, JSON.stringify(MemoryLayer.VerifiableMemory));
  }
  const term = (value: string, position: 'subject' | 'predicate' | 'object' | 'graph') => formatSparqlTerm(value, { position });
  const graph = term(metaGraph, 'graph');
  const removals = deletes.map(target => ({ ...target, graph: metaGraph }));
  const quads = inserts.map(triple => ({ ...triple, graph: metaGraph }));
  // Validate all terms before any path writes. Both dispatches use this exact projection.
  const deleteStatements = removals.map(q => `DELETE WHERE { GRAPH ${graph} { ${term(q.subject, 'subject')} ${term(q.predicate, 'predicate')} ?o } }`);
  const insertStatements = quads.map(q => `${term(q.subject, 'subject')} ${term(q.predicate, 'predicate')} ${term(q.object, 'object')} .`).join('\n');
  return { graph: metaGraph, mutation: { removals, quads },
    sparql: [...deleteStatements, `INSERT DATA { GRAPH ${graph} { ${insertStatements} } }`].join(';\n') };

}


/** Shared idempotent fallback, with independently verified retry proof excluded by the plan. */
export async function applyLifecycleMutationFallback(store: TripleStore, plan: ReturnType<typeof buildNamedKaVmLifecycleMutation>): Promise<void> {
  for (const target of plan.mutation.removals) {
    await deleteByPatternWithoutCount(store, target);
    const replacements = plan.mutation.quads.filter(q => q.subject === target.subject && q.predicate === target.predicate);
    if (replacements.length) await store.insert(replacements);
  }
  const additions = plan.mutation.quads.filter(q => !plan.mutation.removals.some(target => target.subject === q.subject && target.predicate === q.predicate));
  if (additions.length) await store.insert(additions);
}
