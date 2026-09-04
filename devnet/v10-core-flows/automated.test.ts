/**
 * V10 core-flows — release-gate validation against a live devnet.
 *
 * Run **before any bigger update** that touches the assertion route, staking
 * contracts, publisher chain-submit path, or operator-fee mechanism. The
 * suite covers every first-class V10 capability with one canonical scenario
 * each (vs. `v10-stress-devnet`'s scale-and-race fuzzing, vs.
 * `v10-end-to-end-devnet`'s basic happy path):
 *
 *   1. Chained sign-at-creation assertion lifecycle — POST 4 standalone
 *      routes (create → write → finalize → promote) and assert each fires
 *      `memory_graph_changed` SSE in order. Pins the route-level emit
 *      contract that the staking-ui and any external lifecycle composer
 *      depend on. (Caught a real bug during devnet validation: standalone
 *      `/finalize` was missing the emit. See FINDINGS.md.)
 *
 *   2. Publish/VM honesty (RC11 / PR2) — runs create+write+finalize
 *      +promote+publish from an edge daemon (no on-chain identity). Post-RFC-38
 *      that edge publish has TWO legitimate outcomes: it may CONFIRM when peer
 *      cores supply storage ACKs (attributionId=0 is valid on chain), or it may
 *      NOT confirm. The honesty rule this test pins: a publish's triples appear
 *      in `/api/query?view=verifiable-memory` IFF it confirmed on-chain — a
 *      confirmed publish carries a positive kaId (asserted) and may legitimately
 *      show in VM, while a non-confirmed publish MUST NOT leak any rows into VM,
 *      and the caller must never see the silent `tentative` downgrade. Pre-RC11 a
 *      non-confirmed publish silently wrote its quads into the root data graph
 *      and the VM view aliased that graph into VM, so an external app would
 *      observe "verified" data that the chain had never anchored. PR2 deletes
 *      `generateTentativeMetadata` from the on-chain catch and limits VM to
 *      `_verifiable_memory/*` graphs; this test pins all three halves.
 *
 *   3. NFT staking withdraw — `DKGStakingConvictionNFT.withdraw(tokenId)`
 *      on an unlocked tier-0 position. Verifies: TRAC delta to staker EOA
 *      == raw stake at the time of withdraw, NFT burned (`ownerOf`
 *      reverts), position cleared (raw=0, identityId=0),
 *      `PositionWithdrawn` event amount matches. Also asserts a still-
 *      locked tier-3 position correctly reverts.
 *
 *   4. Operator-fee accrual + withdrawal — sets a 10% operator fee on
 *      identityId=1, generates 5 fresh publishes to seed the epoch pool,
 *      waits for RS scoring, warps an epoch, has a delegator claim. Asserts
 *      the accrual matches RFC-26 prediction (`gross × feeBps / 10_000`)
 *      to <1% drift, then exercises the full request → cooldown → finalize
 *      cycle and verifies TRAC actually transfers to the operator's admin
 *      EOA.
 *
 * Preconditions:
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   node devnet/_bootstrap/bootstrap.cjs   # 10 delegators + initial publishes
 *
 * Run:
 *   pnpm test:devnet:v10-core-flows
 *
 * Runtime: ~5-8 minutes (the operator-fee test does an epoch warp + RS
 * scoring wait). Findings are appended to `FINDINGS.local.md` (gitignored)
 * as they surface.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as http from 'node:http';
import { ethers } from 'ethers';

// ───────────────────────────── constants ─────────────────────────────────
const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const HUB = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
const CONTEXT_GRAPH = 'devnet-test';
const FINDINGS_PATH = join(__dirname, 'FINDINGS.local.md');

// Derive node API URLs from each node's devnet config instead of hardcoding
// the default ports, so the suite honors an API_PORT_BASE-rebased devnet
// (needed when another local service occupies the 9201.. range).
function nodeApiUrl(num: number): string {
  const configPath = join(DEVNET_DIR, `node${num}`, 'config.json');
  const apiPort = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')).apiPort ?? 9200 + num)
    : 9200 + num;
  return `http://127.0.0.1:${apiPort}`;
}
const NODE1_API = nodeApiUrl(1);
const NODE5_API = nodeApiUrl(5); // edge

const HUB_ABI = [
  'function getContractAddress(string) view returns (address)',
  'function getAssetStorageAddress(string) view returns (address)',
];
const NFT_ABI = [
  'function createConviction(uint72 identityId, uint96 stakeAmount, uint40 lockTier) returns (uint256 tokenId)',
  'function withdraw(uint256 tokenId) returns (uint96 amount)',
  'function claim(uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'event PositionWithdrawn(uint256 indexed tokenId, uint96 amount)',
  'event RewardsClaimed(uint256 indexed tokenId, uint96 amount)',
];
const CSS_ABI = [
  'function getPosition(uint256 tokenId) view returns (tuple(uint96 raw, uint40 lockTier, uint40 expiryTimestamp, uint72 identityId, uint96 cumulativeRewardsClaimed, uint64 multiplier18, uint32 lastClaimedEpoch, uint32 migrationEpoch))',
  'function getOperatorFeeBalance(uint72 identityId) view returns (uint96)',
  'function getOperatorFeeWithdrawalRequest(uint72 identityId) view returns (uint96 amount, uint256 indexed_, uint256 releaseTimestamp)',
];
const STAKING_ABI = [
  'function requestOperatorFeeWithdrawal(uint72 identityId, uint96 withdrawalAmount)',
  'function finalizeOperatorFeeWithdrawal(uint72 identityId)',
];
const PROFILE_WRITE_ABI = ['function updateOperatorFee(uint72 identityId, uint16 newOperatorFee)'];
const PROFILE_STORAGE_ABI = [
  'function getOperatorFee(uint72) view returns (uint16)',
  'function getOperatorFeesLength(uint72) view returns (uint256)',
  'function getOperatorFeeEffectiveDateByIndex(uint72,uint256) view returns (uint256)',
];
const PARAMS_ABI = ['function stakeWithdrawalDelay() view returns (uint256)'];
const CHRONOS_ABI = [
  'function getCurrentEpoch() view returns (uint256)',
  'function timeUntilNextEpoch() view returns (uint256)',
  'function epochLength() view returns (uint256)',
];
const RS_ABI = [
  'function getNodeEpochScore(uint256, uint72) view returns (uint256)',
  'function getAllNodesEpochScore(uint256) view returns (uint256)',
];
const ES_ABI = ['function getEpochPool(uint256, uint256) view returns (uint96)'];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
];

// ───────────────────────────── fixtures ──────────────────────────────────
interface Delegator {
  index: number;
  privateKey: string;
  address: string;
  identityId: number;
  tier: number;
  stakeAmountTRAC: number;
  tokenId: number;
}

interface SuiteState {
  provider: ethers.JsonRpcProvider;
  hub: ethers.Contract;
  nft: ethers.Contract;
  css: ethers.Contract;
  staking: ethers.Contract;
  profileStorage: ethers.Contract;
  profileWrite: ethers.Contract;
  params: ethers.Contract;
  chronos: ethers.Contract;
  rs: ethers.Contract;
  es: ethers.Contract;
  token: ethers.Contract;
  delegators: Delegator[];
  node1Token: string;
  node5Token: string;
  adminWallet: ethers.Wallet;
  findings: string[];
}

let state: SuiteState;

// ───────────────────────────── helpers ───────────────────────────────────
function readDevnetToken(node: number): string {
  const raw = readFileSync(join(DEVNET_DIR, `node${node}`, 'auth.token'), 'utf8');
  const line = raw.split('\n').find((l) => l && !l.startsWith('#'));
  if (!line) throw new Error(`could not parse auth token for node${node}`);
  return line.trim();
}

function loadDelegators(): Delegator[] {
  const path = join(REPO_ROOT, 'devnet/_bootstrap/delegators.json');
  if (!existsSync(path)) {
    throw new Error(
      `delegators.json missing at ${path}. Run \`node devnet/_bootstrap/bootstrap.cjs\` first.`,
    );
  }
  const j = JSON.parse(readFileSync(path, 'utf8')) as { delegators: Delegator[] };
  return j.delegators;
}

function loadAdmin(): ethers.Wallet {
  const w = JSON.parse(
    readFileSync(join(DEVNET_DIR, 'node1/wallets.json'), 'utf8'),
  ) as { adminWallet: { privateKey: string } };
  return new ethers.Wallet(w.adminWallet.privateKey);
}

function recordFinding(msg: string) {
  state.findings.push(`[${new Date().toISOString()}] ${msg}`);
}

function postJson(api: string, path: string, body: unknown, token: string): Promise<{ status: number; body: any }> {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(api + path);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method: 'POST',
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolveP({ status: res.statusCode ?? 0, body: JSON.parse(buf) }); }
        catch { resolveP({ status: res.statusCode ?? 0, body: buf }); }
      });
    });
    req.on('error', rejectP);
    req.write(data);
    req.end();
  });
}

/**
 * Parse SPARQL SELECT bindings out of a daemon /api/query response, accepting the
 * known wrapper shapes and THROWING on an unrecognised 200 — so a future wrapper
 * regression can never masquerade as "zero rows". Callers must only pass a 200
 * body; a non-200 (still warming up) has no bindings to read. (otReviewAgent #1258.)
 */
function queryBindings(body: any): Array<Record<string, unknown>> {
  const b =
    body?.result?.bindings ??   // current daemon shape: { result: { bindings } }
    body?.results?.bindings ??  // SPARQL 1.1 JSON results shape
    body?.bindings;             // legacy flat shape
  if (!Array.isArray(b)) {
    throw new Error(
      `unrecognised /api/query response shape (no result.bindings / results.bindings / bindings array): ${
        typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)
      }`,
    );
  }
  return b as Array<Record<string, unknown>>;
}

function openSseAndCollect(
  api: string,
  token: string,
  shouldKeep: (event: string, data: any) => boolean,
): { events: Array<{ event: string; data: any; receivedAt: string }>; close: () => void } {
  const events: Array<{ event: string; data: any; receivedAt: string }> = [];
  const u = new URL(api + '/api/events');
  const req = http.get({
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/event-stream',
    },
  }, (res) => {
    if (res.statusCode !== 200) return;
    let buf = '';
    let curEvent: string | null = null;
    res.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event: ')) curEvent = line.slice(7);
        else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (curEvent && shouldKeep(curEvent, data)) {
              events.push({ event: curEvent, data, receivedAt: new Date().toISOString() });
            }
          } catch { /* heartbeat or non-JSON */ }
        } else if (line === '') curEvent = null;
      }
    });
  });
  return { events, close: () => req.destroy() };
}

async function fullPublish(api: string, token: string, name: string): Promise<{ kaId: string; status: string; merkleRoot: string }> {
  const cgId = CONTEXT_GRAPH;
  const subject = `urn:test:core-flows:${name}`;
  const quads = [
    { subject, predicate: 'http://schema.org/name', object: `"${name}"`, graph: '' },
    { subject, predicate: 'http://schema.org/value', object: '"epoch-pool fuel"', graph: '' },
  ];
  let r = await postJson(api, '/api/knowledge-assets', { contextGraphId: cgId, name }, token);
  // KA create returns 201 (resource created) vs the legacy route's 200.
  expect(r.status, `create failed: ${JSON.stringify(r.body)}`).toBe(201);
  r = await postJson(api, `/api/knowledge-assets/${name}/wm/write`, { contextGraphId: cgId, quads }, token);
  expect(r.status, `write failed: ${JSON.stringify(r.body)}`).toBe(200);
  r = await postJson(api, `/api/knowledge-assets/${name}/wm/finalize`, { contextGraphId: cgId }, token);
  expect(r.status, `finalize failed: ${JSON.stringify(r.body)}`).toBe(200);
  r = await postJson(api, `/api/knowledge-assets/${name}/swm/share`, { contextGraphId: cgId }, token);
  expect(r.status, `promote failed: ${JSON.stringify(r.body)}`).toBe(200);
  r = await postJson(api, `/api/knowledge-assets/${name}/vm/publish`, { contextGraphId: cgId }, token);
  expect(r.status, `publish failed: ${JSON.stringify(r.body)}`).toBe(200);
  // Greedy publish-outcome gate: HTTP 200 is NOT proof the publish landed.
  // Pin the status to a known success value and require a positive on-chain
  // kaId, so a tentative/failed status or a missing/zero id ("0"/undefined)
  // fails right here instead of silently fuelling the downstream epoch-pool /
  // operator-fee assertions with a publish that never actually happened.
  const publishOk = ['confirmed', 'finalized', 'tentative'];
  const pub = r.body as { kaId?: string; status?: string };
  expect(
    publishOk,
    `publish status="${pub.status}": ${JSON.stringify(r.body)}`,
  ).toContain(String(pub.status).toLowerCase());
  expect(
    BigInt(pub.kaId ?? '0'),
    `publish kaId="${pub.kaId}": ${JSON.stringify(r.body)}`,
  ).toBeGreaterThan(0n);
  return r.body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── beforeAll ─────────────────────────────────
beforeAll(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const hub = new ethers.Contract(HUB, HUB_ABI, provider);

  const [nftAddr, cssAddr, stakingAddr, profileWriteAddr, profileStorageAddr, paramsAddr, chronosAddr, rsAddr, esAddr, tokenAddr] =
    await Promise.all([
      hub.getContractAddress('DKGStakingConvictionNFT'),
      hub.getContractAddress('ConvictionStakingStorage'),
      hub.getContractAddress('StakingV10'),
      hub.getContractAddress('Profile'),
      hub.getContractAddress('ProfileStorage'),
      hub.getContractAddress('ParametersStorage'),
      hub.getContractAddress('Chronos'),
      hub.getContractAddress('RandomSamplingStorage'),
      hub.getContractAddress('EpochStorageV8'),
      hub.getContractAddress('Token'),
    ]);

  state = {
    provider,
    hub,
    nft: new ethers.Contract(nftAddr, NFT_ABI, provider),
    css: new ethers.Contract(cssAddr, CSS_ABI, provider),
    staking: new ethers.Contract(stakingAddr, STAKING_ABI, provider),
    profileStorage: new ethers.Contract(profileStorageAddr, PROFILE_STORAGE_ABI, provider),
    profileWrite: new ethers.Contract(profileWriteAddr, PROFILE_WRITE_ABI, provider),
    params: new ethers.Contract(paramsAddr, PARAMS_ABI, provider),
    chronos: new ethers.Contract(chronosAddr, CHRONOS_ABI, provider),
    rs: new ethers.Contract(rsAddr, RS_ABI, provider),
    es: new ethers.Contract(esAddr, ES_ABI, provider),
    token: new ethers.Contract(tokenAddr, ERC20_ABI, provider),
    delegators: loadDelegators(),
    node1Token: readDevnetToken(1),
    node5Token: readDevnetToken(5),
    adminWallet: loadAdmin().connect(provider),
    findings: [],
  };

  // Sanity: devnet must be reachable
  const epoch = await state.chronos.getCurrentEpoch();
  expect(Number(epoch)).toBeGreaterThan(0);
});

afterAll(() => {
  if (state?.findings?.length) {
    writeFileSync(
      FINDINGS_PATH,
      `# v10-core-flows local findings (${new Date().toISOString()})\n\n` +
        state.findings.map((f) => `- ${f}`).join('\n') + '\n',
    );
  }
});

// ────────────────────── 1. Chained sign-at-creation ──────────────────────
describe('1. chained sign-at-creation assertion lifecycle', () => {
  it('all 4 standalone routes (create/write/finalize/promote) emit memory_graph_changed in order', async () => {
    const assertionName = `core-flows-lifecycle-${Date.now().toString(36)}`;
    // Only the four standalone-route lifecycle operations are under test.
    // A core also emits `verifiable_memory_finalized` whenever it promotes a
    // peer-published KA to VM — including via the periodic chain-reconcile
    // sweep, which can fire mid-test for unrelated bootstrap KAs in this same
    // CG. Those are correct background events but pollute a CG-only filter, so
    // scope capture to the lifecycle ops this test actually asserts.
    const LIFECYCLE_OPS = new Set([
      'assertion_created', 'assertion_written', 'assertion_finalized', 'assertion_promoted',
    ]);
    const sse = openSseAndCollect(
      NODE1_API,
      state.node1Token,
      (event, data) =>
        event === 'memory_graph_changed' &&
        data?.contextGraphId === CONTEXT_GRAPH &&
        LIFECYCLE_OPS.has(data?.operation),
    );
    await sleep(500); // SSE warm-up

    let r = await postJson(NODE1_API, '/api/knowledge-assets', { contextGraphId: CONTEXT_GRAPH, name: assertionName }, state.node1Token);
    // KA create returns 201 (resource created) vs the legacy route's 200.
    expect(r.status, `create: ${JSON.stringify(r.body)}`).toBe(201);
    // The create response identifies the assertion by `name`; `assertionUri` is
    // the canonical WM storage URI (`…/_working_memory/<author>/<number>`),
    // which is author/number-keyed by design and does NOT embed the human name.
    expect(r.body.name).toBe(assertionName);
    expect(r.body.assertionUri, `assertionUri: ${r.body.assertionUri}`).toMatch(/\/_working_memory\//);

    const quads = [
      { subject: 'urn:test:lifecycle:s1', predicate: 'http://schema.org/name', object: '"Sign-at-creation lifecycle test"', graph: '' },
      { subject: 'urn:test:lifecycle:s2', predicate: 'http://schema.org/sameAs', object: 'urn:test:lifecycle:s1', graph: '' },
    ];
    r = await postJson(NODE1_API, `/api/knowledge-assets/${assertionName}/wm/write`, { contextGraphId: CONTEXT_GRAPH, quads }, state.node1Token);
    expect(r.status, `write: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.written).toBe(2);

    r = await postJson(NODE1_API, `/api/knowledge-assets/${assertionName}/wm/finalize`, { contextGraphId: CONTEXT_GRAPH }, state.node1Token);
    expect(r.status, `finalize: ${JSON.stringify(r.body)}`).toBe(200);
    // wm/finalize returns the full seal payload (PR #971): merkleRoot, eip712Digest, schemeVersion, etc.
    expect(r.body.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.body.eip712Digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.body.schemeVersion).toBe(1);

    r = await postJson(NODE1_API, `/api/knowledge-assets/${assertionName}/swm/share`, { contextGraphId: CONTEXT_GRAPH }, state.node1Token);
    expect(r.status, `promote: ${JSON.stringify(r.body)}`).toBe(200);
    // swm/share returns { swmShared, promotedCount }.
    expect(r.body.promotedCount).toBe(2);

    await sleep(1500); // let trailing events arrive
    sse.close();

    const ops = sse.events.map((e) => e.data.operation);
    expect(ops, `expected 4 lifecycle events; got: ${ops.join(', ')}`)
      .toEqual(['assertion_created', 'assertion_written', 'assertion_finalized', 'assertion_promoted']);
    // The /finalize emit was missing pre-fix; this assertion is the regression pin.
    expect(ops).toContain('assertion_finalized');
  }, 60_000);
});

// ──────────────── 2. Publish/VM honesty (RC11 / PR2) ────────────────
describe('2. edge publish appears in verifiable-memory iff it confirmed on-chain (RC11 / PR2)', () => {
  it('a non-confirmed edge publish leaks zero VM rows; a confirmed one carries a positive on-chain kaId', async () => {
    const assertionName = `core-flows-edge-${Date.now().toString(36)}`;
    const subject = `urn:test:edge:rc11:${Date.now().toString(36)}`;
    const witnessLiteral = `"PR2 failed-publish witness ${Date.now().toString(36)}"`;

    let r = await postJson(NODE5_API, '/api/knowledge-assets', { contextGraphId: CONTEXT_GRAPH, name: assertionName }, state.node5Token);
    // KA create returns 201 (resource created) vs the legacy route's 200.
    expect(r.status, `edge create: ${JSON.stringify(r.body)}`).toBe(201);

    // The witness literal is unique per run so the verifiable-memory query
    // below can isolate THIS publish's quads from any bootstrap data
    // sitting in the same context graph.
    const quads = [
      { subject, predicate: 'http://schema.org/name', object: witnessLiteral, graph: '' },
      { subject, predicate: 'http://schema.org/author', object: '"edge-node-5"', graph: '' },
    ];
    r = await postJson(NODE5_API, `/api/knowledge-assets/${assertionName}/wm/write`, { contextGraphId: CONTEXT_GRAPH, quads }, state.node5Token);
    expect(r.status).toBe(200);
    r = await postJson(NODE5_API, `/api/knowledge-assets/${assertionName}/wm/finalize`, { contextGraphId: CONTEXT_GRAPH }, state.node5Token);
    expect(r.status).toBe(200);
    r = await postJson(NODE5_API, `/api/knowledge-assets/${assertionName}/swm/share`, { contextGraphId: CONTEXT_GRAPH }, state.node5Token);
    expect(r.status).toBe(200);

    // Post-RFC-38 an edge node (identityId=0) may still reach `confirmed`
    // when peer cores supply storage ACKs — attributionId=0 is valid on
    // chain. Pre-RC11 / PR2 the regression we guard is VM leakage, not
    // whether the HTTP status is `failed`. Reject only the silent
    // `tentative` downgrade that used to write into graphs the VM aliases.
    r = await postJson(NODE5_API, `/api/knowledge-assets/${assertionName}/vm/publish`, { contextGraphId: CONTEXT_GRAPH }, state.node5Token);
    expect(r.status, `edge publish HTTP: ${JSON.stringify(r.body)}`).toBe(200);
    expect(
      r.body?.status,
      `edge publish returned status='tentative' — pre-PR2 silent downgrade ` +
      `(would re-enable verifiable-memory leak via tentative graph aliasing)`,
    ).not.toBe('tentative');
    const edgePublishStatus = r.body?.status;
    const edgePublishKaId = r.body?.kaId;

    // CORE ASSERTION (RC11 / PR2): a NON-confirmed edge publish's triples MUST
    // NOT appear in the verifiable-memory view on ANY node (the confirmed case
    // is asserted separately below — those rows are the correct on-chain result).
    // Poll node1 (a core) over a few seconds so any in-flight gossip from the
    // edge has time to land in the wrong graph — a leak that materialises 1-2s
    // after the publish call returns would be missed by a single immediate
    // query. The retry exits early once rows are seen (a leak in the
    // non-confirmed case; the expected result in the confirmed case).
    const VM_POLL_ATTEMPTS = 6;
    const VM_POLL_INTERVAL_MS = 500;
    let lastVmStatus = 0;
    let lastVmBody: any = undefined;
    let lastVmBindings: unknown[] = [];
    let leakSeen = false;
    for (let attempt = 0; attempt < VM_POLL_ATTEMPTS; attempt++) {
      const vmQuery = await postJson(
        NODE1_API,
        '/api/query',
        {
          sparql:
            `SELECT ?o WHERE { <${subject}> <http://schema.org/name> ?o . FILTER(?o = ${witnessLiteral}) }`,
          contextGraphId: CONTEXT_GRAPH,
          view: 'verifiable-memory',
        },
        state.node1Token,
      );
      lastVmStatus = vmQuery.status;
      lastVmBody = vmQuery.body;
      // Parse via the shared helper, which THROWS on an unrecognised 200 shape
      // rather than coercing to [] — otherwise a wrapper regression silently
      // re-becomes "zero rows" and this leak guard passes open. A non-200 (still
      // warming up) legitimately has no bindings to read. (otReviewAgent #1258.)
      lastVmBindings = vmQuery.status === 200 ? queryBindings(vmQuery.body) : [];
      if (lastVmBindings.length > 0) {
        leakSeen = true;
        break;
      }
      if (attempt < VM_POLL_ATTEMPTS - 1) await sleep(VM_POLL_INTERVAL_MS);
    }
    expect(lastVmStatus, `vm query: ${JSON.stringify(lastVmBody)}`).toBe(200);
    // RFC-38: an edge publish (identityId=0) MAY legitimately reach `confirmed`
    // when peer cores supply storage ACKs — and a CONFIRMED publish's triples
    // appearing in verifiable-memory is CORRECT, not a leak. The PR2 regression
    // this guards is the silent `tentative` downgrade (asserted above) writing
    // into a VM-aliased graph on a publish that did NOT confirm. So only enforce
    // the zero-rows invariant when the publish did not confirm; otherwise the
    // rows are the expected, on-chain-attributed result.
    if (edgePublishStatus !== 'confirmed') {
      expect(
        leakSeen,
        `PR2 invariant violated: a NON-confirmed edge publish (status=${edgePublishStatus}) leaked ` +
        `${lastVmBindings.length} row(s) into view=verifiable-memory for ${subject} after up to ` +
        `${VM_POLL_ATTEMPTS * VM_POLL_INTERVAL_MS}ms of polling — the on-chain catch is still ` +
        `writing tentative quads to a graph that the VM view aliases. ` +
        `Re-check dkg-publisher.ts catch block and dkg-query-engine.ts ` +
        `verifiable-memory branch.`,
      ).toBe(false);
    } else {
      // CONFIRMED branch: rather than leave this case a no-op (which would only
      // prove the response was not `tentative` + the query returned 200), assert
      // POSITIVE on-chain evidence — a real confirmation carries a positive kaId
      // anchoring it on chain. This is synchronous (read from the publish
      // response), so it adds no devnet-timing flakiness. A "confirmed" status
      // with a zero/absent kaId (a fake confirm) fails here.
      expect(
        BigInt(edgePublishKaId ?? '0'),
        `edge publish reported status='confirmed' but kaId='${edgePublishKaId}' is not a positive ` +
        `on-chain id: ${JSON.stringify(r.body)}`,
      ).toBeGreaterThan(0n);
    }
  }, 90_000);
});

// ───────────────────────── 3. NFT staking withdraw ───────────────────────
describe('3. NFT staking withdraw', () => {
  it('tier-0 (no-lock) position withdraws cleanly: TRAC moves, NFT burns, position clears', async () => {
    // Bootstrap creates two tier-0 positions. Prefer one that still has raw
    // stake; if a prior suite (e.g. v10-e2e phase 3) already withdrew it,
    // mint a fresh tier-0 position so this test stays idempotent.
    let target: Delegator | undefined;
    let positionSnap: any;
    for (const candidate of state.delegators.filter((d) => d.tier === 0)) {
      const position = await state.css.getPosition(BigInt(candidate.tokenId));
      if (position.raw !== 0n) {
        target = candidate;
        positionSnap = position;
        break;
      }
    }
    if (!target) {
      const seed = state.delegators.find((d) => d.tier === 0)
        ?? state.delegators.find((d) => BigInt(d.identityId) === 1n);
      expect(seed, 'no tier-0 delegator seed for createConviction').toBeDefined();
      const seedWallet = new ethers.Wallet(seed!.privateKey, state.provider);
      // Drive the seed wallet's sequential txs through a NonceManager: this
      // wallet was already used by the devnet bootstrap, and under automining a
      // same-wallet approve→createConviction pair races the provider nonce query
      // (each re-reads getTransactionCount and can see a stale value → "Nonce
      // too low"). NonceManager assigns nonces locally + monotonically, so the
      // two txs are strictly ordered regardless of when the chain reflects them.
      const seedSigner = new ethers.NonceManager(seedWallet);
      const seedNft = new ethers.Contract(state.nft.target, NFT_ABI, seedSigner);
      const stakeAmount = ethers.parseEther('10000');
      const stakingV10Address = await state.staking.getAddress();
      const tokenAsSeed = state.token.connect(seedSigner) as ethers.Contract;
      await (await tokenAsSeed.approve(stakingV10Address, stakeAmount, { gasLimit: 500_000 })).wait();
      const createTx = await seedNft.createConviction(
        BigInt(seed!.identityId),
        stakeAmount,
        0n,
      );
      const createReceipt = await createTx.wait();
      expect(createReceipt.status).toBe(1);
      const transferIface = new ethers.Interface([
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
      ]);
      let newTokenId = 0n;
      for (const log of createReceipt.logs) {
        try {
          const parsed = transferIface.parseLog(log);
          if (
            parsed?.name === 'Transfer' &&
            (parsed.args.from as string).toLowerCase() === ethers.ZeroAddress &&
            (parsed.args.to as string).toLowerCase() === seedWallet.address.toLowerCase()
          ) {
            newTokenId = parsed.args.tokenId as bigint;
            break;
          }
        } catch { /* not our event */ }
      }
      expect(newTokenId, 'createConviction did not mint an NFT').toBeGreaterThan(0n);
      target = {
        ...seed!,
        tokenId: Number(newTokenId),
        stakeAmountTRAC: 10_000,
      };
      positionSnap = await state.css.getPosition(newTokenId);
    }
    expect(target, 'no tier-0 delegator available for withdraw').toBeDefined();

    const wallet = new ethers.Wallet(target!.privateKey, state.provider);
    const nft = new ethers.Contract(state.nft.target, NFT_ABI, wallet);
    const tokenIdRaw = BigInt(target!.tokenId);
    const expectedAmount = BigInt(positionSnap.raw);
    const tracBefore = await state.token.balanceOf(target!.address);

    const tx = await nft.withdraw(tokenIdRaw);
    const receipt = await tx.wait();
    expect(receipt.status, `withdraw tx reverted`).toBe(1);

    // `StakingV10.withdraw` AUTO-CLAIMS outstanding rewards and compounds them
    // into `raw` before the payout (Q3/D19 in StakingV10.sol), emitting
    // `RewardsClaimed(tokenId, amount)` from the same tx. So when earlier
    // suites (or test 4 on a re-run) left this position with unclaimed
    // RS-scored epochs, the payout is EXACTLY `pre-withdraw raw + auto-claimed
    // reward` — comparing against `raw` alone trips on that reward dust.
    // Derive the expected payout from the on-chain events instead of assuming
    // zero pending rewards; every equality below stays exact (no tolerance).
    const iface = new ethers.Interface(NFT_ABI);
    let eventAmount = 0n;
    let autoClaimed = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'PositionWithdrawn') eventAmount = parsed.args.amount;
        // Emitted by StakingV10 (parseLog matches on the event signature, not
        // the emitting address); tokenId-guarded for safety.
        if (parsed?.name === 'RewardsClaimed' && parsed.args.tokenId === tokenIdRaw) {
          autoClaimed += parsed.args.amount as bigint;
        }
      } catch { /* not our event */ }
    }
    expect(
      eventAmount,
      `PositionWithdrawn amount must equal pre-withdraw raw (${expectedAmount}) + ` +
        `auto-claimed reward (${autoClaimed})`,
    ).toBe(expectedAmount + autoClaimed);

    const tracAfter = await state.token.balanceOf(target!.address);
    expect(tracAfter - tracBefore, 'TRAC delta must match the withdraw payout (raw + auto-claimed reward)')
      .toBe(eventAmount);

    // NFT burned
    await expect(nft.ownerOf(tokenIdRaw)).rejects.toThrow();
    // Position cleared
    const positionAfter = await state.css.getPosition(tokenIdRaw);
    expect(positionAfter.raw).toBe(0n);
    expect(positionAfter.identityId).toBe(0n);
  }, 60_000);

  it('still-locked tier-3 position reverts withdraw (lock window enforced)', async () => {
    const target = state.delegators.find((d) => d.tier === 3);
    expect(target, 'no tier-3 delegator found').toBeDefined();
    const wallet = new ethers.Wallet(target!.privateKey, state.provider);
    const nft = new ethers.Contract(state.nft.target, NFT_ABI, wallet);
    const tokenId = BigInt(target!.tokenId);

    const positionBefore = await state.css.getPosition(tokenId);
    if (positionBefore.raw === 0n) return; // already withdrawn in a prior run; nothing to assert
    const block = await state.provider.getBlock('latest');
    if (positionBefore.expiryTimestamp <= BigInt(block!.timestamp)) {
      // lock has expired (e.g. after a long time-warp); skip the negative assertion
      return;
    }

    await expect(nft.withdraw(tokenId), 'tier-3 lock must block withdraw').rejects.toThrow();
  }, 30_000);
});

// ──────────── 4. Operator-fee accrual + withdrawal end-to-end ───────────
describe('4. operator-fee accrual + withdrawal', () => {
  it('updateFee → publish → score → warp → claim accrues 10% per RFC-26 → request/cooldown/finalize delivers TRAC', async () => {
    const identityId = 1n;

    // (a) Set fee to 1000 bps (10%). The new fee is staged as PENDING and
    // becomes "latest" at the next epoch boundary (or the one after, if
    // we're past the half-epoch median — see Profile.updateOperatorFee).
    //
    // Idempotent: re-runs on the same devnet skip the update when the fee
    // is already 1000 bps. `Profile.updateOperatorFee` reverts on a fresh
    // call when the previous epoch's operator-fee accrual hasn't been
    // claimed (the contract enforces "settle before re-fee"); a partially-
    // failed prior run could leave us in that state, and re-calling
    // `updateOperatorFee` then would mask the real test instead of
    // recovering. The current value of `getOperatorFee` is the only state
    // the rest of the test cares about.
    const profileWrite = state.profileWrite.connect(state.adminWallet) as ethers.Contract;
    const existingFee: bigint = await state.profileStorage.getOperatorFee(identityId);
    if (existingFee !== 1000n) {
      const tx = await profileWrite.updateOperatorFee(identityId, 1000);
      await tx.wait();
    }

    const feeCount: bigint = await state.profileStorage.getOperatorFeesLength(identityId);
    const feeEffectiveDate: bigint = await state.profileStorage.getOperatorFeeEffectiveDateByIndex(
      identityId,
      feeCount - 1n,
    );

    // The 10% fee must be live BEFORE the epoch we score and later claim.
    // Profile stages the fee at timestampForEpoch(startEpoch+1); _claim resolves
    // epoch N's fee at timestampForEpoch(N+1)-1, so scoring+claiming the same
    // epoch the fee was set in still applies 0%. Warp past the effective
    // boundary first, then score the post-fee epoch.
    const blockBeforeFeeWarp = await state.provider.getBlock('latest');
    const nowBeforeFee = BigInt(blockBeforeFeeWarp!.timestamp);
    const feeWarpSeconds = Number((feeEffectiveDate > nowBeforeFee ? feeEffectiveDate - nowBeforeFee : 0n) + 2n);
    if (feeWarpSeconds > 0) {
      await state.provider.send('evm_increaseTime', [feeWarpSeconds]);
    }
    await state.provider.send('hardhat_mine', ['0x5', '0x0']);
    const scoreEpoch = await state.chronos.getCurrentEpoch();

    // Generate 5 fresh publishes from node1 (core) so scoreEpoch's pool is
    // non-trivial AND the sampler has eligible KCs to challenge.
    for (let i = 0; i < 5; i++) {
      const name = `core-flows-fee-pub-${Date.now().toString(36)}-${i}`;
      await fullPublish(NODE1_API, state.node1Token, name);
      await sleep(1500);
    }

    // The RS prover runs a full pipeline before the epoch score turns
    // non-zero: an open proof period (100 blocks on the devnet — ~100s at the
    // default 1s block interval), a prover-loop tick that draws the challenge,
    // KC extraction, and a mined proof tx. The previous fixed 80s window
    // covered less than ONE proof period, so the assertion was timing-lucky:
    // fast hosts landed a proof inside the window, loaded CI hosts missed it.
    // Poll against a generous wall-clock deadline instead, and tick the chain
    // a couple of blocks each attempt so proof periods keep rolling even when
    // interval mining is off (HARDHAT_BLOCK_INTERVAL_MS=0) or the interval
    // miner lags under load — same rationale as the no-stall liveness poll in
    // devnet/pr1385-subgraph-rs. hardhat_mine's zero per-block timestamp
    // interval leaves wall-clock time (and therefore the current epoch)
    // unwarped: scoreEpoch must remain the LIVE epoch for the prover to score
    // it. The assertion itself is unchanged — the score MUST become > 0.
    const RS_SCORE_DEADLINE_MS = 120_000;
    const RS_SCORE_POLL_MS = 5_000;
    const rsScoreDeadline = Date.now() + RS_SCORE_DEADLINE_MS;
    let scoreNow = await state.rs.getNodeEpochScore(scoreEpoch, identityId);
    while (scoreNow === 0n && Date.now() < rsScoreDeadline) {
      await state.provider.send('hardhat_mine', ['0x2', '0x0']);
      await sleep(RS_SCORE_POLL_MS);
      scoreNow = await state.rs.getNodeEpochScore(scoreEpoch, identityId);
    }
    expect(
      scoreNow,
      `node1 must have non-zero RS score in epoch ${scoreEpoch} ` +
        `(no proof landed within ${RS_SCORE_DEADLINE_MS / 1000}s of polling)`,
    ).toBeGreaterThan(0n);

    const allScore = await state.rs.getAllNodesEpochScore(scoreEpoch);
    const epochPool = await state.es.getEpochPool(1n, scoreEpoch);
    const grossNode1 = (BigInt(epochPool) * scoreNow) / allScore;
    const expectedFee = (grossNode1 * 1000n) / 10000n; // 10% of gross

    // Warp across at least one full epoch boundary so claim() can settle
    // scoreEpoch rewards under the now-active 10% operator fee.
    const blockBeforeWarp = await state.provider.getBlock('latest');
    const nowTimestamp = BigInt(blockBeforeWarp!.timestamp);
    const epochLen = await state.chronos.epochLength();
    const targetTimestamp = nowTimestamp + epochLen + 120n;
    const warpSeconds = Number(targetTimestamp - nowTimestamp);
    if (warpSeconds > 0) {
      await state.provider.send('evm_increaseTime', [warpSeconds]);
    }
    await state.provider.send('hardhat_mine', ['0x5', '0x0']);
    const newEpoch = await state.chronos.getCurrentEpoch();
    expect(newEpoch).toBeGreaterThan(scoreEpoch);

    const feeBpsLatest = await state.profileStorage.getOperatorFee(identityId);
    // ABI returns uint16 → ethers v6 surfaces it as `bigint`. Compare with the
    // bigint literal so a future ABI bump back to `number` would surface here
    // as a controlled test update rather than a silent mismatch.
    expect(feeBpsLatest).toBe(1000n);

    // (e) Have a delegator on node1 claim → triggers operator-fee accrual.
    // Pick the highest-stake position on identityId=1 to maximise reward
    // and minimise rounding noise.
    const candidate = state.delegators
      .filter((d) => BigInt(d.identityId) === identityId)
      .sort((a, b) => b.stakeAmountTRAC - a.stakeAmountTRAC)[0];
    expect(candidate, `no delegator on identityId=${identityId}`).toBeDefined();

    const delegatorWallet = new ethers.Wallet(candidate!.privateKey, state.provider);
    const nft = new ethers.Contract(state.nft.target, NFT_ABI, delegatorWallet);
    const balBefore: bigint = BigInt(await state.css.getOperatorFeeBalance(identityId));

    const claimTx = await nft.claim(BigInt(candidate!.tokenId));
    const claimReceipt = await claimTx.wait();
    expect(claimReceipt.status).toBe(1);

    const balAfter = BigInt(await state.css.getOperatorFeeBalance(identityId));
    const accrued: bigint = balAfter - BigInt(balBefore);
    expect(accrued, 'operator-fee must accrue on first claim').toBeGreaterThan(0n);

    // RFC-26 conformance: accrual within 1% of `gross × bps / 10_000`.
    const driftAbs: bigint = expectedFee > accrued ? expectedFee - accrued : accrued - expectedFee;
    const driftBps = expectedFee > 0n ? Number((driftAbs * 10000n) / expectedFee) : 0;
    expect(driftBps, `accrual ${ethers.formatUnits(accrued, 18)} TRAC drifts ${driftBps} bps from RFC prediction ${ethers.formatUnits(expectedFee, 18)} TRAC`)
      .toBeLessThan(100);
    if (driftBps > 0) recordFinding(`operator-fee accrual drift: ${driftBps} bps from RFC-26 prediction`);

    // (f) Withdrawal cycle: request → assert cooldown → warp → finalize.
    const adminTracBefore = await state.token.balanceOf(state.adminWallet.address);
    const stakingWrite = state.staking.connect(state.adminWallet) as ethers.Contract;
    const reqTx = await stakingWrite.requestOperatorFeeWithdrawal(identityId, balAfter);
    await reqTx.wait();

    const queued = await state.css.getOperatorFeeWithdrawalRequest(identityId);
    expect(queued.amount).toBe(balAfter);
    expect(await state.css.getOperatorFeeBalance(identityId)).toBe(0n);

    // Early finalize must revert (cooldown enforcement).
    await expect(stakingWrite.finalizeOperatorFeeWithdrawal.staticCall(identityId))
      .rejects.toThrow();

    const delay = await state.params.stakeWithdrawalDelay();
    await state.provider.send('evm_increaseTime', [Number(delay) + 5]);
    await state.provider.send('evm_mine', []);

    // Use a fresh nonce — interval mining + the admin wallet being shared
    // with other devnet processes can desync ethers' nonce cache.
    const nonce = await state.provider.getTransactionCount(state.adminWallet.address);
    const finTx = await stakingWrite.finalizeOperatorFeeWithdrawal(identityId, { nonce });
    const finReceipt = await finTx.wait();
    expect(finReceipt.status).toBe(1);

    const adminTracAfter = await state.token.balanceOf(state.adminWallet.address);
    expect(adminTracAfter - adminTracBefore, 'TRAC must transfer to operator EOA on finalize')
      .toBe(balAfter);
    const queuedAfter = await state.css.getOperatorFeeWithdrawalRequest(identityId);
    expect(queuedAfter.amount).toBe(0n);
  }, 600_000);
});

// ───────── 5. Addressed-read provenance (dkg_get_entity_sources, PR #1253) ─────────
//
// The `dkg_get_entity_sources` MCP tool answers "what is known about entity X,
// and which Knowledge Asset asserted each fact?" — it reads
// `SELECT ?p ?o ?g WHERE { GRAPH ?g { <X> ?p ?o } }` scoped to verifiable-memory
// and parses the per-KA source graph `…/_verifiable_memory/{author}/{number}`
// into the on-chain UAL identity a consumer cites/verifies against. The tool's
// parsing/rendering is unit-tested with synthetic graphs; what ONLY a live
// devnet can prove is that a REAL publish actually materialises that exact
// per-KA source graph — i.e. the provenance handle the tool hands back resolves
// to the publish's true on-chain (author, number).
//
// This pins that engine-layer contract end-to-end: publish an entity from a
// core, read it back via the addressed-read shape, and assert the source graph
// encodes the SAME (author, number) packed into the returned on-chain kaId
// (reservedKaId = (uint160(author) << 96) | uint96(number) — the derivation the
// publisher itself uses to build the VM graph URI, see dkg-publisher.ts:1553).
describe('5. addressed-read provenance resolves to the per-KA verifiable-memory source', () => {
  it("a published entity's facts carry a _verifiable_memory/{author}/{number} source matching its on-chain kaId", async () => {
    const name = `core-flows-prov-${Date.now().toString(36)}`;
    const subject = `urn:test:core-flows:${name}`; // fullPublish writes quads about this subject
    const pub = await fullPublish(NODE1_API, state.node1Token, name);

    // Reproduce the publisher's kaId → VM-graph derivation (dkg-publisher.ts:1553).
    const kaId = BigInt(pub.kaId);
    const author = '0x' + (kaId >> 96n).toString(16).padStart(40, '0');
    const number = (kaId & ((1n << 96n) - 1n)).toString();

    // Break the circularity (otReviewAgent #1258): pub.kaId comes from the daemon's
    // own publish response, and the VM graph is materialised from that same value —
    // so a publisher bug that returned AND materialised the same WRONG id would slip
    // past a check that only compares the graph to pub.kaId. Anchor to chain truth:
    // the KA-storage NFT's ownerOf(kaId) REVERTS for a non-existent token and
    // otherwise returns the address packed into the id (OT-RFC-43:
    // kaId = (uint160(author) << 96) | uint96(number)). So a forged id either
    // reverts here or fails owner == author — independently of what the daemon said.
    const dkgKaAddr: string = await state.hub.getAssetStorageAddress('DKGKnowledgeAssets');
    const dkgKa = new ethers.Contract(
      dkgKaAddr,
      ['function ownerOf(uint256) view returns (address)'],
      state.provider,
    );
    const onChainOwner: string = await dkgKa.ownerOf(kaId); // reverts if kaId is not a real minted KA
    expect(
      onChainOwner.toLowerCase(),
      `kaId ${pub.kaId}: on-chain owner ${onChainOwner} != author packed into the id (${author}) — daemon reported an id that does not match chain truth`,
    ).toBe(author.toLowerCase());

    const expectedSource = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/${author}/${number}`;

    // Addressed read: project the source graph per fact — the exact shape the
    // tool issues. Parse via the shared queryBindings helper (throws on an
    // unrecognised 200 shape). Poll briefly so post-confirmation VM
    // materialisation has time to land.
    const val = (x: unknown): string =>
      typeof x === 'string' ? x : ((x as { value?: string })?.value ?? '');
    let bindings: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      const r = await postJson(
        NODE1_API,
        '/api/query',
        {
          sparql: `SELECT ?p ?o ?g WHERE { GRAPH ?g { <${subject}> ?p ?o } }`,
          contextGraphId: CONTEXT_GRAPH,
          view: 'verifiable-memory',
        },
        state.node1Token,
      );
      bindings = r.status === 200 ? queryBindings(r.body) : [];
      if (bindings.length > 0) break;
      await sleep(1000);
    }
    expect(bindings.length, `no verifiable-memory rows for ${subject} after polling`).toBeGreaterThan(0);

    const sources = [...new Set(bindings.map((b) => val(b.g)))];

    // (1) The correct per-KA source IS present — the handle a consumer cites
    // resolves to THIS publish's on-chain (author, number).
    expect(
      sources.map((s) => s.toLowerCase()),
      `expected per-KA source ${expectedSource}; got [${sources.join(', ')}]`,
    ).toContain(expectedSource.toLowerCase());

    // (2) No per-KA-shaped source carries a DIFFERENT (author, number) — i.e.
    // attribution is never fabricated/mismatched against the on-chain identity.
    // (Root / per-collection graphs that don't match the per-KA shape are the
    // tool's "disclosed, non-citable" rows and are intentionally skipped here.)
    for (const s of sources) {
      const m = s.match(/\/_verifiable_memory\/([^/]+)\/([^/]+)$/);
      if (!m) continue;
      expect(m[1].toLowerCase(), `source ${s}: author != on-chain ${author}`).toBe(author.toLowerCase());
      expect(m[2], `source ${s}: kaNumber != on-chain ${number}`).toBe(number);
    }
  }, 120_000);
});
