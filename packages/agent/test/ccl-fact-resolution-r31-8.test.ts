/**
 * PR #229 bot review r31-8 (ccl-fact-resolution.ts:270).
 *
 * `resolveEndorsementFacts()` was rewritten in r19-3 to use the new
 * per-event endorsement-resource shape:
 *
 *   ?endorsement dkg:endorses   ?ual .
 *   ?endorsement dkg:endorsedBy ?endorser .
 *
 * That join is two-hop: it requires BOTH a `dkg:endorses` quad whose
 * subject is the endorsement-event resource, AND a sibling
 * `dkg:endorsedBy` quad pinning the endorser. Every endorsement quad
 * published BEFORE r19-3 lives as the legacy direct shape:
 *
 *   <agent> dkg:endorses <ual>     (NO intermediate event resource;
 *                                   NO `dkg:endorsedBy` predicate.)
 *
 * Without back-compat, those historical endorsements vanish on
 * deploy. The CCL `endorsement_count` fact silently flips to 0 for
 * every UAL whose endorsements predate r19-3, which causes
 * `owner_assertion` / `context_corroboration` policies to deny
 * access to genuinely-endorsed content.
 *
 * The fix unions both shapes (`UNION` queries + JS dedupe) so:
 *   - new-shape endorsements still resolve (no regression),
 *   - legacy endorsements resolve again (back-compat),
 *   - a single agent endorsing the same UAL under both shapes counts
 *     as ONE endorsement (BUGS_FOUND.md#CCL-2: the policy semantic
 *     is "distinct endorsers", not "endorsement events").
 *
 * No mocks — uses a real {@link OxigraphStore} with quads written
 * directly into the data graph that `resolveFactsFromSnapshot` reads.
 */
import { describe, it, expect } from 'vitest';
import {
  OxigraphStore,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  contextGraphDataUri,
  DKG_ONTOLOGY,
} from '@origintrail-official/dkg-core';
import { resolveFactsFromSnapshot } from '../src/ccl-fact-resolution.js';
import {
  DKG_ENDORSES,
  DKG_ENDORSED_BY,
  DKG_ENDORSEMENT_CLASS,
  RDF_TYPE,
} from '../src/endorse.js';

const PARANET_ID = 'paranet:r31-8-endorse';
const UAL_A = 'ual:dkg:r31-8:a';
const UAL_B = 'ual:dkg:r31-8:b';
const AGENT_X = 'did:dkg:agent:0x1111111111111111111111111111111111111111';
const AGENT_Y = 'did:dkg:agent:0x2222222222222222222222222222222222222222';
const AGENT_Z = 'did:dkg:agent:0x3333333333333333333333333333333333333333';
const SNAPSHOT_ID = 'snap-r31-8';

const dataGraph = contextGraphDataUri(PARANET_ID);

function newShapeQuads(endorsementUri: string, endorser: string, ual: string): Quad[] {
  return [
    { subject: endorsementUri, predicate: RDF_TYPE, object: `<${DKG_ENDORSEMENT_CLASS}>`, graph: dataGraph },
    { subject: endorsementUri, predicate: DKG_ENDORSES, object: `<${ual}>`, graph: dataGraph },
    { subject: endorsementUri, predicate: DKG_ENDORSED_BY, object: `<${endorser}>`, graph: dataGraph },
  ];
}

function legacyShapeQuads(endorser: string, ual: string): Quad[] {
  // Pre-r19-3 emission: agent IS the subject. No intermediate
  // endorsement-event resource, no `dkg:endorsedBy` quad.
  return [{ subject: endorser, predicate: DKG_ENDORSES, object: `<${ual}>`, graph: dataGraph }];
}

function snapshotIdQuad(ual: string, snapshotId: string): Quad {
  return {
    subject: ual,
    predicate: DKG_ONTOLOGY.DKG_SNAPSHOT_ID,
    object: `"${snapshotId}"`,
    graph: dataGraph,
  };
}

async function resolveCount(
  store: TripleStore,
  ual: string,
  scopeUal?: string,
): Promise<number> {
  const resolved = await resolveFactsFromSnapshot(store, {
    paranetId: PARANET_ID,
    snapshotId: SNAPSHOT_ID,
    view: 'accepted',
    scopeUal,
    policyName: 'context_corroboration',
  });
  // `endorsement_count` facts are tuples of shape ['endorsement_count', ual, n].
  const found = resolved.facts.find(
    (f) => f[0] === 'endorsement_count' && f[1] === ual,
  );
  return (found?.[2] as number | undefined) ?? 0;
}

describe('resolveEndorsementFacts — legacy shape back-compat (r31-8 regression)', () => {
  it('resolves a legacy `<agent> dkg:endorses <ual>` quad (NOT silently dropped on deploy)', async () => {
    const store = new OxigraphStore();
    await store.insert([
      ...legacyShapeQuads(AGENT_X, UAL_A),
      snapshotIdQuad(UAL_A, SNAPSHOT_ID),
    ]);

    const count = await resolveCount(store, UAL_A, UAL_A);
    // Pre-fix: 0 (legacy quad invisible to two-hop join).
    // Post-fix: 1 (legacy quad picked up by the legacy-shape SELECT).
    expect(count).toBe(1);
    await store.close();
  });

  it('the same agent endorsing the same UAL under BOTH shapes counts ONCE (no double-count)', async () => {
    const store = new OxigraphStore();
    // Same agent X, same UAL A — once via the new shape and once via
    // the legacy shape. The policy semantic is "distinct endorsers",
    // so the count must remain 1, not 2.
    await store.insert([
      ...newShapeQuads('urn:dkg:endorsement:r31-8-x-a', AGENT_X, UAL_A),
      ...legacyShapeQuads(AGENT_X, UAL_A),
      snapshotIdQuad(UAL_A, SNAPSHOT_ID),
    ]);

    const count = await resolveCount(store, UAL_A, UAL_A);
    expect(count).toBe(1);
    await store.close();
  });

  it('two DIFFERENT endorsers — one new shape, one legacy — count as 2 (recall preserved)', async () => {
    const store = new OxigraphStore();
    await store.insert([
      ...newShapeQuads('urn:dkg:endorsement:r31-8-x-a', AGENT_X, UAL_A),
      ...legacyShapeQuads(AGENT_Y, UAL_A),
      snapshotIdQuad(UAL_A, SNAPSHOT_ID),
    ]);

    const count = await resolveCount(store, UAL_A, UAL_A);
    expect(count).toBe(2);
    await store.close();
  });

  it('legacy NOT-EXISTS guard prevents counting a `dkg:endorses` quad whose subject IS an endorsement-event resource (no double-count from new-shape recursion)', async () => {
    const store = new OxigraphStore();
    // The new-shape `?endorsement dkg:endorses ?ual` quad MUST NOT
    // ALSO be picked up by the legacy SELECT. The legacy query
    // includes `FILTER NOT EXISTS { ?endorser dkg:endorsedBy ?_ }`
    // precisely to avoid the double-count.
    await store.insert([
      ...newShapeQuads('urn:dkg:endorsement:r31-8-x-a', AGENT_X, UAL_A),
      snapshotIdQuad(UAL_A, SNAPSHOT_ID),
    ]);

    const count = await resolveCount(store, UAL_A, UAL_A);
    // Exactly one endorsement, picked up by the new-shape branch only.
    expect(count).toBe(1);
    await store.close();
  });

  it('a mixed corpus (3 distinct endorsers, multiple shapes per agent) yields the correct distinct-endorser count per UAL', async () => {
    const store = new OxigraphStore();
    await store.insert([
      // UAL_A: agent X via both shapes (=1), agent Y via new shape
      // (=1), agent Z via legacy shape (=1) → 3 distinct endorsers.
      ...newShapeQuads('urn:dkg:endorsement:r31-8-x-a', AGENT_X, UAL_A),
      ...legacyShapeQuads(AGENT_X, UAL_A),
      ...newShapeQuads('urn:dkg:endorsement:r31-8-y-a', AGENT_Y, UAL_A),
      ...legacyShapeQuads(AGENT_Z, UAL_A),
      // UAL_B: agent X via legacy shape only (=1) → 1 distinct
      // endorser. Without r31-8 this would be 0 because the
      // new-shape join would skip the legacy quad entirely.
      ...legacyShapeQuads(AGENT_X, UAL_B),
      snapshotIdQuad(UAL_A, SNAPSHOT_ID),
      snapshotIdQuad(UAL_B, SNAPSHOT_ID),
    ]);

    expect(await resolveCount(store, UAL_A, UAL_A)).toBe(3);
    expect(await resolveCount(store, UAL_B, UAL_B)).toBe(1);
    await store.close();
  });
});
