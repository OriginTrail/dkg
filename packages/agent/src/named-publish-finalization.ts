// SPDX-License-Identifier: Apache-2.0
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import { createHash } from 'node:crypto';
import { type AssertionSeal } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ConfirmedVmOwnershipOutcome } from './internal/confirmed-vm-catalog-observer.js';

// Process-owned publication checkpoints are never part of peer-visible CG metadata.
const GRAPH = 'urn:dkg:publisher:named-finalization';
const READY = 'http://dkg.io/ontology/namedPublishFinalizationReady';
const COMPLETE = 'http://dkg.io/ontology/namedPublishFinalizationComplete';
export interface NamedPublishFinalizationIdentity { assertionUri: string; seal: AssertionSeal }
export interface NamedPublishFinalizationInput extends NamedPublishFinalizationIdentity {
  contextGraphId: string; subGraphName?: string; assertionCoordinate: string; shareOperationId?: string;
  confirmedTransaction?: OnChainPublishResult;
}
export type CompleteNamedPublishFinalization = (input: NamedPublishFinalizationInput) => Promise<NamedPublishFinalizationOutcome>;
interface PendingFinalization { version: 1; catalogRequired: boolean; shareOperationId?: string }
export type NamedPublishFinalizationProgress = { kind: 'legacy' }
  | { kind: 'pending'; checkpoint: PendingFinalization } | { kind: 'complete' };
function subject(input: NamedPublishFinalizationIdentity): string {
  const { seal } = input;
  if (seal.kaUal === undefined || seal.assertionVersion === undefined) throw new Error('Named finalization requires a graph-scoped seal');
  return `urn:dkg:named-publish-finalization:v1:${createHash('sha256').update(JSON.stringify([
    input.assertionUri, String(seal.chainId), seal.kav10Address.toLowerCase(), seal.kaUal, String(seal.assertionVersion), Buffer.from(seal.merkleRoot).toString('hex'),
  ])).digest('hex')}`;
}
export async function readNamedPublishFinalization(store: TripleStore, input: NamedPublishFinalizationIdentity): Promise<NamedPublishFinalizationProgress> {
  const key = subject(input);
  const result = await store.query(`CONSTRUCT { <${key}> ?p ?o } WHERE { GRAPH <${GRAPH}> { <${key}> ?p ?o } }`,
    { source: 'agent.namedPublish.finalization.read' });
  if (result.type !== 'quads') throw new Error('Named finalization checkpoint read did not return quads');
  const ready = [...new Set(result.quads.filter(q => q.predicate === READY).map(q => q.object))];
  if (ready.length === 0) return { kind: 'legacy' };
  if (ready.length !== 1) throw new Error('Conflicting named finalization checkpoints');
  const checkpoint = JSON.parse(JSON.parse(ready[0]!)) as PendingFinalization;
  if (checkpoint.version !== 1 || typeof checkpoint.catalogRequired !== 'boolean'
    || (checkpoint.shareOperationId !== undefined && typeof checkpoint.shareOperationId !== 'string'))
    throw new Error('Invalid named finalization checkpoint');
  return result.quads.some(q => q.predicate === COMPLETE && q.object === '"complete"')
    ? { kind: 'complete' } : { kind: 'pending', checkpoint };
}
/** Called only after the publisher has completed content recording, cleanup and finalization gossip. */
export async function beginNamedPublishFinalization(store: TripleStore, input: NamedPublishFinalizationIdentity & {
  shareOperationId?: string;
}, catalogRequired: () => boolean): Promise<Exclude<NamedPublishFinalizationProgress, { kind: 'legacy' }>> {
  const existing = await readNamedPublishFinalization(store, input);
  if (existing.kind !== 'legacy') return existing;
  let required = true;
  try { required = catalogRequired(); } catch { /* Unavailable authority cannot waive the obligation. */ }
  const checkpoint: PendingFinalization = { version: 1, catalogRequired: required,
    ...(input.shareOperationId === undefined ? {} : { shareOperationId: input.shareOperationId }) };
  await store.insert([{ subject: subject(input), predicate: READY,
    object: JSON.stringify(JSON.stringify(checkpoint)), graph: GRAPH }]);
  return { kind: 'pending', checkpoint };
}
/** A retry cannot turn a retained obligation into success by disabling its execution policy. */
export type NamedPublishFinalizationOutcome = 'complete' | 'pending';
export async function finishNamedPublishFinalization(store: TripleStore, input: NamedPublishFinalizationIdentity & {
  shareOperationId?: string;
}, ports: { transfer(shareOperationId: string | undefined, catalogRequired: boolean): Promise<ConfirmedVmOwnershipOutcome> }): Promise<NamedPublishFinalizationOutcome> {
  const progress = await readNamedPublishFinalization(store, input);
  if (progress.kind === 'legacy') return 'pending';
  if (progress.kind === 'complete') return 'complete';
  const outcome = await ports.transfer(progress.checkpoint.shareOperationId, progress.checkpoint.catalogRequired);
  if (outcome !== 'owned' && (progress.checkpoint.catalogRequired || outcome !== 'inactive')) {
    return 'pending';
  }
  await store.insert([{ subject: subject(input), predicate: COMPLETE, object: '"complete"', graph: GRAPH }]);
  return 'complete';
}
