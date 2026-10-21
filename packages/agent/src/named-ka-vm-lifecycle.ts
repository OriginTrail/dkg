// SPDX-License-Identifier: Apache-2.0
import { NamedKaVmLifecycleIntegrityError } from './named-ka-vm-lifecycle-integrity-error.js';
import {
  ASSERTION_SEAL_PREDICATES, assertionLifecycleUri,
  contextGraphAssertionUri, contextGraphMetaUri, formatSparqlTerm,
} from '@origintrail-official/dkg-core';
import { tryUpdateWithTouchedGraphs, UnsupportedTripleStoreCapabilityError,
  type TripleStore } from '@origintrail-official/dkg-storage';
import { WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';

import { applyLifecycleMutationFallback, buildNamedKaVmLifecycleMutation, checkedRoot, type WorkspaceLifecycleValues,
  type PublishedNamedKaVmLifecycleInput, type TentativeNamedKaVmLifecycleInput, type VerifiedNamedKaDescriptorInput as DescriptorProjectionInput } from './internal/named-ka-vm-lifecycle-mutation.js';
import type { ObservedStoreMutation } from './internal/observed-store-mutation.js';
export type PublishedNamedKaVmLifecycleWriter = (input: DescriptorProjectionInput) => Promise<void>;

import { stripMetadataLiteral } from './sync/metadata-literal.js';

const MEMORY_LAYER_PRED = 'http://dkg.io/ontology/memoryLayer';
const STATE_PRED = 'http://dkg.io/ontology/state';
export type { PublishedNamedKaVmLifecycleInput, TentativeNamedKaVmLifecycleInput, VerifiedNamedKaDescriptorInput } from './internal/named-ka-vm-lifecycle-mutation.js';
type NamedKaVmLifecycleCommand = PublishedNamedKaVmLifecycleInput | TentativeNamedKaVmLifecycleInput;

export interface NamedKaVmLifecycleApplyOptions {
  /** A durable repair journal always selects restart-durable; standalone SDK hosts may select process-local. */
  readonly persistence: 'restart-durable' | 'process-local';
  /** Queue recovery may depend on this already-verified proof surviving partial fallback writes. */
  readonly preserveVerifiedVmProof?: boolean;
}
/** A filesystem journal selects durability; a standalone SDK may commit within its process. */
export function confirmedNamedKaVmLifecycleApplyOptions(dataDir?: string): NamedKaVmLifecycleApplyOptions {
  return { persistence: dataDir ? 'restart-durable' : 'process-local' };
}

/** Decode RDF once at the storage boundary, then apply each field's normalization contract. */
function decodeWorkspaceLifecycleValues(bindings: Record<string, string> | undefined): WorkspaceLifecycleValues {
  const root = (term?: string) => stripMetadataLiteral(term)?.toLowerCase().replace(/^0x/, '');
  return { wm: root(bindings?.wm), swm: root(bindings?.swm), activeSeal: root(bindings?.activeSeal),
    activeSealVersion: stripMetadataLiteral(bindings?.activeSealVersion)?.trim(),
    state: stripMetadataLiteral(bindings?.state)?.toLowerCase(), layer: stripMetadataLiteral(bindings?.layer)?.toUpperCase() };
}
/** One request on certified atomic backends; typed preflight refusal alone permits fallback. */
async function commitLifecycleMetadata(store: TripleStore, plan: ReturnType<typeof buildNamedKaVmLifecycleMutation>): Promise<void> {
  if (store.atomicUpdate) {
    try {
      await store.atomicUpdate(plan.sparql, { source: 'agent.publish.confirmedLifecycleCommit', touchedGraphs: [plan.graph] });
      return;
    } catch (error) {
      if (!(error instanceof UnsupportedTripleStoreCapabilityError) || error.capability !== 'atomicUpdate') throw error;
    }
  }
  await applyLifecycleMutationFallback(store, plan);
}

/** Caller holds the publisher's same-KA lifecycle lock across admission and commit. */
export async function applyPublishedNamedKaVmLifecycle(
  store: TripleStore, input: PublishedNamedKaVmLifecycleInput,
  options: NamedKaVmLifecycleApplyOptions = { persistence: 'restart-durable' },
): Promise<void> {
  if ('tentative' in input) throw new NamedKaVmLifecycleIntegrityError('Confirmed lifecycle commands cannot carry tentative mode');
  await applyNamedKaVmLifecycle(store, input, options.persistence, options.preserveVerifiedVmProof);
}
export async function applyTentativeNamedKaVmLifecycle(store: TripleStore, input: TentativeNamedKaVmLifecycleInput): Promise<void> {
  if (input.tentative !== true || 'packedKaId' in input) throw new NamedKaVmLifecycleIntegrityError('Tentative lifecycle commands require tentative mode without confirmed graph coordinates');
  await applyNamedKaVmLifecycle(store, input, 'process-local');
}
async function applyNamedKaVmLifecycle(
  store: TripleStore, input: NamedKaVmLifecycleCommand,
  persistenceMode: NamedKaVmLifecycleApplyOptions['persistence'],
  preserveVerifiedVmProof = false,
): Promise<void> {
  const capability = store.commitment;
  const barrier = capability !== undefined
    && (capability.durability === 'restart-durable' || persistenceMode === 'process-local')
    ? capability.capture() : undefined;
  if (input.tentative !== true && barrier === undefined) {
    throw Object.assign(new Error('Confirmed lifecycle repair awaits an explicitly certified persistence barrier'), {
      code: 'KA_VM_LIFECYCLE_DURABILITY_UNAVAILABLE',
    });
  }
  await mutateNamedKaVmLifecycle(store, input, preserveVerifiedVmProof);
  // Graph writes can be visible before the debounced snapshot is on disk. The
  // repair owner may retire its fsynced journal only after this barrier succeeds.
  if (barrier !== undefined) await barrier({ source: 'agent.publish.confirmedLifecycleFlush' });
  else await store.flush?.({ source: 'agent.publish.confirmedLifecycleFlush' });
}

/** Mutation only: the materialization owner certifies the complete attempt. */
export async function mutatePublishedNamedKaVmLifecycle(
  store: TripleStore, input: PublishedNamedKaVmLifecycleInput, preserveVerifiedVmProof = false,
): Promise<void> {
  if ('tentative' in input) throw new NamedKaVmLifecycleIntegrityError('Confirmed lifecycle commands cannot carry tentative mode');
  await mutateNamedKaVmLifecycle(store, input, preserveVerifiedVmProof);
}
async function mutateNamedKaVmLifecycle(
  store: TripleStore, input: NamedKaVmLifecycleCommand, preserveVerifiedVmProof: boolean,
): Promise<void> {
  const assertionUri = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const lifecycleUri = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name, input.subGraphName);
  const metaGraph = contextGraphMetaUri(input.contextGraphId);
  // Validate inputs before I/O and use the shared RDF serializer at the query boundary.
  checkedRoot(input.merkleRoot);
  if (input.priorMerkleRoot !== undefined) checkedRoot(input.priorMerkleRoot);
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
  const workspace = { kind: 'observed' as const, values: decodeWorkspaceLifecycleValues(rows.bindings[0]) };
  const plan = input.tentative === true
    ? buildNamedKaVmLifecycleMutation({ ...input, kind: 'tentative', workspace, preserveVerifiedVmProof: false })
    : buildNamedKaVmLifecycleMutation({ ...input, kind: 'confirmed', workspace, preserveVerifiedVmProof });
  await commitLifecycleMetadata(store, plan);
}

/** Compatibility projection for externally verified descriptor repair. */
export async function applyVerifiedNamedKaDescriptor(store: TripleStore, input: DescriptorProjectionInput): Promise<void> {
  await applyLifecycleMutationFallback(store, buildNamedKaVmLifecycleMutation({ ...input, kind: 'verified-descriptor', workspace: { kind: 'verified' }, preserveVerifiedVmProof: input.preserveVerifiedVmProof ?? false }));
}

/** Compose over the configured decorated store and its observed fallback at agent construction. */
export function createPublishedNamedKaVmLifecycleWriter({ updateStore, fallbackStore, executeMutation }: {
  readonly updateStore: TripleStore;
  readonly fallbackStore: TripleStore;
  readonly executeMutation: ObservedStoreMutation;
}): PublishedNamedKaVmLifecycleWriter {
  return async input => {
    // Query and observer scope have one closed, validated source of truth.
    const plan = buildNamedKaVmLifecycleMutation({ ...input, kind: 'verified-descriptor', workspace: { kind: 'verified' }, preserveVerifiedVmProof: input.preserveVerifiedVmProof ?? false });
    if (typeof updateStore.update === 'function' && await executeMutation(
      () => tryUpdateWithTouchedGraphs(updateStore, plan.sparql, [plan.graph], {
        source: 'agent.publish.namedKaVmLifecycle',
      }),
      updated => updated,
      plan.mutation,
      'update',
    )) return;
    // Only absent or typed unsupported capability reaches this ordered path.
    await applyLifecycleMutationFallback(fallbackStore, plan);
  };
}
