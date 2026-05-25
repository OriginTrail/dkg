/**
 * Regression test for OriginTrail/dkg#633
 * "EPCIS private queries cannot filter encrypted object values"
 *
 * History:
 *   - 2026-04-22 (PR #229 round-6 bot escalation, commit de341d88): the
 *     IRI half of `encryptLiteral` started AES-sealing every object
 *     term in `_private` — both literals and IRIs — under a single
 *     envelope with an internal `L|` / `I|` tag.
 *   - 2026-05-05 (PR #379): the round-6 squash landed on `main`, which
 *     silently broke every SPARQL filter against the private graph.
 *     The most visible victim was the EPCIS read path (#633).
 *   - This commit: reverts the IRI half of the seal in
 *     `PrivateContentStore.encryptLiteral`. IRI-position object terms
 *     now pass through plaintext, restoring SPARQL filterability for
 *     `eventType`, `bizStep`, `bizLocation`, `readPoint`, `disposition`.
 *     The literal half stays sealed (literals are the ST-2 finding),
 *     so `epc`, `action`, `eventTime` range filters still need a
 *     blind-index or in-app post-decrypt pass — tracked separately.
 *
 * Sets up an in-memory OxigraphStore wired to a real
 * ContextGraphManager + PrivateContentStore, writes one ObjectEvent
 * into the private graph the way the publisher does on capture, plus
 * the public anchor triple, then runs the SPARQL built by
 * `buildEpcisQuery()` and asserts the IRI-side is fixed and documents
 * the literal-side gap.
 *
 * Lives in `packages/cli/test` because cli is the only package that
 * already has BOTH `@origintrail-official/dkg-storage` and
 * `@origintrail-official/dkg-epcis` as workspace deps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OxigraphStore,
  ContextGraphManager,
  PrivateContentStore,
} from '@origintrail-official/dkg-storage';
import {
  contextGraphSharedMemoryUri,
  contextGraphPrivateUri,
} from '@origintrail-official/dkg-core';
import { buildEpcisQuery } from '@origintrail-official/dkg-epcis';

const CG = 'repro-633';
const EVENT = 'urn:uuid:event-A';
const EPC = 'urn:epc:id:sgtin:4012345.011111.1001';
const SWM_GRAPH = contextGraphSharedMemoryUri(CG);
const PRIVATE_GRAPH = contextGraphPrivateUri(CG);

describe('OriginTrail/dkg#633 — EPCIS private queries cannot filter encrypted object values', () => {
  let tempDir: string;
  let store: OxigraphStore;
  let gm: ContextGraphManager;
  let ps: PrivateContentStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'repro-633-'));
    process.env.DKG_PRIVATE_STORE_KEY_FILE = join(tempDir, 'private-store.key');

    store = new OxigraphStore();
    gm = new ContextGraphManager(store);
    ps = new PrivateContentStore(store, gm);

    // 1) Public anchor — async-lift-publisher-impl.ts:142-147 emits this
    // for every private root so EPCIS queries can locate the matching
    // private payload at query time.
    await store.insert([
      {
        subject: EVENT,
        predicate: 'http://dkg.io/ontology/privateDataAnchor',
        object: '"true"',
        graph: SWM_GRAPH,
      },
    ]);

    // 2) Private EPCIS event triples — same shape the publisher writes
    // through PrivateContentStore.storePrivateTriples for a private
    // ObjectEvent. Every `object` field gets AES-GCM sealed before the
    // triplestore sees it (private-store.ts:550-581).
    await ps.storePrivateTriples(CG, EVENT, [
      {
        subject: EVENT,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: '<https://gs1.github.io/EPCIS/ObjectEvent>',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/eventTime',
        object: '"2026-05-25T08:00:00.000Z"',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/bizStep',
        object: '<https://ref.gs1.org/cbv/BizStep-shipping>',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/action',
        object: '"OBSERVE"',
        graph: '',
      },
      {
        subject: EVENT,
        predicate: 'https://gs1.github.io/EPCIS/epcList',
        object: `"${EPC}"`,
        graph: '',
      },
    ]);
  });

  afterEach(async () => {
    await store.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DKG_PRIVATE_STORE_KEY_FILE;
  });

  it('[shape] post-revert: IRI-object terms pass through plaintext, literal-object terms stay sealed', async () => {
    // Asserts the post-revert envelope shape: literals are still
    // wrapped in `"enc:gcm:v1:..."`, but IRIs land in the store
    // verbatim. This is the new contract — see the comment block on
    // `PrivateContentStore.encryptLiteral`.
    const raw = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <${PRIVATE_GRAPH}> { <${EVENT}> ?p ?o . }
      }
    `);
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;
    expect(raw.bindings).toHaveLength(5);

    const sealedByPredicate = Object.fromEntries(
      raw.bindings.map((r) => [r['p'], r['o']?.startsWith('"enc:gcm:v1:')]),
    );
    expect(sealedByPredicate['http://www.w3.org/1999/02/22-rdf-syntax-ns#type']).toBe(false);
    expect(sealedByPredicate['https://gs1.github.io/EPCIS/bizStep']).toBe(false);
    expect(sealedByPredicate['https://gs1.github.io/EPCIS/eventTime']).toBe(true);
    expect(sealedByPredicate['https://gs1.github.io/EPCIS/action']).toBe(true);
    expect(sealedByPredicate['https://gs1.github.io/EPCIS/epcList']).toBe(true);
  });

  it('[shape] PrivateContentStore.getPrivateTriples returns N-Triples-form terms for both sealed and unsealed objects', async () => {
    const quads = await ps.getPrivateTriples(CG, EVENT);
    expect(quads).toHaveLength(5);
    const byPred = Object.fromEntries(quads.map((q) => [q.predicate, q.object]));
    expect(byPred['http://www.w3.org/1999/02/22-rdf-syntax-ns#type']).toBe(
      '<https://gs1.github.io/EPCIS/ObjectEvent>',
    );
    expect(byPred['https://gs1.github.io/EPCIS/bizStep']).toBe(
      '<https://ref.gs1.org/cbv/BizStep-shipping>',
    );
    expect(byPred['https://gs1.github.io/EPCIS/action']).toBe('"OBSERVE"');
    expect(byPred['https://gs1.github.io/EPCIS/epcList']).toBe(`"${EPC}"`);
  });

  it('[#633 IRI fix] buildEpcisQuery with no filters returns the private event (was: 0 rows)', async () => {
    const sparql = buildEpcisQuery({ finalized: false }, CG);
    expect(sparql).toContain('STRSTARTS(STR(?eventType), "https://gs1.github.io/EPCIS/")');
    const res = await store.query(sparql);
    expect(res.type).toBe('bindings');
    if (res.type !== 'bindings') return;
    expect(res.bindings).toHaveLength(1);
    expect(res.bindings[0]?.['event']).toBe(EVENT);
    expect(res.bindings[0]?.['eventType']).toBe(
      'https://gs1.github.io/EPCIS/ObjectEvent',
    );
  });

  it('[#633 IRI fix] IRI-position object filters now match against the private branch', async () => {
    const iriPositionCases: Array<[string, Parameters<typeof buildEpcisQuery>[0]]> = [
      ['eventType=ObjectEvent', { finalized: false, eventType: 'ObjectEvent' }],
      ['bizStep=shipping', { finalized: false, bizStep: 'shipping' }],
    ];
    for (const [label, params] of iriPositionCases) {
      const sparql = buildEpcisQuery(params, CG);
      const res = await store.query(sparql);
      expect(res.type, label).toBe('bindings');
      if (res.type !== 'bindings') continue;
      expect(res.bindings, label).toHaveLength(1);
    }
  });

  it('[#633 follow-up] literal-position object filters still return empty (literals stay sealed; needs blind-index work)', async () => {
    // The literal half of the seal is intentionally retained — it
    // addresses the original ST-2 audit finding ("private literal
    // values must not land on disk in plaintext"). The trade-off is
    // that SPARQL `FILTER(?epcList = "...")`-style matches against
    // sealed literals still bind to ciphertext.
    //
    // The proper fix is either (a) a blind-index sidecar that lets
    // SPARQL match without revealing plaintext, or (b) an in-app
    // post-decrypt pass in the EPCIS handler. Both are out of scope
    // for the IRI-seal revert. Tracked as a follow-up on #633.
    const literalPositionCases: Array<[string, Parameters<typeof buildEpcisQuery>[0]]> = [
      ['epc=' + EPC, { finalized: false, epc: EPC }],
      ['action=OBSERVE', { finalized: false, action: 'OBSERVE' }],
      [
        'eventTime range',
        { finalized: false, from: '2026-05-25T00:00:00Z', to: '2026-05-26T00:00:00Z' },
      ],
    ];
    for (const [label, params] of literalPositionCases) {
      const sparql = buildEpcisQuery(params, CG);
      const res = await store.query(sparql);
      expect(res.type, label).toBe('bindings');
      if (res.type !== 'bindings') continue;
      expect(res.bindings, `${label} — currently empty pending follow-up`).toHaveLength(0);
    }
  });
});
