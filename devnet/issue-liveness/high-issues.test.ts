/**
 * Issue-liveness repros for HIGH / pre-mainnet issues that are only observable
 * across a live multi-node devnet (publish → quorum → replication).
 *
 * Each is an `it.fails` repro: asserts the CORRECT behaviour, fails today (bug
 * live on `main`), flips RED when fixed → drop `.fails` and close the issue.
 * Nine of these are also fixed on PR #1107 (`fix-in-flight`): when #1107 merges
 * they should start passing, which is the cue to unwrap them.
 *
 * Preconditions:
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *   Run: pnpm test:devnet:issue-liveness
 *
 * Covered: #1093 #1094 #1095 #1096 #1097 #1098 #1099 #1104 #886 #1124
 * Documented stubs (need a dedicated harness): #1013 #936
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as http from 'node:http';

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
let preSubNode: Node; // subscribed BEFORE publish (#1098)
const PRIV_CG = `high-priv-${STAMP}`;
const PUB_CG = `high-pub-${STAMP}`;
const KA = `high-ka-${STAMP}`;
const ENTITY = `https://example.org/high/${STAMP}`;
let publishOk = false;
let publishedUal = '';

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
    // Find a core that can publish (some are poisoned by #1093) and seed a
    // private CG + a peer subscribed before publish.
    preSubNode = readNode(2);
    for (const n of CORES) {
      const node = readNode(n);
      const cg = `${PRIV_CG}-probe${n}`;
      await post(node, '/api/context-graph/create', { id: PRIV_CG, name: 'High Priv', accessPolicy: 1 }).catch(() => {});
      await post(node, '/api/context-graph/register', { id: PRIV_CG }).catch(() => {});
      void cg;
      // pre-subscribe node2 so #1098 can observe a missed KA
      await post(preSubNode, '/api/context-graph/subscribe', { contextGraphId: PRIV_CG }).catch(() => {});
      await sleep(3000);
      const res = await publishKaOn(node, PRIV_CG, KA);
      if (res.ok) { pubNode = node; publishOk = true; publishedUal = res.body?.ual ?? ''; break; }
    }
  }, 240_000);

  // ── #1093 — ACK pool poisoning: not every core can publish ──────────────
  it.fails('GH #1093: every core node can publish to VM (no pool_below_quorum)', async () => {
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
  // Topology-specific: reproduces on the testnet where sharded host-mode cores
  // are NOT members of the public CG and drop its plaintext SWM share (so the
  // storage-ACK reads find NO_DATA_IN_SWM). On a 6-node local devnet every core
  // IS a member, so the publish succeeds and the bug can't manifest — verified
  // manually on testnet (daemon logs show `NO_DATA_IN_SWM`). Needs a host-mode
  // sharded fixture (non-member storage cores) to repro deterministically.
  it.skip('GH #1124: public CG publish reaches storage-ACK quorum (needs host-mode sharded cores)');

  // ── #1097 — documented one-shot publish flow returns 500 ────────────────
  it.fails('GH #1097: SKILL.md one-shot publish (create{quads} → publish{assertionName}) works', async () => {
    const node = pubNode ?? readNode(1);
    const cg = `gh1097-${STAMP}`;
    await post(node, '/api/context-graph/create', { id: cg, name: 'gh1097' });
    await post(node, '/api/context-graph/register', { id: cg });
    const create = await post(node, '/api/knowledge-assets', {
      contextGraphId: cg, name: 'gh1097-ka',
      quads: [{ subject: `${ENTITY}/1097`, predicate: 'https://schema.org/name', object: '"OneShot"' }],
    });
    void create;
    const pub = await post(node, '/api/shared-memory/publish', { contextGraphId: cg, assertionName: 'gh1097-ka' });
    expect(pub.status).not.toBe(500);
  });

  // ── publish-dependent repros (require the beforeAll publish to have landed) ──
  it.fails('GH #1095: lifecycle descriptor records a `published` event', async () => {
    expect(publishOk, 'beforeAll publish must have landed on a working core').toBe(true);
    const r = await get(pubNode!, `/api/knowledge-assets/${KA}?contextGraphId=${PRIV_CG}`);
    const events = (r.body?.events ?? []).map((e: any) => e.type);
    expect(events).toContain('published');
  });

  it.fails('GH #1104: descriptor surfaces the published UAL (not only reservedUal)', async () => {
    expect(publishOk).toBe(true);
    const r = await get(pubNode!, `/api/knowledge-assets/${KA}?contextGraphId=${PRIV_CG}`);
    expect(r.body?.publishedUal ?? r.body?.ual).toBeTruthy();
  });

  it.fails('GH #1094: wm/pull-from {layer:vm} seeds an edit draft (does not 500)', async () => {
    expect(publishOk).toBe(true);
    const r = await post(pubNode!, `/api/knowledge-assets/${KA}/wm/pull-from`, {
      contextGraphId: PRIV_CG, layer: 'vm', onConflict: 'replace',
    });
    expect(r.status).not.toBe(500);
  });

  it.fails('GH #1096: /api/memory/search finds the published VM entity', async () => {
    expect(publishOk).toBe(true);
    const r = await post(pubNode!, '/api/memory/search', { query: 'HighEntity', contextGraphId: PRIV_CG });
    expect(r.body?.resultCount ?? r.body?.count ?? 0).toBeGreaterThan(0);
  });

  it.fails('GH #1098: a core subscribed BEFORE publish materializes the KA in VM', async () => {
    expect(publishOk).toBe(true);
    await sleep(8000);
    const r = await post(preSubNode, '/api/query', {
      sparql: `SELECT ?o WHERE { ?s <https://schema.org/name> ?o }`, contextGraphId: PRIV_CG, view: 'verifiable-memory',
    });
    const names = (r.body?.result?.bindings ?? []).map((b: any) => b.o);
    expect(names.some((n: string) => String(n).includes('HighEntity'))).toBe(true);
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

  it.fails('GH #886: a node subscribing AFTER publish receives the historical VM KA', async () => {
    expect(publishOk).toBe(true);
    const late = readNode(6);
    await post(late, '/api/context-graph/subscribe', { contextGraphId: PRIV_CG });
    await sleep(12000);
    const r = await post(late, '/api/query', {
      sparql: `SELECT ?o WHERE { ?s <https://schema.org/name> ?o }`, contextGraphId: PRIV_CG, view: 'verifiable-memory',
    });
    const names = (r.body?.result?.bindings ?? []).map((b: any) => b.o);
    expect(names.some((n: string) => String(n).includes('HighEntity'))).toBe(true);
  });

  // ── documented stubs (need a dedicated harness) ─────────────────────────
  // GH #1013 — async publishAsync reports `finalized` with a provisional `t…`
  // UAL and no on-chain provenance. Needs a node booted with the async
  // publisher runtime (DEVNET_ENABLE_PUBLISHER=1 + a publisher wallet) and an
  // EPCIS/async capture; assert a `finalized` capture carries a real txHash +
  // canonical UAL, not a `t<operationId>` provisional one.
  it.skip('GH #1013: async finalized publish carries real on-chain provenance (needs publisher runtime)');

  // GH #936 — chain-driven VM reconcile assigns per-root tokenIds in
  // store-dependent order, so two replicas can map the same UAL to different
  // content. Needs a multi-root KA published once, then TWO replicas
  // independently reconciling it from chain; assert both map each rootEntity to
  // the SAME tokenId (requires a persisted per-root index, e.g. dkg:kaIndex).
  it.skip('GH #936: replicas agree on per-root tokenId→content mapping (needs 2-replica reconcile harness)');

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

  // GH #462 — PROTOCOL_MESSAGE skill_request has NO authorization: messaging.ts
  // dispatches `handler(request, fromPeerId)` with only an Ed25519 signature
  // check, no delegation/ACL. chat has an opt-in `chatAclCheck` but defaults to
  // allow-all when unset. Needs a MessageHandler harness (two agents + a
  // registered skill, no delegation) to assert an unauthorized peer is rejected.
  it.skip('GH #462: skill_request from an unauthorized peer is rejected (needs MessageHandler ACL harness)');

  // GH #1078 — private payload hydration is scoped to the CG-level `_private`
  // graph, not to the memory layer / verifiable commitment, so a verifiable KA's
  // private anchor can hydrate triples a different layer/version committed.
  // Needs a PrivateContentStore test storing distinct private payloads under the
  // same root across WM/SWM/VM authorities and asserting a VM-anchored read
  // returns only the VM-committed slice.
  it.skip('GH #1078: private hydration is scoped to the committing memory layer (needs layer-scoped private-store API)');
});
