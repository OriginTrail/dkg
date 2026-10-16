import { randomUUID } from 'node:crypto';
import {
  assertionLifecycleUri, assertSafeIri, contextGraphAssertionUri, contextGraphMetaUri,
  parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { PublisherAssertionPromoteOptions } from './dkg-publisher.js';
import { createPromoteOperationIntent, parsePromoteOperationIntent,
  serializePromoteOperationIntent, type PromoteOperationIntent } from './promote-operation-intent.js';

/** Immutable replay authority. This is produced internally, never accepted from HTTP. */
export interface PromoteRecoveryBinding {
  readonly version: 1;
  readonly sealDigest: string;
  readonly intent: PromoteOperationIntent;
  readonly inventoryRequired: boolean;
}

export function recoveryBindingConflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'KA_PROMOTE_RECOVERY_BINDING_CONFLICT' });
}

export function validatePromoteRecoveryBinding(value: unknown): PromoteRecoveryBinding {
  const candidate = value as Partial<PromoteRecoveryBinding> | undefined;
  if (candidate?.version !== 1 || typeof candidate.sealDigest !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(candidate.sealDigest)
    || typeof candidate.inventoryRequired !== 'boolean'
    || typeof candidate.intent?.operationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(candidate.intent.operationId)) {
    throw recoveryBindingConflict('Missing or invalid immutable share recovery binding');
  }
  const intent = parsePromoteOperationIntent(JSON.stringify(candidate.intent), candidate.intent.operationId);
  return Object.freeze({ version: 1, sealDigest: candidate.sealDigest, intent,
    inventoryRequired: candidate.inventoryRequired });
}

/** Read only, called under the publisher's assertion lifecycle lock. */
export async function preparePromoteRecoveryBinding(
  store: TripleStore, contextGraphId: string, name: string, agentAddress: string,
  opts: PublisherAssertionPromoteOptions | undefined, inventoryRequired: boolean,
): Promise<PromoteRecoveryBinding> {
  const subject = assertSafeIri(contextGraphAssertionUri(contextGraphId, agentAddress, name, opts?.subGraphName));
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, agentAddress, name, opts?.subGraphName));
  const graph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> {
    VALUES ?s { <${subject}> <${lifecycle}> } ?s ?p ?o
  } }`);
  if (result.type !== 'quads') throw recoveryBindingConflict('Cannot read the original seal and operation safely');
  const seal = parseAssertionSealQuads(result.quads, subject);
  if (!seal) throw recoveryBindingConflict('Durable sharing requires a complete finalized seal');
  const readLiteral = (predicate: string): string | undefined => {
    const rows = result.quads.filter(q => q.subject === lifecycle && q.predicate === predicate);
    if (rows.length > 1) throw recoveryBindingConflict('Conflicting durable share operation metadata');
    if (!rows.length) return undefined;
    let value: unknown;
    try { value = JSON.parse(rows[0]!.object); } catch { /* Refuse corrupt literals below. */ }
    if (typeof value !== 'string' || !value) throw recoveryBindingConflict('Corrupt durable share operation metadata');
    return value;
  };
  const operationId = readLiteral('http://dkg.io/ontology/shareOperationId');
  const rawIntent = readLiteral('http://dkg.io/ontology/promoteOperationIntent');
  if (Boolean(operationId) !== Boolean(rawIntent)) {
    throw recoveryBindingConflict('The existing share operation lacks a complete immutable intent');
  }
  const intent = operationId && rawIntent ? parsePromoteOperationIntent(rawIntent, operationId)
    : createPromoteOperationIntent({ operationId: randomUUID(), timestampMs: Date.now(),
      publisherPeerId: opts?.publisherPeerId, confirmationRequired: opts?.confirmBeforeCommit !== undefined,
      accessPolicy: opts?.accessPolicy ?? (seal.privateTripleCount ? 'ownerOnly' : 'public'),
      allowedPeers: opts?.allowedPeers });
  return validatePromoteRecoveryBinding({ version: 1, intent, inventoryRequired,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(seal)) });
}

/** Recheck both immutable fields before entering any replay mutation. */
export async function assertPromoteRecoveryBinding(
  store: TripleStore, contextGraphId: string, name: string, agentAddress: string,
  opts: PublisherAssertionPromoteOptions,
): Promise<void> {
  const binding = validatePromoteRecoveryBinding(opts.recoveryBinding);
  const current = await preparePromoteRecoveryBinding(store, contextGraphId, name, agentAddress, opts, binding.inventoryRequired);
  if (current.sealDigest !== binding.sealDigest) throw recoveryBindingConflict('The sealed asset changed after durable share admission');
  // No intent is allowed only before its first write. Read the actual claim, not
  // the freshly generated envelope returned by the preparation helper.
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, agentAddress, name, opts.subGraphName));
  const graph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const exists = await store.query(`ASK { GRAPH <${graph}> { <${lifecycle}> <http://dkg.io/ontology/shareOperationId> ?id } }`);
  if (exists.type !== 'boolean') throw recoveryBindingConflict('Cannot establish original operation ownership');
  if (exists.value && serializePromoteOperationIntent(current.intent) !== serializePromoteOperationIntent(binding.intent)) {
    throw recoveryBindingConflict('The immutable share operation changed after durable admission');
  }
}
