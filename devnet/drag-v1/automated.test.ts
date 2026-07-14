import { describe, it, beforeAll, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Import from the built dist directly — the standalone devnet vitest config does
// not resolve workspace package names.
import { verifyCitationProof, type VerifiableCitation } from '../../packages/core/dist/index.js';

// dRAG V1 release-gate integration suite (OT-RFC-55). Requires a live 4-node
// devnet: `./scripts/devnet.sh start 4`.

const DEVNET_DIR = process.env.DEVNET_DIR ?? resolve(import.meta.dirname, '../../.devnet');
const API_PORT_BASE = Number(process.env.API_PORT_BASE ?? 9201);
const TOKEN = readFileSync(resolve(DEVNET_DIR, 'node1/auth.token'), 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'))[0]
  .trim();
const N = (i: number) => `http://127.0.0.1:${API_PORT_BASE + i - 1}`;
const CG = `drag-it-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, any>;
async function post(api: string, path: string, body: Json): Promise<{ status: number; b: Json }> {
  const r = await fetch(api + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  let b: Json;
  try {
    b = await r.json();
  } catch {
    b = {};
  }
  return { status: r.status, b };
}
async function get(api: string, path: string): Promise<Json> {
  return (await fetch(api + path, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
}
async function waitId(api: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await get(api, '/api/identity')).hasIdentity) return;
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
}
async function peerId(api: string): Promise<string> {
  return (await get(api, '/api/status')).peerId;
}
async function publish(api: string, name: string, triples: Array<[string, string, string]>): Promise<boolean> {
  for (let t = 0; t < 5; t++) {
    let ok = true;
    const steps: Array<[string, Json]> = [
      ['/api/knowledge-assets', { name }],
      [`/api/knowledge-assets/${name}/wm/write`, { quads: triples.map(([s, p, o]) => ({ subject: s, predicate: p, object: o, graph: '' })) }],
      [`/api/knowledge-assets/${name}/wm/finalize`, {}],
      [`/api/knowledge-assets/${name}/swm/share`, {}],
      [`/api/knowledge-assets/${name}/vm/publish`, {}],
    ];
    for (const [path, extra] of steps) {
      if (![200, 201].includes((await post(api, path, { contextGraphId: CG, ...extra })).status)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
    await sleep(5000);
  }
  return false;
}
async function answer(api: string, body: Json): Promise<Json> {
  return (await post(api, '/api/answer', { contextGraphId: CG, scope: 'local', ...body })).b;
}
const entitiesOf = (a: Json): string[] => [...new Set((a.facts ?? []).map((f: Json) => String(f.subject).split(':').pop()))];

let n1Peer = '';
let n2Peer = '';
let localModelAvailable = false;
// Release-gate strictness: with DKG_DRAG_REQUIRE_SEMANTIC=1 the semantic cases
// FAIL (instead of skip) when no embedding model is reachable — a validation
// environment must not report green while the semantic path went unexercised.
// Default (unset) keeps skip-with-report for ad-hoc runs without the optional
// local model / OpenAI-compatible credentials.
const requireSemantic = process.env.DKG_DRAG_REQUIRE_SEMANTIC === '1';
function semanticGate(ctx: { skip: () => void }): void {
  if (localModelAvailable) return;
  expect(requireSemantic, 'DKG_DRAG_REQUIRE_SEMANTIC=1 but no embedding model is reachable — provision one for the release gate').toBe(false);
  ctx.skip(); // reports SKIPPED, not a silent pass
}

beforeAll(async () => {
  await Promise.all([waitId(N(1)), waitId(N(2)), waitId(N(3))]);
  [n1Peer, n2Peer] = [await peerId(N(1)), await peerId(N(2))];

  await post(N(1), '/api/context-graph/create', { id: CG, name: 'dRAG integration', accessPolicy: 0, publishPolicy: 0, register: true });
  // northwind: keyword-friendly ("flagged" / "audit" appear). initech: a
  // paraphrase only semantic retrieval can reach. globex: a distractor.
  expect(await publish(N(1), 'northwind', [
    ['urn:supplier:northwind', 'http://schema.org/name', '"Northwind Components"'],
    ['urn:supplier:northwind', 'http://schema.org/auditStatus', '"flagged"'],
    ['urn:supplier:northwind', 'http://schema.org/auditNote', '"flagged in the 2026 Q1 audit for late delivery"'],
  ]), 'publish northwind').toBe(true);
  expect(await publish(N(1), 'initech', [
    ['urn:supplier:initech', 'http://schema.org/name', '"Initech Components"'],
    ['urn:supplier:initech', 'http://ex/note', '"did not meet incoming-inspection thresholds; multiple lots returned"'],
  ]), 'publish initech').toBe(true);
  await publish(N(1), 'globex', [
    ['urn:supplier:globex', 'http://schema.org/name', '"Globex Logistics"'],
    ['urn:supplier:globex', 'http://ex/note', '"consistently on-time delivery; preferred partner"'],
  ]);

  // node2 subscribes so it serves the CG for the cross-node test. The fan-out
  // test below REQUIRES both peers to answer, so readiness is asserted, not
  // best-effort: a node2 that never synced would otherwise let a single-peer
  // dial masquerade as proven multi-peer aggregation.
  await post(N(2), '/api/context-graph/subscribe', { contextGraphId: CG, includeSharedMemory: true });
  let node2Facts = 0;
  for (let i = 0; i < 12; i++) {
    node2Facts = (await answer(N(2), { question: 'flagged audit' })).stats?.factsCited ?? 0;
    if (node2Facts > 0) break;
    await sleep(4000);
  }
  expect(node2Facts, 'node2 must hold synced CG facts before the fan-out test').toBeGreaterThan(0);

  // Detect whether a semantic embedder is reachable on this node (the optional
  // local model, or a configured OpenAI-compatible one).
  const probe = await answer(N(1), { question: 'which suppliers were flagged in the audit?', retrieval: 'semantic' });
  localModelAvailable = String(probe.stats?.retrieval ?? '').startsWith('vector:') && (probe.stats?.factsCited ?? 0) > 0;
}, 300_000);

describe('dRAG P2 — single-node grounded, verifiable answer', () => {
  it('returns cited facts, every citation verified', async () => {
    const a = await answer(N(1), { question: 'which suppliers were flagged in the audit?' });
    expect(a.citations.length).toBeGreaterThan(0);
    expect(a.citations.every((c: VerifiableCitation) => c.checks.verified)).toBe(true);
    expect(entitiesOf(a)).toContain('northwind');
  });
});

describe('dRAG P1 — citations are independently verifiable + tamper-evident', () => {
  it('verifyCitationProof accepts a real citation and rejects a tampered one', async () => {
    const a = await answer(N(1), { question: 'which suppliers were flagged in the audit?' });
    const c: VerifiableCitation = a.citations[0];
    expect(verifyCitationProof(c)).toBe(true);
    const tampered: VerifiableCitation = { ...c, triple: { ...c.triple, object: '"PASSED — compliant"' } };
    expect(verifyCitationProof(tampered)).toBe(false);
  });
});

describe('dRAG P3 — cross-node fan-out, re-verified by an asker that holds nothing', () => {
  it('node3 (no local copy) assembles a verified answer from remote serving nodes', async () => {
    const n3local = await answer(N(3), { question: 'which suppliers were flagged in the audit?' });
    expect(n3local.stats.factsCited, 'node3 holds no local copy of the CG').toBe(0);

    const net = (await post(N(3), '/api/answer', {
      contextGraphId: CG,
      scope: 'network',
      peers: [n1Peer, n2Peer],
      question: 'which suppliers were flagged in the audit?',
    })).b;
    expect(net.citations.length).toBeGreaterThan(0);
    expect(net.citations.every((c: VerifiableCitation) => c.checks.verified)).toBe(true);
    // BOTH explicit serving peers must answer with asker-verified citations —
    // a single responder would not prove multi-peer fan-out or aggregation.
    const verifiedPeers = (net.perNode ?? [])
      .filter((p: Json) => !p.error && p.verified > 0)
      .map((p: Json) => p.peerId);
    expect(verifiedPeers).toContain(n1Peer);
    expect(verifiedPeers).toContain(n2Peer);
  });
});

describe('dRAG P4 — payment seam (OFF by default)', () => {
  // The devnet sets neither payments.enabled nor experimentalOverrides, so
  // ordinary requests are free while the test-only `simulatePrice` knob is
  // rejected instead of being silently ignored. The 402 → pay → 200 + receipt
  // flow itself is exercised by the unit suite
  // (packages/cli/test/drag-payment.test.ts).
  it('answers an ordinary request for free with no settlement', async () => {
    const r = await post(N(1), '/api/answer', {
      contextGraphId: CG,
      question: 'which suppliers were flagged in the audit?',
    });
    expect(r.status).toBe(200);
    expect(r.b.settlement).toBeUndefined();
    expect((r.b.citations ?? []).length).toBeGreaterThan(0);
  });

  it('rejects the experimental price override when payments are off', async () => {
    const r = await post(N(1), '/api/answer', {
      contextGraphId: CG,
      question: 'which suppliers were flagged in the audit?',
      simulatePrice: '0.01 USDC',
    });
    expect(r.status).toBe(400);
    expect(r.b).toEqual({
      error: '"simulatePrice" requires experimental overrides and dRAG payments to be enabled',
    });
  });
});

describe('dRAG Phase 1 — semantic retrieval finds what keyword misses', () => {
  it('keyword finds the literal "flagged" supplier but MISSES the paraphrase one', async () => {
    const kw = await answer(N(1), { question: 'which suppliers were flagged in the audit?', retrieval: 'keyword' });
    const ents = entitiesOf(kw);
    expect(ents).toContain('northwind'); // literal "flagged" → found
    expect(ents).not.toContain('initech'); // paraphrase → missed by substring scan
  });

  it('the semantic path retrieves entities by embedding ANN, not a substring scan', async (ctx) => {
    semanticGate(ctx);
    const sem = await answer(N(1), { question: 'which suppliers were flagged in the audit?', retrieval: 'semantic' });
    expect(String(sem.stats.retrieval)).toContain('vector:');
    expect(sem.stats.factsCited).toBeGreaterThan(0);
  });

  it('semantic reaches the paraphrase supplier keyword cannot [requires an embedding model]', async (ctx) => {
    semanticGate(ctx);
    const sem = await answer(N(1), { question: 'which suppliers were flagged in the audit?', retrieval: 'semantic' });
    expect(entitiesOf(sem)).toContain('initech');
  });
});
