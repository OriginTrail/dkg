/**
 * The async-lift `subtractFinalizedExactQuads` step decrypts
 * authoritative private quads so it can match them against the
 * caller's plaintext input for exact dedup. Until round 9 the helper
 * called `decryptPrivateLiteral()` without an `encryptionKey` option,
 * so the resolver always fell back to the env/default key. A
 * deployment that constructed the backing `PrivateContentStore` with
 * a non-default key therefore never round-tripped any of its sealed
 * envelopes — every private quad looked "new" on retry and got
 * republished as a duplicate.
 *
 * These tests pin the fix: the caller's explicit `encryptionKey` MUST
 * flow through the subtraction path, and a wrong key MUST fail to
 * match (so the regression can't silently come back by hardcoding
 * the default key somewhere up the stack).
 *
 * The tests are hermetic — they use an in-memory `OxigraphStore`,
 * insert the confirmed-KC metadata + sealed private quads by hand,
 * and run `subtractFinalizedExactQuads` directly. No chain, no
 * DKGPublisher, no network.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  OxigraphStore,
  GraphManager,
  PrivateContentStore,
} from '@origintrail-official/dkg-storage';
import { subtractFinalizedExactQuads } from '../src/async-lift-subtraction.js';
import type { LiftRequest, LiftJobValidationMetadata } from '../src/lift-job-types.js';
import type { LiftResolvedPublishSlice } from '../src/async-lift-publish-options.js';

const ROOT = 'urn:local:/rihana';
const SECRET_VALUE = '"top-secret"';
const EXPLICIT_KEY = 'A'.repeat(64);
const OTHER_KEY = 'B'.repeat(64);
const CG = 'CG_R9';
const DKG = 'http://dkg.io/ontology/';

function makeRequest(): LiftRequest {
  return {
    swmId: 'swm',
    shareOperationId: 'swm-1',
    roots: [ROOT],
    contextGraphId: CG,
    namespace: 'ns',
    scope: 'person',
    transitionType: 'CREATE',
    authority: { type: 'owner', proofRef: 'p' },
  } as unknown as LiftRequest;
}

function makeValidation(): LiftJobValidationMetadata {
  // Subtraction only reads `canonicalRoots` from validation.
  return { canonicalRoots: [ROOT] } as LiftJobValidationMetadata;
}

function makeResolved(): LiftResolvedPublishSlice {
  return {
    quads: [],
    privateQuads: [
      { subject: ROOT, predicate: 'http://schema.org/secret', object: SECRET_VALUE, graph: '' },
    ],
    publisherPeerId: 'peer-1',
  } as unknown as LiftResolvedPublishSlice;
}

describe('subtractFinalizedExactQuads — encryption-key plumbing', () => {
  let store: OxigraphStore;
  let graphManager: GraphManager;

  beforeEach(async () => {
    store = new OxigraphStore();
    graphManager = new GraphManager(store);

    // The subtraction helper considers a root "confirmed" only if the
    // meta graph carries:
    //   <kaUri> dkg:rootEntity <ROOT> ; dkg:partOf <kcUri> .
    //   <kcUri> dkg:status "confirmed" .
    const metaGraph = graphManager.metaGraphUri(CG);
    const kaUri = 'urn:local:ka:1';
    const kcUri = 'urn:local:kc:1';
    await store.insert([
      { subject: kaUri, predicate: `${DKG}rootEntity`, object: ROOT, graph: metaGraph },
      { subject: kaUri, predicate: `${DKG}partOf`, object: kcUri, graph: metaGraph },
      { subject: kcUri, predicate: `${DKG}status`, object: '"confirmed"', graph: metaGraph },
    ]);
  });

  it('matches a private quad sealed under an EXPLICIT key when the SAME key is threaded through', async () => {
    // Seal the private quad under EXPLICIT_KEY — this is the
    // deployment where `PrivateContentStore` is constructed with a
    // non-default key.
    const ps = new PrivateContentStore(store, graphManager, {
      encryptionKey: EXPLICIT_KEY,
    });
    await ps.storePrivateTriples(
      CG,
      ROOT,
      [{ subject: ROOT, predicate: 'http://schema.org/secret', object: SECRET_VALUE, graph: '' }],
    );

    const result = await subtractFinalizedExactQuads({
      store,
      graphManager,
      request: makeRequest(),
      validation: makeValidation(),
      resolved: makeResolved(),
      privateStoreEncryptionKey: EXPLICIT_KEY,
    });

    // The plaintext input matched the authoritative sealed quad → 1 removed.
    expect(result.alreadyPublishedPrivateCount).toBe(1);
    expect(result.resolved.privateQuads).toBeUndefined();
  });

  it('does NOT match when a DIFFERENT key is threaded through (the key fence holds)', async () => {
    const ps = new PrivateContentStore(store, graphManager, {
      encryptionKey: EXPLICIT_KEY,
    });
    await ps.storePrivateTriples(
      CG,
      ROOT,
      [{ subject: ROOT, predicate: 'http://schema.org/secret', object: SECRET_VALUE, graph: '' }],
    );

    // Call subtraction with the WRONG key — decrypt returns ciphertext
    // verbatim, so the plaintext input does NOT match anything.
    const result = await subtractFinalizedExactQuads({
      store,
      graphManager,
      request: makeRequest(),
      validation: makeValidation(),
      resolved: makeResolved(),
      privateStoreEncryptionKey: OTHER_KEY,
    });

    expect(result.alreadyPublishedPrivateCount).toBe(0);
    expect(result.resolved.privateQuads).toHaveLength(1);
  });

  it('regression: omitting the key re-introduces the bug (no plumbing = no match for non-default sealed data)', async () => {
    // This test documents the PRE-FIX behaviour. We deliberately omit
    // `privateStoreEncryptionKey` to confirm the historical bug path
    // (silently falling back to env/default) genuinely can NOT match
    // a quad sealed under a different explicit key.
    const ps = new PrivateContentStore(store, graphManager, {
      encryptionKey: EXPLICIT_KEY,
    });
    await ps.storePrivateTriples(
      CG,
      ROOT,
      [{ subject: ROOT, predicate: 'http://schema.org/secret', object: SECRET_VALUE, graph: '' }],
    );

    const result = await subtractFinalizedExactQuads({
      store,
      graphManager,
      request: makeRequest(),
      validation: makeValidation(),
      resolved: makeResolved(),
      // no privateStoreEncryptionKey → env/default fallback, wrong key
    });

    expect(result.alreadyPublishedPrivateCount).toBe(0);
    expect(result.resolved.privateQuads).toHaveLength(1);
  });
});
