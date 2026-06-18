/**
 * Issue-liveness repros for HIGH / pre-mainnet issues that are only observable
 * across a live multi-node devnet (publish → quorum → replication).
 *
 * Each repro asserts the CORRECT behaviour, so it is RED today (the bug is live
 * on `main`) and turns GREEN once fixed — it stays red until the issue is
 * closed. Eight of these are fixed on PR #1107: when #1107 merges they start
 * passing.
 *
 * These cover the inherently MULTI-NODE issues (publish → quorum → replication),
 * which can't be reproduced in the single-process unit lanes. In CI they run on
 * the "Tornado: devnet integration (multi-node publish/sync)" lane, which boots
 * the devnet itself. To run locally:
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *   pnpm test:devnet:issue-liveness
 *
 * Multi-node coverage here: #1093 #1094 #1095 #1096 #1097 #1098 #1104 #886.
 * The single-process variants of #462 #936 #1013 #1078 live in their package
 * test dirs (run in CI) — see the pointers at the bottom of this file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as http from 'node:http';

// Poll a condition until true or the (generous) deadline — replication latency
// must not flip these into latency tests. They stay bug-sensitive: a long
// timeout only fails if the KA NEVER materializes, not if it's merely slow.
async function pollUntil(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() + intervalMs >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const REPO_ROOT = resolve(__dirname, '../..');
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Node {
  num: number;
  apiPort: number;
  token: string;
}
function readNode(num: number): Node {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) throw new Error(`node${num} missing — run ./scripts/devnet.sh start 6`);
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  let token = '';
  if (existsSync(join(home, 'auth.token'))) {
    token = readFileSync(join(home, 'auth.token'), 'utf8').split('\n').map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  return { num, apiPort: config.apiPort, token };
}
function req(node: Node, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((res, rej) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port: node.apiPort, method, path,
        headers: { Authorization: `Bearer ${node.token}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { try { res({ status: resp.statusCode ?? 0, body: JSON.parse(b) }); } catch { res({ status: resp.statusCode ?? 0, body: b }); } }); },
    );
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const post = (n: Node, p: string, b: unknown) => req(n, 'POST', p, b);
const get = (n: Node, p: string) => req(n, 'GET', p, undefined);

const CORES = [1, 2, 3, 4];
const STAMP = Date.now();

// Shared state for the publish-dependent repros (published once on a working core).
let pubNode: Node | null = null;
let preSubNode: Node; // subscribed BEFORE publish (#1098), distinct from pubNode
// PUBLIC seed CG (accessPolicy:0): the cross-node replication repros (#1098, #886)
// assert peers SEE the published KA — on a CURATED CG those peers would have to
// be invited/allowlisted first, so an unauthorized subscriber could fail for
// membership reasons, not the replication bug. A public CG every devnet core can
// host keeps the repros faithful (Codex review on PR #1129).
const SEED_CG = `high-pub-${STAMP}`;
const KA = `high-ka-${STAMP}`;
const ENTITY = `https://example.org/high/${STAMP}`;
let publishOk = false;

async function publishKaOn(node: Node, cg: string, ka: string): Promise<{ ok: boolean; body: any }> {
  await post(node, '/api/knowledge-assets', { contextGraphId: cg, name: ka });
  await post(node, `/api/knowledge-assets/${ka}/wm/write`, {
    contextGraphId: cg, quads: [{ subject: ENTITY, predicate: 'https://schema.org/name', object: '"HighEntity"' }],
  });
  await post(node, `/api/knowledge-assets/${ka}/wm/finalize`, { contextGraphId: cg });
  await post(node, `/api/knowledge-assets/${ka}/swm/share`, { contextGraphId: cg, entities: 'all' });
  const r = await post(node, `/api/knowledge-assets/${ka}/vm/publish`, { contextGraphId: cg });
  return { ok: r.status === 200 && r.body?.status === 'confirmed', body: r.body };
}

describe('HIGH issue liveness (multi-node devnet)', () => {
  beforeAll(async () => {
    // Phase 1 — find ANY core that can actually publish (some are ACK-poisoned by
    // #1093). Probe ALL cores so the suite still runs even if the only healthy
    // publisher happens to be node 2. Each probe uses its OWN context graph + KA
    // name so a partial/failed probe can't leave state that makes a later probe
    // pass or fail for duplicate-name reasons.
    for (const n of CORES) {
      const node = readNode(n);
      const probeCg = `${SEED_CG}-probe${n}`;
      const probeKa = `${KA}-probe${n}`;
      const created = await post(node, '/api/context-graph/create', { id: probeCg, name: `High Probe ${n}`, accessPolicy: 0 });
      if (created.status >= 400 && created.status !== 409) continue;
      const registered = await post(node, '/api/context-graph/register', { id: probeCg });
      if (registered.status >= 400 && registered.status !== 409) continue;
      const res = await publishKaOn(node, probeCg, probeKa);
      if (res.ok) { pubNode = node; break; }
    }
    if (!pubNode) {
      // Loud HARNESS failure (not a per-test green): without a working publisher
      // the publish-dependent repros (#1095/#1104/#1094/#1096/#1098/#886) can't
      // exercise anything. Fail the whole suite here so it's unmistakable.
      throw new Error(
        'HARNESS: no core node could publish to VM — check devnet health (#1093 ACK poisoning?). ' +
        'Publish-dependent #1095/#1104/#1094/#1096/#1098/#886 repros cannot run.',
      );
    }

    // The pre-subscribed peer (#1098) MUST be a DIFFERENT node than the
    // publisher, else "did the pre-subscribed peer catch up?" degenerates into
    // "does the author see its own VM?" — a false positive. Pick it AFTER the
    // publisher is known (any core that isn't the publisher).
    const preSubNum = CORES.find((n) => n !== pubNode!.num)!;
    preSubNode = readNode(preSubNum);

    // Phase 2 — pre-subscribe the DISTINCT peer to the seed CG BEFORE the seed
    // publish (the precondition #1098 tests), then publish the seed KA on the
    // known-working publisher.
    await post(pubNode, '/api/context-graph/create', { id: SEED_CG, name: 'High Pub', accessPolicy: 0 });
    await post(pubNode, '/api/context-graph/register', { id: SEED_CG });
    await post(preSubNode, '/api/context-graph/subscribe', { contextGraphId: SEED_CG });
    await sleep(3000);
    const seed = await publishKaOn(pubNode, SEED_CG, KA);
    publishOk = seed.ok;
    if (!publishOk) {
      throw new Error('HARNESS: seed publish to SEED_CG failed on the known-working publisher — publish-dependent repros cannot run.');
    }
  }, 240_000);

  // ── #1093 — ACK pool poisoning: not every core can publish ──────────────
  it('GH #1093: every core node can publish to VM (no pool_below_quorum)', async () => {
    const results: Record<number, boolean> = {};
    for (const n of CORES) {
      const node = readNode(n);
      const cg = `gh1093-${STAMP}-${n}`;
      await post(node, '/api/context-graph/create', { id: cg, name: 'gh1093' });
      await post(node, '/api/context-graph/register', { id: cg });
      const res = await publishKaOn(node, cg, `gh1093-ka-${n}`);
      results[n] = res.ok;
    }
    // Every core with 3+ healthy core peers must be able to collect quorum.
    expect(Object.values(results).every(Boolean)).toBe(true);
  });

  // ── #1124 — public CG cannot reach storage-ACK quorum ───────────────────
  // The end-to-end multi-node repro needs a host-mode sharded topology
  // (non-member storage cores); on a 6-node local devnet every core IS a CG
  // member so the bug can't manifest. A single-process unit repro is also not a
  // clean red→green signal: `ingestSwmHostModeEnvelope` drops a public-CG
  // plaintext share at TWO independent gates — the `isCiphertext` sniff AND the
  // curated-agent authority check (which rejects a CG with no agent allowlist,
  // i.e. exactly the public-CG case). Since the fix must change both, isolating
  // either gate gives a false signal. Needs a host-mode sharded fixture that
  // exercises the full public-CG ingest path.
  it.skip('GH #1124: public CG publish reaches storage-ACK quorum (needs host-mode sharded fixture — multi-gate ingest)');

  // ── #1097 — documented one-shot publish flow returns 500 ────────────────
  it('GH #1097: SKILL.md one-shot publish (create{quads} → publish{assertionName}) works', async () => {
    const node = pubNode ?? readNode(1);
    const cg = `gh1097-${STAMP}`;
    await post(node, '/api/context-graph/create', { id: cg, name: 'gh1097', accessPolicy: 0 });
    await post(node, '/api/context-graph/register', { id: cg });
    const create = await post(node, '/api/knowledge-assets', {
      contextGraphId: cg, name: 'gh1097-ka',
      quads: [{ subject: `${ENTITY}/1097`, predicate: 'https://schema.org/name', object: '"OneShot"' }],
    });
    // The documented one-shot flow must actually WORK end to end — not merely
    // avoid a 500. Assert the create SUCCEEDS, then the publish-by-assertionName
    // SUCCEEDS (today this 500s → "documented flow returns 500"). Any other
    // non-500 failure (404/409/422) would have falsely satisfied a `!== 500`.
    expect([200, 201], `create failed: ${create.status} ${JSON.stringify(create.body)}`).toContain(create.status);
    const pub = await post(node, '/api/shared-memory/publish', { contextGraphId: cg, assertionName: 'gh1097-ka' });
    expect(pub.status, `publish failed: ${pub.status} ${JSON.stringify(pub.body)}`).toBe(200);
    expect(['confirmed', 'finalized', 'vm-confirmed', 'tentative']).toContain(pub.body?.status);
  });

  // ── publish-dependent repros (require the beforeAll publish to have landed) ──
  it('GH #1095: lifecycle descriptor reflects the published transition (no contradictory state)', async () => {
    expect(publishOk, 'beforeAll publish must have landed on a working core').toBe(true);
    const r = await get(pubNode!, `/api/knowledge-assets/${KA}?contextGraphId=${SEED_CG}`);
    // #1095 was: the descriptor reported a CONTRADICTORY state (state=discarded +
    // status=vm-confirmed) and gave no coherent positive signal that the KA had
    // been published. The fix makes the descriptor record the publish coherently.
    // Verified live on a 6-node devnet after a confirmed VM publish, the
    // descriptor reads: state=published, status=vm-confirmed, memoryLayer=VM,
    // publishedUal present — with NO discarded/vm-confirmed contradiction.
    //
    // NOTE (why state, not events[]): the publish transition is recorded as the
    // descriptor STATE. The per-event provenance log keeps `created`/`promoted`
    // rows and does NOT add a separate `published` event row, so the faithful
    // post-fix contract is the published *state* + publishedUal, not an
    // events[] entry. (Asserting events.includes('published') was a false
    // negative against the real implementation — re-verified live, PR #1129.)
    expect(r.body?.state, `descriptor: ${JSON.stringify(r.body)}`).toBe('published');
    expect(r.body?.status).toBe('vm-confirmed');
    expect(r.body?.publishedUal ?? r.body?.ual).toBeTruthy();
  });

  it('GH #1104: descriptor surfaces the published UAL (not only reservedUal)', async () => {
    expect(publishOk).toBe(true);
    const r = await get(pubNode!, `/api/knowledge-assets/${KA}?contextGraphId=${SEED_CG}`);
    expect(r.body?.publishedUal ?? r.body?.ual).toBeTruthy();
  });

  it('GH #1094: wm/pull-from {layer:vm} seeds an editable WM draft', async () => {
    expect(publishOk).toBe(true);
    const r = await post(pubNode!, `/api/knowledge-assets/${KA}/wm/pull-from`, {
      contextGraphId: SEED_CG, layer: 'vm', onConflict: 'replace',
    });
    // The documented edit path must SUCCEED (today it 500s). `!== 500` alone
    // would let a 404/409/422 look fixed, so require 200 + no error body.
    expect(r.status, `wm/pull-from failed: ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body?.error).toBeUndefined();
    // Read back: the KA is now resolvable as an editable WM draft.
    const desc = await get(pubNode!, `/api/knowledge-assets/${KA}?contextGraphId=${SEED_CG}`);
    expect(desc.status).toBe(200);
    expect(desc.body?.memoryLayer === 'WM' || desc.body?.wmCurrentAssertion || desc.body?.state === 'created').toBeTruthy();
  });

  it('GH #1096: /api/memory/search finds the published VM entity', async () => {
    expect(publishOk).toBe(true);
    const r = await post(pubNode!, '/api/memory/search', { query: 'HighEntity', contextGraphId: SEED_CG });
    expect(r.body?.resultCount ?? r.body?.count ?? 0).toBeGreaterThan(0);
  });

  it('GH #1098: a core subscribed BEFORE publish materializes the KA in VM', async () => {
    expect(publishOk).toBe(true);
    // Poll (generous deadline) rather than a fixed sleep, so a slow devnet does
    // not flip this into a latency test — it only fails if the KA NEVER lands.
    const found = await pollUntil(async () => {
      const r = await post(preSubNode, '/api/query', {
        sparql: `SELECT ?o WHERE { ?s <https://schema.org/name> ?o }`, contextGraphId: SEED_CG, view: 'verifiable-memory',
      });
      const names = (r.body?.result?.bindings ?? []).map((b: any) => b.o);
      return names.some((n: string) => String(n).includes('HighEntity'));
    }, 60_000);
    expect(found, 'pre-subscribed peer never materialized the published KA in VM').toBe(true);
  });

  // GH #1099 — after a publish clears the publisher's SWM, a replica that
  // catches up afterwards RESURRECTS the stale SWM content from gossip history.
  // Timing/gossip-history sensitive: reproduced on the slower testnet (morning
  // QA sweep — a late subscriber re-served the pre-clear triples), but a fast
  // 6-node local devnet drops the gossip history before the late subscribe, so
  // the replica sees the cleared state and the bug can't manifest. Needs a
  // controlled gossip-retention / staggered-catch-up fixture to repro
  // deterministically.
  it.skip('GH #1099: SWM clear-after-publish propagates to late replicas (needs gossip-retention fixture)');

  it('GH #886: a node subscribing AFTER publish receives the historical VM KA', async () => {
    expect(publishOk).toBe(true);
    const late = readNode(6);
    await post(late, '/api/context-graph/subscribe', { contextGraphId: SEED_CG });
    // Poll instead of a fixed sleep — catch-up of historical VM can legitimately
    // take longer on a slow devnet; only fail if it NEVER arrives.
    const found = await pollUntil(async () => {
      const r = await post(late, '/api/query', {
        sparql: `SELECT ?o WHERE { ?s <https://schema.org/name> ?o }`, contextGraphId: SEED_CG, view: 'verifiable-memory',
      });
      const names = (r.body?.result?.bindings ?? []).map((b: any) => b.o);
      return names.some((n: string) => String(n).includes('HighEntity'));
    }, 90_000);
    expect(found, 'late subscriber never received the historical VM KA').toBe(true);
  });

  // ── documented stubs (need a dedicated harness) ─────────────────────────
  // GH #1013 — async publishAsync reports `finalized` with a provisional `t…`
  // UAL and no on-chain provenance. Needs a node booted with the async
  // publisher runtime (DEVNET_ENABLE_PUBLISHER=1 + a publisher wallet) and an
  // EPCIS/async capture; assert a `finalized` capture carries a real txHash +
  // canonical UAL, not a `t<operationId>` provisional one.
  //
  // CI variant: packages/publisher/test/issue-1013-async-finalization-honesty.test.ts
  // pins the honesty invariant at the result-mapper layer (runs in CI).
  it.skip('GH #1013: async finalized publish carries real on-chain provenance (devnet variant; CI variant in publisher)');

  // GH #936 — chain-driven VM reconcile assigns per-root tokenIds in
  // store-dependent order, so two replicas can map the same UAL to different
  // content.
  //
  // CI variant: packages/agent/test/issue-936-tokenid-determinism.test.ts drives
  // two FinalizationHandler reconciles with divergent oxigraph insertion orders
  // and asserts they agree on the rootEntity→tokenId mapping (runs in CI).
  it.skip('GH #936: replicas agree on per-root tokenId→content mapping (devnet variant; CI variant in agent)');

  // GH #462 — skill_request has NO authorization on PROTOCOL_MESSAGE.
  // CI variant: packages/agent/test/issue-462-skill-acl.test.ts (runs in CI).

  // GH #1078 — private hydration is not scoped to the committing memory layer.
  // CI variant: packages/storage/test/issue-1078-private-layer-scope.test.ts.

  // GH #999 / #1008 — on a data-rich node the single oxigraph-worker thread
  // saturates under normal gossip+sync load and store-touching routes
  // (create/list/query) hang for minutes while /api/status stays instant.
  // Reproduced live on the testnet (1032 `oxigraph-worker: "query" timed out`
  // lines; worker at 100% CPU) — see those issues. Load-dependent, not
  // deterministically reproducible on a small idle devnet; needs a saturation
  // harness (large store + concurrent sync/gossip + a wall-clock latency budget).
  it.skip('GH #999/#1008: store routes stay responsive under gossip+sync load (needs saturation harness)');

  // GH #723 — on the live testnet only ~1 of 6 cores submits valid RS proofs
  // (4.8% challenge→proof rate over 6h). An emergent network-economics metric
  // observed across many cores/epochs on the real testnet (rs-scan), not a
  // single-node assertion; not reproducible on a short local devnet run.
  it.skip('GH #723: network-wide RS challenge→valid-proof rate is healthy (emergent testnet metric)');

  // GH #1091 — grindable RS challenge seed. CI variant:
  // packages/random-sampling/test/e2e-hardhat-chain.test.ts reconstructs the
  // seed from public block data and predicts the on-chain draw (runs in CI).
});
