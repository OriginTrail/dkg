/**
 * Regression tests for `verifySyncedData` on the RFC ka-metadata-trim P3.1
 * collapsed meta shape (Codex review "sync-verify").
 *
 * Pre-fix, the verifier mapped subjects to a KC exclusively via the legacy
 * `<ual>/<n> dkg:partOf <ual>` token edge. The collapsed P3.1 write mints NO
 * partOf — `dkg:rootEntity` (and `dkg:privateMerkleRoot`) sit directly on the
 * merkleRoot-bearing UAL subject — so collapsed KCs produced an empty
 * kcRootEntities join and were ACCEPTED ON TRUST, skipping the Merkle gate
 * entirely. The fix self-maps merkleRoot-bearing subjects that carry their
 * own rootEntity rows (multi-map, deduped against dual-shape rows).
 *
 * Both duplicated implementations are exercised: dkg-agent-utils.ts and
 * sync-verify-worker-impl.ts.
 */
import { describe, it, expect } from 'vitest';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { Logger } from '@origintrail-official/dkg-core';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { verifySyncedData as verifyUtils } from '../src/dkg-agent-utils.js';
import { verifySyncedData as verifyWorker } from '../src/sync-verify-worker-impl.js';

const DKG = 'http://dkg.io/ontology/';
const META = 'did:dkg:context-graph:sync-verify-test/_meta';
const DATA = 'did:dkg:context-graph:sync-verify-test';
const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/9';
const ROOT_A = 'urn:sync-verify:alpha';
const ROOT_B = 'urn:sync-verify:beta';

const ctx: OperationContext = { operationId: 'test', operationName: 'sync' };
const log = new Logger('sync-verify-collapsed.test');

const q = (s: string, p: string, o: string, g = DATA): Quad => ({ subject: s, predicate: p, object: o, graph: g });

const toHex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/** Run BOTH duplicated implementations and assert they agree. */
function verifyBoth(dataQuads: Quad[], metaQuads: Quad[], acceptUnverified = false) {
  const a = verifyUtils(dataQuads, metaQuads, ctx, log, acceptUnverified);
  const b = verifyWorker(dataQuads, metaQuads, acceptUnverified);
  expect(b.rejected).toBe(a.rejected);
  expect(b.data).toEqual(a.data);
  expect(b.meta).toEqual(a.meta);
  return a;
}

const dataA = [q(ROOT_A, 'http://schema.org/name', '"Alpha"')];
const dataB = [q(ROOT_B, 'http://schema.org/name', '"Beta"')];
const goodRootA = toHex(computeFlatKCRootV10(dataA, []));
const goodRootAB = toHex(computeFlatKCRootV10([...dataA, ...dataB], []));

describe('verifySyncedData — collapsed P3.1 shape', () => {
  it('verifies a collapsed single-root KC (no partOf token edge)', () => {
    const meta = [
      q(UAL, `${DKG}merkleRoot`, `"${goodRootA}"`, META),
      q(UAL, `${DKG}rootEntity`, ROOT_A, META),
    ];
    const res = verifyBoth(dataA, meta);
    expect(res.rejected).toBe(0);
    expect(res.data).toEqual(dataA);
  });

  it('REJECTS a collapsed KC whose claimed merkle root does not match (pre-fix: accepted on trust)', () => {
    const meta = [
      q(UAL, `${DKG}merkleRoot`, `"${'00'.repeat(32)}"`, META),
      q(UAL, `${DKG}rootEntity`, ROOT_A, META),
    ];
    const res = verifyBoth(dataA, meta);
    expect(res.rejected).toBe(1);
    // The rejected KC's data and meta rows are filtered out.
    expect(res.data).toEqual([]);
    expect(res.meta).toEqual([]);
  });

  it('verifies a collapsed MULTI-root KC (multi-map, not last-row-wins)', () => {
    const meta = [
      q(UAL, `${DKG}merkleRoot`, `"${goodRootAB}"`, META),
      q(UAL, `${DKG}rootEntity`, ROOT_A, META),
      q(UAL, `${DKG}rootEntity`, ROOT_B, META),
    ];
    const res = verifyBoth([...dataA, ...dataB], meta);
    expect(res.rejected).toBe(0);
  });

  it('verifies a collapsed KC with private merkle roots anchored on the UAL subject', () => {
    const priv = new Uint8Array(32).fill(7);
    const rootWithPriv = toHex(computeFlatKCRootV10(dataA, [priv]));
    const meta = [
      q(UAL, `${DKG}merkleRoot`, `"${rootWithPriv}"`, META),
      q(UAL, `${DKG}rootEntity`, ROOT_A, META),
      q(UAL, `${DKG}privateMerkleRoot`, `"${toHex(priv)}"`, META),
    ];
    const res = verifyBoth(dataA, meta);
    expect(res.rejected).toBe(0);
  });

  it('dual-shape rows (collapsed + legacy token rows for the same KC) do not double-count partitions', () => {
    // Pre-trim aggregate writes — and the multi-root conditional re-emit —
    // carry the SAME roots on both the UAL subject and `<ual>/<n>` token rows.
    const priv = new Uint8Array(32).fill(9);
    const rootDual = toHex(computeFlatKCRootV10([...dataA, ...dataB], [priv]));
    const meta = [
      q(UAL, `${DKG}merkleRoot`, `"${rootDual}"`, META),
      q(UAL, `${DKG}rootEntity`, ROOT_A, META),
      q(UAL, `${DKG}rootEntity`, ROOT_B, META),
      q(UAL, `${DKG}privateMerkleRoot`, `"${toHex(priv)}"`, META),
      q(`${UAL}/1`, `${DKG}rootEntity`, ROOT_A, META),
      q(`${UAL}/1`, `${DKG}partOf`, UAL, META),
      q(`${UAL}/2`, `${DKG}rootEntity`, ROOT_B, META),
      q(`${UAL}/2`, `${DKG}partOf`, UAL, META),
      q(`${UAL}/2`, `${DKG}privateMerkleRoot`, `"${toHex(priv)}"`, META),
    ];
    const res = verifyBoth([...dataA, ...dataB], meta);
    expect(res.rejected).toBe(0);
  });

  it('legacy token-row shape still verifies and still rejects mismatches (unchanged behaviour)', () => {
    const goodMeta = [
      q(UAL, `${DKG}merkleRoot`, `"${goodRootA}"`, META),
      q(`${UAL}/1`, `${DKG}rootEntity`, ROOT_A, META),
      q(`${UAL}/1`, `${DKG}partOf`, UAL, META),
    ];
    expect(verifyBoth(dataA, goodMeta).rejected).toBe(0);

    const badMeta = [
      q(UAL, `${DKG}merkleRoot`, `"${'11'.repeat(32)}"`, META),
      q(`${UAL}/1`, `${DKG}rootEntity`, ROOT_A, META),
      q(`${UAL}/1`, `${DKG}partOf`, UAL, META),
    ];
    expect(verifyBoth(dataA, badMeta).rejected).toBe(1);
  });

  it('non-KA rootEntity carriers (no merkleRoot on the subject) do not mint bogus KCs', () => {
    // Lifecycle URNs / SWM op rows stamp dkg:rootEntity but carry no
    // dkg:merkleRoot — they must not enter the verification join at all.
    const lifecycle = 'urn:dkg:assertion:sync-verify-test:0xab:my-note';
    const meta = [
      q(UAL, `${DKG}merkleRoot`, `"${goodRootA}"`, META),
      q(UAL, `${DKG}rootEntity`, ROOT_A, META),
      q(lifecycle, `${DKG}rootEntity`, ROOT_A, META),
      q(lifecycle, `${DKG}rootEntity`, ROOT_B, META),
    ];
    const res = verifyBoth(dataA, meta);
    expect(res.rejected).toBe(0);
    // The lifecycle rows pass through untouched.
    expect(res.meta).toContainEqual(q(lifecycle, `${DKG}rootEntity`, ROOT_A, META));
  });

  it('rejects unscoped merkle metadata in normal CGs instead of accepting it on trust', () => {
    const meta = [q(UAL, `${DKG}merkleRoot`, `"${'22'.repeat(32)}"`, META)];
    const res = verifyBoth(dataA, meta);
    expect(res.rejected).toBe(1);
    expect(res.data).toEqual([]);
    expect(res.meta).toEqual([]);
  });

  it('fails the whole batch when malformed legacy metadata cannot scope its data', () => {
    const meta = [q(UAL, `${DKG}merkleRoot`, '"not-a-root"', META)];
    const res = verifyBoth(dataA, meta);
    expect(res.rejected).toBe(1);
    expect(res.data).toEqual([]);
    expect(res.meta).toEqual([]);
  });

  it('rejects normal-CG data paired only with non-integrity metadata', () => {
    const meta = [q('urn:cg:config', `${DKG}name`, '"Config only"', META)];
    const res = verifyBoth(dataA, meta);
    expect(res.rejected).toBe(1);
    expect(res.data).toEqual([]);
    expect(res.meta).toEqual([]);
  });

  it('acceptUnverified (system context graphs) still passes everything through', () => {
    const meta = [
      q(UAL, `${DKG}merkleRoot`, `"${'33'.repeat(32)}"`, META),
      q(UAL, `${DKG}rootEntity`, ROOT_A, META),
    ];
    const res = verifyBoth(dataA, meta, true);
    expect(res.rejected).toBe(0);
    expect(res.data).toEqual(dataA);
  });
});
