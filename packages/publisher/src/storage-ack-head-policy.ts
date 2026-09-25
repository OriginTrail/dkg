import type { KnowledgeAssetWorkspaceHead } from './workspace-resolution.js';
import { workspaceHeadIncludesShareOperationId } from './workspace-operation-equivalence.js';

/** Immutable queued intent known only to the publishing core, never sent on the ACK wire. */
export interface LocalStorageAckHeadExpectation {
  readonly shareOperationId: string;
  readonly publisherPeerId: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  readonly allowedPeers: readonly string[];
}

export type StorageAckRequestContext =
  | { readonly kind: 'remote' }
  | { readonly kind: 'local'; readonly expectedHead?: LocalStorageAckHeadExpectation };

/** A different-content copy still needs the existing owed-head conflict checks. */
export type StorageAckHeadPolicyPlan =
  | { readonly kind: 'decline-stale-local-head' }
  | { readonly kind: 'preserve-head' | 'replace-head' | 'check-conflicts' };

function normalizedPeers(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/** Pure head decision; the caller supplies the resolver-validated alias class. */
export function planStorageAckHeadPersistence(input: {
  readonly context: StorageAckRequestContext;
  readonly head?: KnowledgeAssetWorkspaceHead;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly publisherPeerId: string;
  readonly publicDigest: string;
  readonly publicTripleCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
}): StorageAckHeadPolicyPlan {
  const expected = input.context.kind === 'local' ? input.context.expectedHead : undefined;
  const head = input.head;
  if (!head) return expected ? { kind: 'decline-stale-local-head' } : { kind: 'replace-head' };

  const sameContent =
    head.assertionVersion === input.assertionVersion
    && head.publicQuadsDigest === input.publicDigest
    && head.publicTripleCount === input.publicTripleCount
    && head.privateTripleCount === input.privateTripleCount
    && head.privateMerkleRoot?.toLowerCase() === input.privateMerkleRoot;

  if (expected) {
    if (
      expected.kaUal !== input.kaUal
      || expected.assertionVersion !== input.assertionVersion
      || head.publisherPeerId !== expected.publisherPeerId
      || !workspaceHeadIncludesShareOperationId(head, expected.shareOperationId)
      || head.access.kind !== 'persisted'
      || head.access.accessPolicy !== expected.accessPolicy
      || JSON.stringify(normalizedPeers(head.access.allowedPeers))
        !== JSON.stringify(normalizedPeers(expected.allowedPeers))
      || !sameContent
    ) return { kind: 'decline-stale-local-head' };
    return { kind: 'preserve-head' };
  }

  return sameContent ? { kind: 'replace-head' } : { kind: 'check-conflicts' };
}
