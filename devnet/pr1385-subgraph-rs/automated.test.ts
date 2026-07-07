/**
 * PR #1385 — Random-Sampling extraction reads NAMED SUB-GRAPH knowledge assets.
 *
 * What the PR fixes (network-observable, verified in source before authoring):
 *
 *   A KA published into a registered named sub-graph was previously UNPROVABLE
 *   by the RS prover. A sub-graph KA is sampled under the PARENT cgId (the chain
 *   has no sub-graph dimension), but its public data does NOT live in the
 *   per-cgId data graph the old extractor read — it lives in
 *     - the bare sub-graph graph   `did:dkg:context-graph:<cg>/<sub>`        (replica), and
 *     - the per-KA verifiable-memory layer
 *       `did:dkg:context-graph:<cg>/<sub>/_verifiable_memory/<author>/<number>` (author).
 *   So the per-cgId read yielded nothing → `KCDataMissingError` → the prover
 *   skipped the period forever for any CG containing a sub-graph KA.
 *
 *   The fix (packages/random-sampling/src/ka-extractor.ts ~178-401):
 *   `extractV10KCFromStore` now runs a read-path CASCADE. For each root entity
 *   that the per-cgId data graph (a) cannot satisfy, it DISCOVERS the sub-graph
 *   name from `_meta` (`resolveSubGraphNameFromMeta`, lines 420-438; read-both:
 *   per-cgId `_meta` UNION the default-label `<NAME>/_meta`) and falls back to
 *   (b1) the per-KA VM layer `contextGraphLayerUri(..., sg)` then (b2) the bare
 *   sub-graph graph `contextGraphSubGraphUri(cg, sg)`. FIRST non-empty source per
 *   root wins (never a UNION → no leaf inflation). Leaves are still
 *   `hashTripleV10` of the same triple content, so anchored roots are unchanged
 *   — a read-path change only.
 *
 * WHAT THIS SUITE ASSERTS (it 3 is the deterministic, OUR-KA-specific proof;
 * the others are supporting evidence + a no-stall regression guard):
 *
 *   it 1 (DETERMINISTIC — materialization): the sub-graph KA's triple is
 *     materialized in exactly the graphs the post-#1385 extractor reads. We probe
 *     via the daemon query route, which (no-view path) scopes a
 *     `{contextGraphId, subGraphName}` query to
 *     `GRAPH <…/<cg>/<sub>>` UNION its `…/<sub>/_verifiable_memory/*` per-KA
 *     graphs (packages/query/src/dkg-query-engine.ts:247-264 →
 *     contextGraphSubGraphUri, packages/core/src/constants.ts:327). On the
 *     publisher/author node the VM layer is in scope, so the triple is reachable
 *     by sub-graph name — the same bare sub-graph / VM homes (b1)/(b2) the
 *     extractor falls back to. Pre-#1385 a sub-graph KA's content was unreachable
 *     from the CG scope; post-#1385 it lives in the named sub-graph graph.
 *
 *   it 2 (DETERMINISTIC — read-path semantics, NOT a guess): the SAME triple is
 *     NOT reachable from a plain PARENT-CG-scope query (contextGraphId only, no
 *     subGraphName, no view). Confirmed in source: the no-view scope resolves
 *     `dataGraph = contextGraphDataUri(<cg>)` = bare `did:dkg:context-graph:<cg>`
 *     plus only the ROOT's `…/_verifiable_memory/` prefix (dkg-query-engine.ts:
 *     250,259) — there is NO `discoverRegisteredSubGraphNames` fan-out on the
 *     no-view path (that fan-out exists for VIEW reads only, GH #675, line 488).
 *     So sub-graph data is visible ONLY when the sub-graph is named. This mirrors
 *     EXACTLY the extractor's premise: "the per-cgId data graph is empty for a
 *     sub-graph KA" — which is precisely why #1385's discover-and-fall-back
 *     cascade is needed. (Asserting reachability-from-parent here would
 *     contradict the real semantics and the PR's own motivation.)
 *
 *   it 3 (DETERMINISTIC — THE #1385 REGRESSION, OUR KA specifically): we run the
 *     REAL production `extractV10KCFromStore` (the #1385 code path itself) against
 *     node1's live oxigraph over the standard SPARQL-HTTP adapter, with the
 *     per-cgId data-graph read BLANKED so the #1385 sub-graph cascade is forced to
 *     fire (the publisher's per-cgId promotion — dkg-publisher.ts:1745 — otherwise
 *     copies the sub-graph KA into `…/context/<cgId>` and path (a) satisfies it
 *     without ever exercising #1385, which would make a plain root check green
 *     even if #1385 were reverted). We then assert BOTH: (a) the extractor
 *     resolved OUR `subGraphName` and read every triple from OUR sub-graph home
 *     (proves the cascade fired), and (b) the leaves recompute — exactly the way
 *     the prover does, `structuredKARootV10(triples.map(hashTripleV10),
 *     privateRoots)` (proof-material.ts:118-131) — to the ON-CHAIN-anchored
 *     merkleRoot for OUR kaId (DKGKnowledgeAssets.getLatestMerkleRoot). That is
 *     fully deterministic and independent of which KA the network draw samples —
 *     it directly proves OUR sub-graph KA is extractable AND provable.
 *
 *   it 4 (BEST-EFFORT — no-stall liveness guard, NOT an OUR-KA proof): with a
 *     sub-graph KA resident in the shared `devnet-test` CG, the RS prover must
 *     still LAND a proof on-chain (a broken sub-graph extractor would stall every
 *     period with KCDataMissingError → no proof ever lands). Gate on the ON-CHAIN
 *     solved flag (getNodeChallenge tuple index [6], in a NEWER period than the
 *     baseline) OR a submittedCount increase on some core. This is a regression
 *     guard that the prover doesn't STALL with a sub-graph KA present — it does
 *     NOT and CANNOT prove OUR specific KA was sampled: the network draw samples
 *     across every weighted CG so which KA is sampled is non-deterministic. The
 *     deterministic OUR-KA evidence is it 3; this only logs (never gates on) the
 *     kaId match.
 *
 * SUB-GRAPH PUBLISH FLOW (each command/flag verified in source):
 *   1. Register the sub-graph (idempotent on this devnet) — POST
 *      /api/sub-graph/create { contextGraphId, subGraphName }
 *      (packages/cli/src/daemon/routes/context-graph.ts:727; body validated by
 *      validateSubGraphName). Equivalent CLI: `dkg context-graph create-sub-graph
 *      <cg> <sg>` (positional, commands/context-graph.ts:265).
 *   2. Stage the KA into the sub-graph — `dkg ka create <name> -c <cg>
 *      --input-file <file> --share --sub-graph-name <sg>` (the #1410 KA
 *      lifecycle CLI; addSubGraphOption is applied to ka create/publish in
 *      commands/knowledge-asset.ts, so sub-graph routing rides the same flag).
 *   3. Publish it on-chain — `dkg ka publish <name> -c <cg> --sub-graph-name
 *      <sg>` (SWM → VM/chain). Prints `Status:` + `KA ID:` we parse for the
 *      kaId. (The pre-#1410 `dkg shared-memory write/publish` commands this
 *      suite originally drove were removed with the rest of the legacy verbs.)
 *
 * ISOLATION (this suite runs against ONE shared 6-node devnet, in sequence with
 * the rest of the 10.0.2 sweep):
 *   - Creates only EPHEMERAL self-named entities: a fresh sub-graph name
 *     (`pr1385sg<ts>`) + a unique KA subject (`urn:test:pr1385-subgraph:<ts>:n`).
 *   - Additive publishing into the shared `devnet-test` CG is REQUIRED (the RS
 *     prover only samples KAs in bootstrapped CGs) and is fine — it adds, never
 *     mutates, and every query is scoped by our unique subject so no other suite's
 *     data interferes.
 *   - Never touches node identities / op-wallets; NEVER time-warps (that breaks
 *     in-flight RS challenges this very suite needs to land).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  detectDevnet,
  ensureAllIdentities,
  runDkgCli,
  runKaPublishLifecycle,
  writeNquads,
  queryNode,
  postJson,
  getJson,
  waitFor,
  contractAt,
  valueOf,
  lexical,
  CONTEXT_GRAPH,
  type DevnetState,
  type DevnetNode,
} from '../_bootstrap/harness.js';
// The REAL #1385 code path + the on-chain-oracle machinery it feeds. We run the
// production `extractV10KCFromStore` against node1's live oxigraph over the
// standard SPARQL 1.1 HTTP adapter (`SparqlHttpStore`), then recompute the KA's
// V10 root the exact way the prover does (prover.ts:392-395 → proof-material.ts:
// 118-131: `structuredKARootV10(triples.map(hashTripleV10), privateRoots)`) and
// compare it to the on-chain-anchored root. That deterministically proves OUR
// sub-graph KA is extractable AND provable — independent of the network draw.
import { SparqlHttpStore } from '@origintrail-official/dkg-storage';
import { extractV10KCFromStore } from '@origintrail-official/dkg-random-sampling';
import { structuredKARootV10, hashTripleV10 } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

// Predicate + object literal for the unique sub-graph triple. The object value
// is asserted to round-trip out of the sub-graph graph in it 1.
const PRED = 'https://schema.org/identifier';
const OBJECT_VALUE = 'pr1385-subgraph-rs-marker';

// SPARQL binding normalizers (valueOf / lexical) now live in the shared harness —
// single typed SparqlBindingCell boundary (otReviewAgent #1397).

/** bytes32 hex compare, case-insensitive. */
const hexEq = (a: Uint8Array, b: string): boolean =>
  '0x' + Buffer.from(a).toString('hex') === b.toLowerCase();

/**
 * Resolve a node's LOCAL oxigraph SPARQL 1.1 endpoint from its `config.json`.
 * The devnet cores run the `oxigraph-server` backend (`store.options.port`), so
 * `http://127.0.0.1:<port>/query` is the RAW store — no daemon `/api/query`
 * scoping/rewrite — which is exactly what the RS prover's extractor reads
 * (`extractV10KCFromStore` issues explicit `GRAPH <uri>` SPARQL that must hit
 * the store un-rewritten). Returns null if the node isn't oxigraph-server.
 */
function oxigraphQueryEndpoint(node: DevnetNode): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(node.home, 'config.json'), 'utf8'));
    if (cfg?.store?.backend !== 'oxigraph-server') return null;
    const port = cfg?.store?.options?.port;
    if (!port) return null;
    return `http://127.0.0.1:${port}/query`;
  } catch {
    return null;
  }
}

/**
 * A read-only TripleStore decorator that BLANKS the per-cgId data-graph
 * CONSTRUCT so the #1385 sub-graph cascade (discover-from-`_meta` → b1 per-KA
 * VM layer → b2 bare sub-graph graph) is forced to fire.
 *
 * WHY this is faithful, not synthetic: the publisher's publish→per-cgId
 * promotion COPIES every KA's public quads (sub-graph KAs included) into the
 * per-cgId data graph `<NAME>/context/<cgId>` (dkg-publisher.ts:1745 — "RS
 * prover's extractV10KCFromStore reads triples from there"). So on any core that
 * ran the promotion, the extractor's path (a) satisfies a sub-graph KA and the
 * #1385 cascade never fires — which means a plain root check on node1 is
 * satisfied by the PRE-#1385 path and would stay green even if #1385 were
 * reverted (the very false-confidence this test must not have). Blanking ONLY
 * the per-cgId data-graph read reproduces a replica / un-promoted node's store
 * view — the real scenario #1385 was written for — using the real data, the real
 * extractor, and the real on-chain oracle. Nothing else is touched: `_meta`
 * reads (`…/context/<cgId>/_meta`, `…/_meta`), the VM layer and the bare
 * sub-graph graph all pass straight through, so the leaves the extractor returns
 * are the genuine sub-graph-home triples.
 *
 * The match is anchored on the exact `GRAPH <…/context/<cgId>>` token WITH its
 * closing `>` so the sibling `…/context/<cgId>/_meta` graph (which the extractor
 * MUST still read for the UAL/rootEntity/subGraphName resolution) is untouched.
 */
function makeReplicaView(inner: TripleStore, perCgIdDataGraph: string): TripleStore {
  const blankMarker = `GRAPH <${perCgIdDataGraph}>`;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sparql: string, options?: unknown) => {
          const isConstruct = sparql.trim().toUpperCase().startsWith('CONSTRUCT');
          if (isConstruct && sparql.includes(blankMarker)) {
            return { type: 'quads' as const, quads: [] };
          }
          return (target as TripleStore).query(sparql, options as never);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as TripleStore;
}

interface Suite {
  state: DevnetState;
  node: DevnetNode; // publisher / author (node1, a core node with an identity)
  subGraphName: string;
  subject: string;
  kaId: bigint;
}

const suite: Partial<Suite> = {};

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error(
      'No devnet detected — run `./scripts/devnet.sh start 6` before this suite ' +
        '(needs a live 6-node devnet + deployed V10 contracts).',
    );
  }
  await ensureAllIdentities(detected, 4);

  const node = detected.nodes[1]!;
  if (node.identityId === 0n) {
    throw new Error('node1 has no on-chain identity — bootstrap the devnet first');
  }

  // Unique, self-named ephemeral entities (validateSubGraphName: alphanumeric/
  // dash-ish; keep it lowercase-alnum to be safe across the validator).
  const ts = Date.now();
  suite.state = detected;
  suite.node = node;
  suite.subGraphName = `pr1385sg${ts}`;
  suite.subject = `urn:test:pr1385-subgraph:${ts}:1`;
}, 240_000);

describe('PR #1385 — RS extraction reads named sub-graph KAs (live 6-node devnet)', () => {
  it(
    'registers a sub-graph + publishes a KA into it; the triple is materialized in the named sub-graph graph',
    async () => {
      const s = suite as Suite;
      const node = s.node;
      const name = `pr1385-${Date.now()}`;

      // ── 1. Register the sub-graph (idempotent on a warm devnet) ──────────────
      // POST /api/sub-graph/create { contextGraphId, subGraphName }
      // (routes/context-graph.ts:727). 200 = created; 400 "already exists" is
      // also acceptable (our name is unique-by-timestamp, so 200 is expected).
      const reg = await postJson(node, '/api/sub-graph/create', {
        contextGraphId: CONTEXT_GRAPH,
        subGraphName: s.subGraphName,
      });
      const okCreate =
        reg.status === 200 ||
        (reg.status === 400 && /already exists/i.test(JSON.stringify(reg.json)));
      expect(
        okCreate,
        `sub-graph register failed (${reg.status}): ${JSON.stringify(reg.json)}`,
      ).toBe(true);

      // ── 2+3. Stage the KA INTO the sub-graph, then publish it on-chain ──────
      // #1410 KA lifecycle CLI (`ka create --share`: WM → finalize → SWM, then
      // `ka publish`: SWM → VM/chain) via the shared runKaPublishLifecycle
      // helper (devnet/_bootstrap/harness.ts), which owns the argument arrays
      // and the `Status:`/`KA ID:` stdout parsing (status lowercased). We pass
      // --sub-graph-name on BOTH steps. The n-quads file is labelled with the
      // PARENT CG graph URI — sub-graph routing is the --sub-graph-name flag,
      // NOT the file's graph label.
      const g = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
      const file = writeNquads(import.meta.dirname, name, [
        `<${s.subject}> <${PRED}> "${OBJECT_VALUE}" <${g}>`,
        `<${s.subject}> <https://schema.org/name> "${name}" <${g}>`,
      ]);

      const result = await runKaPublishLifecycle(
        (args) => runDkgCli(node, args, 120_000),
        {
          kaName: name,
          contextGraphId: CONTEXT_GRAPH,
          inputFile: file,
          createArgs: ['--sub-graph-name', s.subGraphName],
          publishArgs: ['--sub-graph-name', s.subGraphName],
        },
      );
      expect(
        ['confirmed', 'finalized', 'tentative'],
        `sub-graph publish status="${result.status}"\n${result.raw}`,
      ).toContain(result.status);
      expect(result.kaId, `sub-graph publish surfaced no "KA ID:"\n${result.raw}`).toBeDefined();
      s.kaId = result.kaId!;
      expect(s.kaId, 'sub-graph KA id must be positive').toBeGreaterThan(0n);
      // eslint-disable-next-line no-console
      console.log(
        `#1385: published sub-graph KA — cg=${CONTEXT_GRAPH} sub=${s.subGraphName} ` +
          `kaId=${s.kaId} subject=${s.subject}`,
      );

      // ── 4. CORE ASSERTION: the triple is in the named SUB-GRAPH graph ────────
      // A no-view `{contextGraphId, subGraphName}` query scopes to
      //   GRAPH <did:dkg:context-graph:<cg>/<sub>> UNION its …/_verifiable_memory/*
      // (dkg-query-engine.ts:247-264). On the AUTHOR node (node1) the per-KA VM
      // layer is in scope, so the triple is reachable BY SUB-GRAPH NAME — exactly
      // the (b1)/(b2) homes the post-#1385 extractor falls back to. Plain BGP, no
      // GRAPH clause: the engine wraps it onto the scoped graphs (wrapWithGraph
      // /Union). Post-publish store materialization lags → poll.
      const bindings = await waitFor(
        `sub-graph triple <${s.subject}> visible under sub-graph "${s.subGraphName}"`,
        120_000,
        3_000,
        async () => {
          const rows = await queryNode(
            node,
            `SELECT ?o WHERE { <${s.subject}> <${PRED}> ?o }`,
            { contextGraphId: CONTEXT_GRAPH, subGraphName: s.subGraphName },
          );
          return rows.length > 0 ? rows : null;
        },
      );

      expect(bindings.length, 'expected >=1 binding for the sub-graph triple').toBeGreaterThanOrEqual(1);
      const objects = bindings.map((r) => lexical(r.o));
      expect(
        objects,
        `sub-graph query returned ${JSON.stringify(objects)}, expected to contain "${OBJECT_VALUE}"`,
      ).toContain(OBJECT_VALUE);
      // eslint-disable-next-line no-console
      console.log(
        `#1385: sub-graph triple reachable via subGraphName="${s.subGraphName}" ` +
          `(value="${OBJECT_VALUE}") — the bare-sub-graph / VM home the extractor reads`,
      );
    },
    300_000,
  );

  it(
    'the same triple is NOT reachable from a plain PARENT-CG-scope query (sub-graph data is sub-graph-scoped)',
    async () => {
      const s = suite as Suite;
      expect(s.kaId, 'it 1 must have published the sub-graph KA first').toBeGreaterThan(0n);

      // A no-view query scoped to the CG WITHOUT subGraphName resolves to the bare
      // `did:dkg:context-graph:<cg>` data graph + only the ROOT's
      // …/_verifiable_memory/ prefix (dkg-query-engine.ts:250,259). There is NO
      // sub-graph fan-out on the no-view path (the GH #675 fan-out is VIEW-only,
      // line 488), so the sub-graph triple must NOT appear here. This is the exact
      // mirror of the extractor's premise — "the per-cgId data graph is empty for a
      // sub-graph KA" — which is WHY #1385's discover-and-fall-back cascade exists.
      //
      // Re-query the sub-graph scope first to confirm the triple is genuinely
      // present (guards against a false-pass where 0 rows just means "not yet
      // materialized" rather than "correctly out of parent scope").
      const inSub = await queryNode(
        s.node,
        `SELECT ?o WHERE { <${s.subject}> <${PRED}> ?o }`,
        { contextGraphId: CONTEXT_GRAPH, subGraphName: s.subGraphName },
      );
      expect(
        inSub.length,
        'precondition: triple must still be present under the sub-graph scope',
      ).toBeGreaterThanOrEqual(1);

      const inParent = await queryNode(
        s.node,
        `SELECT ?o WHERE { <${s.subject}> <${PRED}> ?o }`,
        { contextGraphId: CONTEXT_GRAPH }, // no subGraphName, no view
      );
      expect(
        inParent.length,
        `sub-graph triple must NOT be visible from the parent CG scope, ` +
          `got ${JSON.stringify(inParent.map((r) => valueOf(r.o)))}`,
      ).toBe(0);
      // eslint-disable-next-line no-console
      console.log(
        `#1385: sub-graph triple correctly scoped — present under "${s.subGraphName}", ` +
          `absent from bare "${CONTEXT_GRAPH}" (the empty per-cgId graph the old extractor read)`,
      );
    },
  );

  it(
    'DETERMINISTIC (#1385 regression): the REAL extractor recomputes OUR sub-graph ' +
      "KA's V10 root — via the sub-graph cascade — equal to the on-chain-anchored root",
    async () => {
      const s = suite as Suite;
      expect(s.kaId, 'it 1 must have published the sub-graph KA first').toBeGreaterThan(0n);

      // This is the deterministic evidence the otReviewAgent asked for: it does
      // NOT depend on which KA the network draw samples. We run the ACTUAL
      // production `extractV10KCFromStore` (the #1385 code path) against node1's
      // live oxigraph, FORCE the #1385 sub-graph cascade, recompute the KA's V10
      // root exactly as the prover does, and assert it equals the root anchored
      // on-chain for OUR kaId. That proves OUR sub-graph KA is extractable AND
      // provable — precisely the #1385 regression.

      // node1 (author/publisher) runs oxigraph-server, so we get the RAW store
      // over the standard SPARQL-HTTP adapter — no daemon scoping — which is what
      // the prover's extractor reads.
      const endpoint = oxigraphQueryEndpoint(s.node);
      expect(
        endpoint,
        `node${s.node.num} is not oxigraph-server (no raw SPARQL endpoint to run the real extractor against)`,
      ).toBeTruthy();

      // On-chain oracle: the KA's anchored V10 merkleRoot. The shared harness's
      // `state.kas` ABI only carries getLatestMerkleRootAuthor, so build a handle
      // with the accessor we need (DKGKnowledgeAssets.json:1435-1453).
      const kas = contractAt(s.state, 'DKGKnowledgeAssets', [
        'function getLatestMerkleRoot(uint256) view returns (bytes32)',
      ]);
      const onChainRoot: string = await kas.getLatestMerkleRoot(s.kaId);
      expect(
        /^0x[0-9a-fA-F]{64}$/.test(onChainRoot) && !/^0x0{64}$/.test(onChainRoot),
        `on-chain root for kaId=${s.kaId} is unset/zero (${onChainRoot}) — KA not anchored?`,
      ).toBe(true);

      const cgId = 1n; // devnet-test → on-chain id 1 (ontology graph mapping)
      const raw: TripleStore = new SparqlHttpStore({ queryEndpoint: endpoint!, timeout: 30_000 });
      // Blank the per-cgId data graph so the #1385 cascade (VM layer / bare
      // sub-graph graph) is exercised rather than the promotion-populated
      // per-cgId path — see makeReplicaView for why this is faithful.
      const store = makeReplicaView(raw, `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${cgId}`);

      // Post-publish, the per-cgId + default `_meta` (batchId/rootEntity/
      // subGraphName) and the VM sub-graph layer materialize with lag; until then
      // the extractor throws KCDataMissingError/KCNotFoundError. Poll.
      const extracted = await waitFor(
        `the real extractor to resolve OUR sub-graph KA (kaId=${s.kaId}) via the #1385 cascade`,
        180_000,
        5_000,
        async () => {
          try {
            const r = await extractV10KCFromStore(store, cgId, s.kaId);
            // Require the cascade to have fired into the sub-graph home — i.e.
            // triples came from a graph carrying our sub-graph name. If the
            // per-cgId blanking somehow didn't force it (data still syncing),
            // keep polling rather than asserting on a half-synced view.
            const cascadeFired =
              r.subGraphName === s.subGraphName &&
              r.triples.length > 0 &&
              r.triples.every((t) => (t.graph ?? '').includes(`/${s.subGraphName}`));
            return cascadeFired ? r : null;
          } catch {
            return null; // KCDataMissingError / KCNotFoundError — still syncing
          }
        },
      );

      // (1) The #1385 discover-and-fall-back cascade actually fired for OUR KA:
      // `subGraphName` is set ONLY when a root is satisfied from a sub-graph home
      // (ka-extractor.ts:363), never from the per-cgId data graph. This is the
      // self-guard — if a future change let path (a) satisfy despite the blanking,
      // this would come back `undefined` and fail loudly instead of silently not
      // testing the fix.
      expect(
        extracted.subGraphName,
        `extractor did not resolve OUR sub-graph name — cascade did not fire ` +
          `(got subGraphName=${extracted.subGraphName})`,
      ).toBe(s.subGraphName);
      const sourceGraphs = [...new Set(extracted.triples.map((t) => t.graph))];
      expect(
        sourceGraphs.every((g) => (g ?? '').includes(`/${s.subGraphName}`)),
        `expected all triples read from OUR sub-graph home, got ${JSON.stringify(sourceGraphs)}`,
      ).toBe(true);

      // (2) The leaves read FROM THE SUB-GRAPH HOME recompute to the on-chain root.
      // Mirror the prover byte-for-byte: leaf = hashTripleV10(s,p,o); the KA root
      // is the STRUCTURED root hashPair(publicRoot, privateDataHash) — NOT the flat
      // `extracted.leaves` tree (proof-material.ts:118-131).
      const leaves = extracted.triples.map((t) => hashTripleV10(t.subject, t.predicate, t.object));
      const { root: recomputedRoot, leafCount } = structuredKARootV10(leaves, extracted.privateRoots);
      expect(
        hexEq(recomputedRoot, onChainRoot),
        `recomputed V10 root (0x${Buffer.from(recomputedRoot).toString('hex')}) ` +
          `!= on-chain-anchored root (${onChainRoot}) for OUR sub-graph kaId=${s.kaId} — ` +
          `the sub-graph home's leaves do NOT reproduce the anchored root`,
      ).toBe(true);

      await raw.close?.();
      // eslint-disable-next-line no-console
      console.log(
        `#1385 (DETERMINISTIC): OUR sub-graph KA kaId=${s.kaId} extracted via the cascade ` +
          `(subGraphName="${extracted.subGraphName}", ${leaves.length} leaf(s) from ` +
          `${JSON.stringify(sourceGraphs)}); recomputed structured V10 root == on-chain root ` +
          `${onChainRoot} (leafCount=${leafCount}). Sub-graph KA is provably extractable — ` +
          `no reliance on the network sampling draw.`,
      );
    },
    300_000,
  );

  it(
    'best-effort: RS still lands a proof on-chain with a sub-graph KA resident (no KCDataMissingError stall)',
    async () => {
      const s = suite as Suite;
      const rss = s.state.rss;

      // Preflight + BEFORE snapshot: every core (1-4) must have the RS prover
      // enabled, and we record each core's current submittedCount so we can accept
      // a strict INCREASE as a liveness signal (the absolute value is non-zero on a
      // warm devnet, so an absolute check would be trivially true).
      const coreIds: Record<number, bigint> = {};
      const before: Record<number, number> = {};
      const beforePeriod: Record<number, bigint> = {};
      for (let n = 1; n <= 4; n++) {
        const node = s.state.nodes[n]!;
        const { status, json } = await getJson(node, '/api/random-sampling/status');
        expect(status, `node${n} /api/random-sampling/status HTTP`).toBe(200);
        expect(
          json?.enabled,
          `node${n} RS prover disabled (identity pending?): ${JSON.stringify(json)}`,
        ).toBe(true);
        coreIds[n] = BigInt(json?.identityId ?? '0');
        expect(coreIds[n], `node${n} identityId from RS status`).toBeGreaterThan(0n);
        before[n] = Number(json?.loop?.submittedCount ?? 0);
        // Baseline the current challenge period so path (A) only counts a
        // challenge SOLVED in a NEWER period than now — a PRE-EXISTING solved
        // challenge must not satisfy liveness (otReviewAgent #1397). Tuple idx
        // [4] = activeProofPeriodStartBlock (monotonic across periods).
        try {
          const ch0 = await rss.getNodeChallenge(coreIds[n]);
          beforePeriod[n] = BigInt(ch0[4] ?? 0n);
        } catch {
          beforePeriod[n] = 0n;
        }
      }

      // Poll for liveness via TWO independent signals (first to fire wins):
      //   (A) ON-CHAIN: some core's current challenge is solved
      //       (getNodeChallenge tuple index [6]) — the authoritative "a proof
      //       landed" signal, robust to which KA the network draw sampled.
      //   (B) submittedCount strictly increased on some core vs the BEFORE
      //       snapshot — the prover progressed during THIS suite.
      // A broken sub-graph extractor would surface as neither firing (the prover
      // would skip every period with kc-not-synced); we also log per-core
      // lastOutcome.kind for that diagnostic.
      const lastOutcomeKinds: Record<number, string> = {};
      const live = await waitFor(
        'an RS proof to land on-chain (solved) OR submittedCount to increase on some core',
        120_000,
        5_000,
        async () => {
          for (let n = 1; n <= 4; n++) {
            const node = s.state.nodes[n]!;
            const id = coreIds[n];
            if (id === 0n) continue;
            // (B) submittedCount increase
            try {
              const { json } = await getJson(node, '/api/random-sampling/status');
              lastOutcomeKinds[n] = json?.loop?.lastOutcome?.kind ?? '?';
              const now = Number(json?.loop?.submittedCount ?? 0);
              if (now > before[n]) {
                return { node: n, identityId: id, via: 'submittedCount' as const };
              }
            } catch {
              /* transient — keep polling */
            }
            // (A) on-chain: a challenge solved in a NEWER period than the
            // baseline — i.e. a proof landed AFTER this suite published its KA.
            // (A pre-existing solved challenge, same period, does NOT count.)
            try {
              const ch = await rss.getNodeChallenge(id);
              if (ch[6] === true && BigInt(ch[4] ?? 0n) > (beforePeriod[n] ?? 0n)) {
                return {
                  node: n,
                  identityId: id,
                  via: 'onChainSolved' as const,
                  knowledgeAssetId: ch[0] as bigint,
                  epoch: ch[3] as bigint,
                };
              }
            } catch {
              /* transient RPC — keep polling */
            }
          }
          return null;
        },
      );

      expect(live.identityId, 'a core must show RS liveness').toBeGreaterThan(0n);

      // Re-read the on-chain challenge for the live core, purely for the log.
      // We DO NOT gate on knowledgeAssetId == our sub-graph kaId: the network draw
      // samples across every weighted CG on the devnet, so which KA is sampled is
      // non-deterministic — this test can only witness that the prover DID NOT
      // STALL, not that OUR KA was the one sampled. The deterministic proof that
      // OUR sub-graph KA is extractable+provable is it 3 (real extractor vs
      // on-chain root); the kaId match below is logged as an incidental bonus,
      // never relied upon.
      try {
        const ch = await rss.getNodeChallenge(live.identityId);
        const sampledKaId = ch[0] as bigint;
        const solved: boolean = ch[6];
        const matchesSubGraphKa = sampledKaId === s.kaId;
        // eslint-disable-next-line no-console
        console.log(
          `#1385 (RS liveness): node${live.node} via=${live.via} solved=${solved} ` +
            `sampledKaId=${sampledKaId} ourSubGraphKaId=${s.kaId} ` +
            `matchesSubGraphKa=${matchesSubGraphKa}` +
            (matchesSubGraphKa
              ? ' [incidental: the sampled KA happened to be ours this run — see it 3 for the deterministic proof]'
              : ''),
        );
      } catch {
        // eslint-disable-next-line no-console
        console.log(`#1385 (RS liveness): node${live.node} via=${live.via} (challenge re-read skipped)`);
      }
      // eslint-disable-next-line no-console
      console.log(`#1385 (RS liveness): per-core lastOutcome kinds=${JSON.stringify(lastOutcomeKinds)}`);
    },
    180_000,
  );
});
