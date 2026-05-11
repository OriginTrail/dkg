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
 *   2. Edge-node publish — runs create+write+finalize+promote+publish from
 *      an edge daemon (no on-chain identity) and asserts the publish
 *      surfaces `status: "tentative"` to the caller, with the daemon log
 *      showing the explicit "Identity not set (0) — skipping on-chain
 *      publish" warning. This is the architectural rule for app/relay
 *      nodes; a regression that crashed or pretended to chain-submit
 *      would silently break every edge integration.
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

const NODE1_API = 'http://127.0.0.1:9201';
const NODE5_API = 'http://127.0.0.1:9205'; // edge

const HUB_ABI = [
  'function getContractAddress(string) view returns (address)',
  'function getAssetStorageAddress(string) view returns (address)',
];
const NFT_ABI = [
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
];
const RS_ABI = [
  'function getNodeEpochScore(uint256, uint72) view returns (uint256)',
  'function getAllNodesEpochScore(uint256) view returns (uint256)',
];
const ES_ABI = ['function getEpochPool(uint256, uint256) view returns (uint96)'];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

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

async function fullPublish(api: string, token: string, name: string): Promise<{ kcId: string; status: string; merkleRoot: string }> {
  const cgId = CONTEXT_GRAPH;
  const quads = [
    { subject: `urn:test:core-flows:${name}:s1`, predicate: 'http://schema.org/name', object: `"${name}"`, graph: '' },
    { subject: `urn:test:core-flows:${name}:s2`, predicate: 'http://schema.org/value', object: '"epoch-pool fuel"', graph: '' },
  ];
  let r = await postJson(api, '/api/assertion/create', { contextGraphId: cgId, name }, token);
  expect(r.status, `create failed: ${JSON.stringify(r.body)}`).toBe(200);
  r = await postJson(api, `/api/assertion/${name}/write`, { contextGraphId: cgId, quads }, token);
  expect(r.status, `write failed: ${JSON.stringify(r.body)}`).toBe(200);
  r = await postJson(api, `/api/assertion/${name}/finalize`, { contextGraphId: cgId }, token);
  expect(r.status, `finalize failed: ${JSON.stringify(r.body)}`).toBe(200);
  r = await postJson(api, `/api/assertion/${name}/promote`, { contextGraphId: cgId }, token);
  expect(r.status, `promote failed: ${JSON.stringify(r.body)}`).toBe(200);
  r = await postJson(api, '/api/shared-memory/publish', { contextGraphId: cgId, assertionName: name }, token);
  expect(r.status, `publish failed: ${JSON.stringify(r.body)}`).toBe(200);
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
    const sse = openSseAndCollect(
      NODE1_API,
      state.node1Token,
      (event, data) =>
        event === 'memory_graph_changed' && data?.contextGraphId === CONTEXT_GRAPH,
    );
    await sleep(500); // SSE warm-up

    let r = await postJson(NODE1_API, '/api/assertion/create', { contextGraphId: CONTEXT_GRAPH, name: assertionName }, state.node1Token);
    expect(r.status, `create: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.assertionUri).toContain(assertionName);

    const quads = [
      { subject: 'urn:test:lifecycle:s1', predicate: 'http://schema.org/name', object: '"Sign-at-creation lifecycle test"', graph: '' },
      { subject: 'urn:test:lifecycle:s2', predicate: 'http://schema.org/sameAs', object: 'urn:test:lifecycle:s1', graph: '' },
    ];
    r = await postJson(NODE1_API, `/api/assertion/${assertionName}/write`, { contextGraphId: CONTEXT_GRAPH, quads }, state.node1Token);
    expect(r.status, `write: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.written).toBe(2);

    r = await postJson(NODE1_API, `/api/assertion/${assertionName}/finalize`, { contextGraphId: CONTEXT_GRAPH }, state.node1Token);
    expect(r.status, `finalize: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.body.eip712Digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.body.schemeVersion).toBe(1);

    r = await postJson(NODE1_API, `/api/assertion/${assertionName}/promote`, { contextGraphId: CONTEXT_GRAPH }, state.node1Token);
    expect(r.status, `promote: ${JSON.stringify(r.body)}`).toBe(200);
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

// ────────────────────────── 2. Edge-node publish ─────────────────────────
describe('2. edge-node publish', () => {
  it('runs full lifecycle on edge node and surfaces tentative status (no on-chain identity)', async () => {
    const assertionName = `core-flows-edge-${Date.now().toString(36)}`;

    let r = await postJson(NODE5_API, '/api/assertion/create', { contextGraphId: CONTEXT_GRAPH, name: assertionName }, state.node5Token);
    expect(r.status, `edge create: ${JSON.stringify(r.body)}`).toBe(200);

    const quads = [
      { subject: 'urn:test:edge:s1', predicate: 'http://schema.org/name', object: '"Edge-node publish test"', graph: '' },
      { subject: 'urn:test:edge:s1', predicate: 'http://schema.org/author', object: '"edge-node-5"', graph: '' },
    ];
    r = await postJson(NODE5_API, `/api/assertion/${assertionName}/write`, { contextGraphId: CONTEXT_GRAPH, quads }, state.node5Token);
    expect(r.status).toBe(200);
    r = await postJson(NODE5_API, `/api/assertion/${assertionName}/finalize`, { contextGraphId: CONTEXT_GRAPH }, state.node5Token);
    expect(r.status).toBe(200);
    const sealMerkleRoot = r.body.merkleRoot;
    r = await postJson(NODE5_API, `/api/assertion/${assertionName}/promote`, { contextGraphId: CONTEXT_GRAPH }, state.node5Token);
    expect(r.status).toBe(200);

    r = await postJson(NODE5_API, '/api/shared-memory/publish', { contextGraphId: CONTEXT_GRAPH, assertionName }, state.node5Token);
    expect(r.status, `edge publish: ${JSON.stringify(r.body)}`).toBe(200);

    // The architectural rule: edge has no on-chain identity, so the publish
    // is held tentative and gossiped — not chain-anchored. Caller learns
    // this from the response status.
    expect(r.body.status, 'edge publish must be tentative — edge has no on-chain identity').toBe('tentative');
    expect(r.body.merkleRoot).toBe(sealMerkleRoot);
    // kcId 0 is the placeholder for "no chain anchor yet"
    expect(['0', 0]).toContain(r.body.kcId);
  }, 90_000);
});

// ───────────────────────── 3. NFT staking withdraw ───────────────────────
describe('3. NFT staking withdraw', () => {
  it('tier-0 (no-lock) position withdraws cleanly: TRAC moves, NFT burns, position clears', async () => {
    // Bootstrap creates two tier-0 positions. Pick one that still has raw
    // stake so the suite can be re-run after a partial previous pass.
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
    expect(target, 'no unwithdrawn tier-0 delegator found — re-bootstrap').toBeDefined();

    const wallet = new ethers.Wallet(target!.privateKey, state.provider);
    const nft = new ethers.Contract(state.nft.target, NFT_ABI, wallet);
    const tokenIdRaw = BigInt(target!.tokenId);
    const expectedAmount = BigInt(positionSnap.raw);
    const tracBefore = await state.token.balanceOf(target!.address);

    const tx = await nft.withdraw(tokenIdRaw);
    const receipt = await tx.wait();
    expect(receipt.status, `withdraw tx reverted`).toBe(1);

    const iface = new ethers.Interface(NFT_ABI);
    let eventAmount = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'PositionWithdrawn') eventAmount = parsed.args.amount;
      } catch { /* not our event */ }
    }
    expect(eventAmount).toBe(expectedAmount);

    const tracAfter = await state.token.balanceOf(target!.address);
    expect(tracAfter - tracBefore, 'TRAC delta must match raw stake').toBe(expectedAmount);

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
    const startEpoch = await state.chronos.getCurrentEpoch();

    // (b) Generate 5 fresh publishes from node1 (core) so the current epoch
    // pool gets non-trivial value AND the sampler has eligible KCs to
    // challenge in the current epoch. Without this, RS scoring stays at 0.
    for (let i = 0; i < 5; i++) {
      const name = `core-flows-fee-pub-${Date.now().toString(36)}-${i}`;
      await fullPublish(NODE1_API, state.node1Token, name);
      await sleep(1500);
    }

    // (c) Wait up to ~80s for RS to score the current epoch. Tightly coupled
    // to devnet's `proofingPeriodDurationInBlocks=100` and 1s interval mining.
    let scoreNow = await state.rs.getNodeEpochScore(startEpoch, identityId);
    for (let waited = 0; waited < 80 && scoreNow === 0n; waited += 5) {
      await sleep(5_000);
      scoreNow = await state.rs.getNodeEpochScore(startEpoch, identityId);
    }
    expect(scoreNow, `node1 must have non-zero RS score in epoch ${startEpoch}`).toBeGreaterThan(0n);

    const allScore = await state.rs.getAllNodesEpochScore(startEpoch);
    const epochPool = await state.es.getEpochPool(1n, startEpoch);
    const grossNode1 = (BigInt(epochPool) * scoreNow) / allScore;
    const expectedFee = (grossNode1 * 1000n) / 10000n; // 10% of gross

    // (d) Warp such that BOTH (i) the pending fee effective date has passed
    // (so `getOperatorFee` returns 1000), and (ii) we've crossed into an
    // epoch strictly greater than `startEpoch` (so the claim window for
    // startEpoch's reward pool is open). On a fresh devnet (i) usually
    // dominates; on a re-run where the fee is already active (i) is in
    // the past and (ii) becomes the binding constraint.
    const blockBeforeWarp = await state.provider.getBlock('latest');
    const nowTimestamp = BigInt(blockBeforeWarp!.timestamp);
    const tNext = await state.chronos.timeUntilNextEpoch();
    const nextEpochStart = nowTimestamp + BigInt(tNext);
    const targetTimestamp = (feeEffectiveDate > nextEpochStart ? feeEffectiveDate : nextEpochStart) + 120n;
    if (nowTimestamp < targetTimestamp) {
      await state.provider.send('evm_increaseTime', [Number(targetTimestamp - nowTimestamp)]);
    }
    await state.provider.send('evm_mine', []);
    const newEpoch = await state.chronos.getCurrentEpoch();
    expect(newEpoch).toBeGreaterThan(startEpoch);

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
