/**
 * Regression tests for the on-chain receipt hook queries (Codex review
 * "node-ui-receipt").
 *
 * Pre-fix, `buildSealReceiptQuery` joined the lifecycle URN with
 * `?lc dkg:rootEntity ?asrt` — i.e. it expected a triple with the ASSERTION
 * URI as the object of `dkg:rootEntity`. No writer has ever emitted that
 * shape: lifecycle `dkg:rootEntity` rows stamp MEMBER ENTITIES (see
 * `entityMemberQuads` / `generateAssertionPromotedMetadata` in
 * packages/publisher/src/metadata.ts), so the UAL/agent join never bound on
 * any store, old or new. The fix joins the lifecycle URN through its
 * member-entity stamp on the CLICKED entity and pins it to `?asrt` by the
 * structural (addr, name) correspondence between the URN tail
 * `:{addr}:{name}` and the assertion-URI tail `/assertion/{addr}/{name}`
 * (names cannot contain "/", constants.ts validateAssertionName).
 *
 * These tests run the REAL query builders against a REAL store populated
 * with writer-shaped rows — exactly the gap that let the never-binding
 * join ship.
 */
import { describe, it, expect } from 'vitest';
import {
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  buildAssertionPublishReceiptQuads,
} from '@origintrail-official/dkg-core';
// Cross-package relative import (same pattern as agent → chain test helpers):
// node-ui does not depend on dkg-storage at runtime, but the regression must
// EXECUTE the query, not just eyeball its text.
import { OxigraphStore } from '../../storage/src/index.js';
import {
  buildSealReceiptQuery,
  buildReceiptQuery,
} from '../src/ui/hooks/useEntityOnChainReceipt.js';

const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';

const CG = 'receipt-query-test';
const META = contextGraphMetaUri(CG);
const ADDR = '0x00000000000000000000000000000000000000aa';
const NAME = 'my-note';
const ENTITY = 'urn:receipt-test:entity:1';
const ASRT = contextGraphAssertionUri(CG, ADDR, NAME);
const LC = assertionLifecycleUri(CG, ADDR, NAME);
const RESERVED_UAL = `did:dkg:hardhat:31337/${ADDR}/7`;
const AGENT_DID = `did:dkg:agent:${ADDR}`;
const TX = '0x' + 'ab'.repeat(32);

const q = (s: string, p: string, o: string) => ({ subject: s, predicate: p, object: o, graph: META });

/** Strip wrapping quotes + datatype from a literal lexical form. */
const lex = (v: string | undefined) =>
  (v ?? '').replace(/^"/, '').replace(/"(\^\^<[^>]*>)?$/, '');

/** `_meta` rows as the real writers shape them. */
async function seedStore(store: OxigraphStore): Promise<void> {
  // Seal member-entity link (buildAssertionSealQuads dual-write; objects are
  // IRIs — stored bracket-free).
  await store.insert([
    q(ASRT, `${DKG}assertionRootEntity`, ENTITY),
    q(ASRT, `${DKG}assertionEntity`, ENTITY),
    q(ASRT, `${DKG}assertionFinalizedAt`, '"2026-06-12T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'),
  ]);
  // Publish receipt rows (real builder).
  await store.insert(
    buildAssertionPublishReceiptQuads({
      assertionUri: ASRT,
      metaGraph: META,
      txHash: TX,
      blockNumber: 42n,
    }),
  );
  // Lifecycle URN rows (generateAssertionCreatedMetadata + the promote-time
  // member stamp): rootEntity objects are MEMBER entities, never the
  // assertion URI.
  await store.insert([
    q(LC, `${DKG}rootEntity`, ENTITY),
    q(LC, `${DKG}reservedUal`, `"${RESERVED_UAL}"`),
    q(LC, `${PROV}wasAttributedTo`, AGENT_DID),
  ]);
  // UAL-subject on-chain id (generateConfirmedMetadata) — read-both target
  // for the dropped `dkg:publishedAtKaId`.
  await store.insert([
    { subject: RESERVED_UAL, predicate: `${DKG}batchId`, object: '"123456"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: META },
  ]);
}

describe('buildSealReceiptQuery (hop 0)', () => {
  it('binds UAL, agent and batchId through the lifecycle member-entity stamp', async () => {
    const store = new OxigraphStore();
    await seedStore(store);

    const res = await store.query(buildSealReceiptQuery(CG, ENTITY));
    expect(res.type).toBe('bindings');
    const rows = res.type === 'bindings' ? res.bindings : [];
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row['asrt']).toBe(ASRT);
    expect(lex(row['tx'])).toBe(TX);
    expect(lex(row['block'])).toBe('42');
    // THE regression: pre-fix `?lc dkg:rootEntity ?asrt` never bound → no UAL.
    expect(lex(row['ual'])).toBe(RESERVED_UAL);
    expect(row['agentLc']).toBe(AGENT_DID);
    expect(lex(row['batchId'])).toBe('123456');
    expect(lex(row['finalizedAt'])).toBe('2026-06-12T00:00:00Z');
  });

  it('pins the lifecycle URN to the matched assertion when another URN stamps the same entity', async () => {
    const store = new OxigraphStore();
    await seedStore(store);

    // Decoy: a second assertion lifecycle in the same CG also stamps ENTITY
    // (re-publish of the same entity under another name) with a DIFFERENT
    // reserved UAL — but its seal/receipt rows do not link ENTITY, so ?asrt
    // can only bind the real assertion, and the URN-tail filter must reject
    // the decoy URN.
    const decoyLc = assertionLifecycleUri(CG, ADDR, 'other-note');
    await store.insert([
      q(decoyLc, `${DKG}rootEntity`, ENTITY),
      q(decoyLc, `${DKG}reservedUal`, `"did:dkg:hardhat:31337/${ADDR}/99"`),
    ]);

    const res = await store.query(buildSealReceiptQuery(CG, ENTITY));
    const rows = res.type === 'bindings' ? res.bindings : [];
    expect(rows).toHaveLength(1);
    expect(lex(rows[0]['ual'])).toBe(RESERVED_UAL);
  });

  it('still resolves the receipt itself (offchain-link degraded) when no lifecycle row matches', async () => {
    const store = new OxigraphStore();
    // Receipt + seal link only, no lifecycle rows at all (e.g. pruned store).
    await store.insert([q(ASRT, `${DKG}assertionRootEntity`, ENTITY)]);
    await store.insert(
      buildAssertionPublishReceiptQuads({ assertionUri: ASRT, metaGraph: META, txHash: TX, blockNumber: 42n }),
    );

    const res = await store.query(buildSealReceiptQuery(CG, ENTITY));
    const rows = res.type === 'bindings' ? res.bindings : [];
    expect(rows).toHaveLength(1);
    expect(lex(rows[0]['tx'])).toBe(TX);
    expect(rows[0]['ual'] ?? '').toBe('');
  });

  it('no longer emits the never-binding `?lc dkg:rootEntity ?asrt` join', () => {
    const text = buildSealReceiptQuery(CG, ENTITY);
    expect(text).not.toContain('dkg:rootEntity ?asrt');
    expect(text).toContain(`dkg:rootEntity <${ENTITY}>`);
  });
});

describe('buildReceiptQuery (legacy hop 2)', () => {
  it('binds the UAL through the member-entity stamp pinned by the URN tail', async () => {
    const store = new OxigraphStore();
    await seedStore(store);
    // Decoy URN as above.
    const decoyLc = assertionLifecycleUri(CG, ADDR, 'other-note');
    await store.insert([
      q(decoyLc, `${DKG}rootEntity`, ENTITY),
      q(decoyLc, `${DKG}reservedUal`, `"did:dkg:hardhat:31337/${ADDR}/99"`),
    ]);

    const res = await store.query(buildReceiptQuery(CG, ENTITY, ADDR, NAME));
    const rows = res.type === 'bindings' ? res.bindings : [];
    expect(rows).toHaveLength(1);
    expect(lex(rows[0]['tx'])).toBe(TX);
    expect(lex(rows[0]['ual'])).toBe(RESERVED_UAL);
  });
});
