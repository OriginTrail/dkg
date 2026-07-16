/**
 * PR #1388 — OKF (OriginTrail / Google Open Knowledge Format) → VM integration.
 *
 * Network-observable behaviour under test (all via the REAL `dkg okf` CLI
 * surface confirmed in packages/cli/src/commands/okf.ts):
 *
 *   1. `dkg okf import --dry-run`   — deterministic, offline OKF→RDF mapping:
 *      a conformant bundle maps to N concepts whose subject IRIs are minted
 *      under `urn:okf:` (DEFAULT_IRI_BASE). No node touched.
 *   2. `dkg okf import --share`     — advances the concept Knowledge Assets to
 *      SHARED WORKING MEMORY of a fresh Context Graph; querying
 *      `view: 'shared-working-memory'` (the agentAddress-free view `okf export`
 *      itself relies on) returns the concept triples AND the reconstructed
 *      cross-concept link graph (schema:mentions edges between concepts).
 *   3. `dkg okf verify`             — production completeness gate: re-queries
 *      the shared Context Graph and confirms its triple counts match, per
 *      integrity predicate, the deterministic bundle mapping (exit 0, complete).
 *   4. `dkg okf export`             — round-trips the shared Context Graph back
 *      into a conformant OKF bundle whose concepts re-map to the same
 *      `urn:okf:` IRIs (clean inverse of import).
 *
 * Why SWM and not the WM default for the network read: the WM view requires a
 * per-agent `agentAddress` (resolveViewGraphs throws
 * 'agentAddress is required for the working-memory view'), and the shared
 * harness `queryNode` deliberately does not thread one. `--share` advances the
 * same import to SWM, which is exactly the agentAddress-free layer the shipped
 * `okf export` / `okf verify` code reads — so these assertions exercise the PR's
 * own production read path, not a guessed one. (The WM-default LANDING is still
 * asserted via the import CLI summary in test #2's setup phase.)
 *
 * The OKF import is FREE / off-chain (WM + SWM are free, reversible memory
 * layers; on-chain VM promotion is a separate gated step, NOT part of import).
 * So this suite spends no TRAC, mints no PCA, and never touches a real node's
 * wallet/identity. Each `it` creates its OWN ephemeral, public, off-chain
 * Context Graph (`pr1388-okf-<ts>-<rand>`) via `--create-context-graph`, so the
 * shared `devnet-test` CG and every sibling suite are untouched.
 *
 * Fixture: ./bundle/ is the minimal `synthetic_links` bundle copied from
 * packages/okf/test/fixtures — 4 concepts (hub, beta, tables/alpha, tables/gamma)
 * with a deterministic mapping (no LLM, no network in the mapper itself).
 *
 *   pnpm run build
 *   ./scripts/devnet.sh start 6
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import {
  detectDevnet,
  ensureAllIdentities,
  runDkgCli,
  queryNode,
  unwrapIri,
  parseLastJsonBlock,
  type DevnetState,
  type DevnetNode,
} from '../_bootstrap/harness.js';

// ── Deterministic facts about the ./bundle/ fixture (the OKF mapper is pure) ──
const BUNDLE_DIR = join(import.meta.dirname, 'bundle');
const IRI_BASE = 'urn:okf:'; // DEFAULT_IRI_BASE (packages/okf/src/constants.ts)
// The four NON-reserved .md concepts (index.md / tables/index.md are reserved).
const CONCEPT_IDS = ['beta', 'hub', 'tables/alpha', 'tables/gamma'] as const;
const CONCEPT_IRIS = CONCEPT_IDS.map((id) => `${IRI_BASE}${id}`);
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_NAME = 'http://schema.org/name';
const SCHEMA_MENTIONS = 'http://schema.org/mentions';

let state: DevnetState;
let node: DevnetNode;

// Unique, isolated CG id per `it` (off-chain, public, ephemeral).
let cgSeq = 0;
const freshCgId = (): string =>
  `pr1388-okf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}-${++cgSeq}`;

// `dkg okf` writes a per-concept stage manifest into the bundle dir by default;
// give every run its OWN manifest path so a previous import never makes a later
// fresh-CG import skip-as-"done". (--manifest is a real flag, okf.ts line ~196.)
const manifestFor = (cgId: string): string =>
  join(import.meta.dirname, `.okf-manifest-${cgId}.json`);

// SPARQL binding normalizers (unwrapIri, valueOf) now live in the shared harness —
// single typed SparqlBindingCell boundary (otReviewAgent #1397). harness.unwrapIri
// does valueOf() internally, so `unwrapIri(cellStr(x))` collapses to `unwrapIri(x)`.

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected — run ./scripts/devnet.sh start 6 (and `pnpm run build`) first.',
    );
  }
  state = detected;
  await ensureAllIdentities(state, 4);
  node = state.nodes[1]!;
}, 240_000);

describe('PR #1388 — OKF bundle → DKG memory integration', () => {
  it('maps a conformant OKF bundle to urn:okf: concept IRIs offline (import --dry-run)', async () => {
    const res = await runDkgCli(node, ['okf', 'import', BUNDLE_DIR, '--dry-run'], 60_000);
    expect(res.code, `okf import --dry-run failed:\n${res.stdout}\n${res.stderr}`).toBe(0);

    const summary = parseLastJsonBlock(res.stdout, 'okf import --dry-run stdout');
    expect(summary.mode).toBe('dry-run');
    // Offline default is Working Memory, per-concept.
    expect(summary.memoryLayer).toBe('WM');
    expect(summary.conformant, `bundle not conformant: ${JSON.stringify(summary.conformanceErrors)}`)
      .toBe(true);
    // The fixture has exactly 4 concepts; index.md + tables/index.md are reserved.
    expect(summary.concepts).toBe(CONCEPT_IDS.length);
    expect(summary.reservedSkipped).toBe(2);

    // Every concept gets a deterministic subject IRI under urn:okf:.
    const iris = (summary.iris ?? {}) as Record<string, string>;
    for (const id of CONCEPT_IDS) {
      expect(iris[id], `missing IRI for concept "${id}"`).toBe(`${IRI_BASE}${id}`);
    }
    // The cross-concept link graph is reconstructed (hub mentions 3 others, etc.).
    expect(Number(summary.linksResolved)).toBeGreaterThan(0);
  });

  it('a default import lands the concepts in Working Memory (CLI summary), then --share makes triples + link graph queryable in Shared Working Memory', async () => {
    // (a) WM-default landing — asserted via the import CLI summary (the WM view
    //     itself requires a per-agent agentAddress the harness does not thread).
    const wmCg = freshCgId();
    const wm = await runDkgCli(
      node,
      [
        'okf',
        'import',
        BUNDLE_DIR,
        '--context-graph-id',
        wmCg,
        '--create-context-graph',
        '--manifest',
        manifestFor(wmCg),
      ],
      120_000,
    );
    expect(wm.code, `okf import (WM) failed:\n${wm.stdout}\n${wm.stderr}`).toBe(0);
    const wmSummary = parseLastJsonBlock(wm.stdout, 'okf import WM stdout');
    expect(wmSummary.mode).toBe('import');
    expect(wmSummary.memoryLayer).toBe('WM');
    expect(wmSummary.contextGraphId).toBe(wmCg);
    // All four concepts created as Working-Memory KAs; none shared (WM default).
    expect(wmSummary.assetsCreated).toBe(CONCEPT_IDS.length);
    expect(wmSummary.assetsShared).toBe(0);

    // (b) --share → SHARED working memory, the agentAddress-free layer that the
    //     shipped okf export/verify code reads. Query it and assert the concept
    //     triples + reconstructed cross-concept link graph are team-visible.
    const cgId = freshCgId();
    const res = await runDkgCli(
      node,
      [
        'okf',
        'import',
        BUNDLE_DIR,
        '--context-graph-id',
        cgId,
        '--create-context-graph',
        '--share',
        '--manifest',
        manifestFor(cgId),
      ],
      180_000,
    );
    expect(res.code, `okf import --share failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
    const summary = parseLastJsonBlock(res.stdout, 'okf import --share stdout');
    expect(summary.mode).toBe('import');
    expect(summary.memoryLayer).toBe('SWM');
    expect(summary.assetsShared).toBe(CONCEPT_IDS.length);

    // Mirror okf export's read: every urn:okf: subject in the shared-working-memory view.
    const sparql =
      `SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } ` +
      `FILTER(STRSTARTS(STR(?s), "${IRI_BASE}")) }`;
    const bindings = await queryNode(node, sparql, {
      contextGraphId: cgId,
      view: 'shared-working-memory',
    });
    expect(bindings.length, `no urn:okf: triples in SWM for ${cgId}`).toBeGreaterThan(0);

    const triples = bindings.map((b) => ({
      s: unwrapIri(b.s),
      p: unwrapIri(b.p),
      o: unwrapIri(b.o),
    }));
    const subjects = new Set(triples.map((t) => t.s));
    // Every concept subject is visible team-wide in SWM.
    for (const iri of CONCEPT_IRIS) {
      expect(subjects.has(iri), `shared concept ${iri} not visible in SWM`).toBe(true);
    }
    // Each concept carries an rdf:type (conformance signal) and a schema:name.
    const typed = new Set(triples.filter((t) => t.p === RDF_TYPE).map((t) => t.s));
    const named = new Set(triples.filter((t) => t.p === SCHEMA_NAME).map((t) => t.s));
    for (const iri of CONCEPT_IRIS) {
      expect(typed.has(iri), `concept ${iri} has no rdf:type in SWM`).toBe(true);
      expect(named.has(iri), `concept ${iri} has no schema:name in SWM`).toBe(true);
    }
    // The reconstructed cross-concept link graph: hub mentions tables/alpha,
    // beta, tables/gamma (schema:mentions, object = a urn:okf: concept IRI).
    const hubMentions = new Set(
      triples
        .filter((t) => t.s === `${IRI_BASE}hub` && t.p === SCHEMA_MENTIONS)
        .map((t) => t.o),
    );
    expect(hubMentions.has(`${IRI_BASE}tables/alpha`), 'hub→alpha edge missing').toBe(true);
    expect(hubMentions.has(`${IRI_BASE}beta`), 'hub→beta edge missing').toBe(true);
    expect(hubMentions.has(`${IRI_BASE}tables/gamma`), 'hub→gamma edge missing').toBe(true);
  });

  it('okf verify confirms the shared Context Graph is complete against the bundle (per-predicate integrity gate)', async () => {
    const cgId = freshCgId();
    const imp = await runDkgCli(
      node,
      [
        'okf',
        'import',
        BUNDLE_DIR,
        '--context-graph-id',
        cgId,
        '--create-context-graph',
        '--share',
        '--manifest',
        manifestFor(cgId),
      ],
      180_000,
    );
    expect(imp.code, `okf import --share failed:\n${imp.stdout}\n${imp.stderr}`).toBe(0);

    // `okf verify` re-queries the CG (includeSharedMemory, agentAddress-free) and
    // compares triple counts per integrity predicate against the offline mapping.
    // It exits 0 iff complete — so a non-zero exit here is itself a failure.
    const ver = await runDkgCli(
      node,
      ['okf', 'verify', BUNDLE_DIR, '--context-graph-id', cgId],
      120_000,
    );
    expect(ver.code, `okf verify exited non-zero (shortfall):\n${ver.stdout}\n${ver.stderr}`).toBe(0);

    const report = parseLastJsonBlock(ver.stdout, 'okf verify stdout');
    expect(report.mode).toBe('verify');
    expect(report.contextGraphId).toBe(cgId);
    expect(report.complete, `verify not complete: ${JSON.stringify(report.predicates)}`).toBe(true);
    expect(report.totalMissingTriples).toBe(0);
    // rdf:type is an integrity predicate: every concept must have one present.
    const preds = (report.predicates ?? []) as Array<{
      predicate: string;
      expected: number;
      actual: number;
      missing: number;
    }>;
    const rdfTypeRow = preds.find((p) => p.predicate === RDF_TYPE);
    expect(rdfTypeRow, 'verify report missing the rdf:type predicate row').toBeTruthy();
    expect(rdfTypeRow!.expected).toBe(CONCEPT_IDS.length);
    expect(rdfTypeRow!.actual).toBe(CONCEPT_IDS.length);
    expect(rdfTypeRow!.missing).toBe(0);
    // The cross-concept edge predicate (schema:mentions) is present and complete.
    const mentionsRow = preds.find((p) => p.predicate === SCHEMA_MENTIONS);
    expect(mentionsRow, 'verify report missing the schema:mentions predicate row').toBeTruthy();
    expect(mentionsRow!.missing).toBe(0);
    expect(mentionsRow!.actual).toBeGreaterThan(0);
  });

  it('round-trips: okf export serialises the shared Context Graph back into a conformant OKF bundle', async () => {
    // 1) Import + share so there is shared substance to export.
    const cgId = freshCgId();
    const imp = await runDkgCli(
      node,
      [
        'okf',
        'import',
        BUNDLE_DIR,
        '--context-graph-id',
        cgId,
        '--create-context-graph',
        '--share',
        '--manifest',
        manifestFor(cgId),
      ],
      180_000,
    );
    expect(imp.code, `okf import --share failed:\n${imp.stdout}\n${imp.stderr}`).toBe(0);

    // 2) Export the shared CG into a throwaway output dir.
    const outDir = join(import.meta.dirname, `.okf-export-${cgId}`);
    const exp = await runDkgCli(
      node,
      ['okf', 'export', cgId, outDir, '--view', 'shared-working-memory'],
      120_000,
    );
    expect(exp.code, `okf export failed:\n${exp.stdout}\n${exp.stderr}`).toBe(0);
    const expSummary = parseLastJsonBlock(exp.stdout, 'okf export stdout');
    expect(expSummary.mode).toBe('export');
    expect(expSummary.contextGraphId).toBe(cgId);
    // Every concept (4) is rebuilt as a bundle file (section/skolem nodes excluded).
    expect(Number(expSummary.concepts)).toBe(CONCEPT_IDS.length);
    expect(Number(expSummary.files)).toBeGreaterThanOrEqual(CONCEPT_IDS.length);

    // 3) The exported bundle is itself a valid OKF bundle: re-running import
    //    --dry-run over it reproduces the same concept IRIs (clean inverse).
    const reimport = await runDkgCli(node, ['okf', 'import', outDir, '--dry-run'], 60_000);
    expect(reimport.code, `re-import of exported bundle failed:\n${reimport.stdout}\n${reimport.stderr}`)
      .toBe(0);
    const reSummary = parseLastJsonBlock(reimport.stdout, 'okf re-import --dry-run stdout');
    expect(reSummary.conformant).toBe(true);
    expect(reSummary.concepts).toBe(CONCEPT_IDS.length);
    const reIris = (reSummary.iris ?? {}) as Record<string, string>;
    for (const id of CONCEPT_IDS) {
      expect(reIris[id], `round-tripped concept "${id}" lost its IRI`).toBe(`${IRI_BASE}${id}`);
    }
  });
});
