import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  ASSERTION_SEAL_PREDICATES, TypedEventBus, contextGraphAssertionUri,
  contextGraphMetaUri, contextGraphPrivateUri, generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../../src/dkg-publisher.js';
import { finalizeRootlessAssertionForTest } from './rootless-lifecycle.js';

export const RECOVERY_CG = 'pull-recovery-test';
export const RECOVERY_AUTHOR = '0x00000000000000000000000000000000000000a1';
export const RECOVERY_NAME = 'recoverable';
export const RECOVERY_META = contextGraphMetaUri(RECOVERY_CG);
export const RECOVERY_SUBJECT = contextGraphAssertionUri(RECOVERY_CG, RECOVERY_AUTHOR, RECOVERY_NAME);
export const RECOVERY_ARCHIVE = `${RECOVERY_SUBJECT}/_recovery_seal`;
export const RECOVERY_PRIVATE = contextGraphPrivateUri(RECOVERY_CG);
export const RECOVERY_PREDICATES = Object.values(ASSERTION_SEAL_PREDICATES);

export async function recoveryPublisher(store: TripleStore) {
  return new DKGPublisher({ store, chain: new NoChainAdapter(), eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair() });
}

export async function seedRecoveryAsset(store: TripleStore) {
  const publisher = await recoveryPublisher(store);
  await publisher.assertionCreate(RECOVERY_CG, RECOVERY_NAME, RECOVERY_AUTHOR);
  await publisher.assertionWrite(RECOVERY_CG, RECOVERY_NAME, RECOVERY_AUTHOR, [
    { subject: 'urn:test:public', predicate: 'urn:test:value', object: '"public content"', graph: '' },
  ]);
  await publisher.assertionWritePrivate(RECOVERY_CG, RECOVERY_NAME, RECOVERY_AUTHOR, [
    { subject: 'urn:test:secret', predicate: 'urn:test:value', object: '"private content"', graph: '' },
  ]);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store,
    contextGraphId: RECOVERY_CG, name: RECOVERY_NAME, agentAddress: RECOVERY_AUTHOR });
  await publisher.assertionPromote(RECOVERY_CG, RECOVERY_NAME, RECOVERY_AUTHOR,
    { publisherPeerId: 'test-publisher-peer' });
  return { publisher, finalized };
}

/** Persist the precise prefix left by the old per-predicate clear. */
export async function seedInterruptedSealClear(store: TripleStore, deletedCount: number) {
  const active = await store.query(`CONSTRUCT { <${RECOVERY_SUBJECT}> ?p ?o } WHERE {
    GRAPH <${RECOVERY_META}> { <${RECOVERY_SUBJECT}> ?p ?o } }`);
  if (active.type !== 'quads' || !active.quads.length) throw new Error('Fixture active seal is missing');
  await store.insert(active.quads.filter(q => RECOVERY_PREDICATES.includes(q.predicate))
    .map(q => ({ ...q, graph: RECOVERY_PRIVATE, subject: RECOVERY_ARCHIVE })));
  for (const predicate of RECOVERY_PREDICATES.slice(0, deletedCount)) {
    await store.deleteByPattern({ graph: RECOVERY_META, subject: RECOVERY_SUBJECT, predicate });
  }
  await store.flush?.();
}
