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
import {
  expectTxSuccess,
  parseEventOrThrow,
  parseEventIfPresent,
  expectRevert,
  assertDevnetReady,
} from '../_lib';

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

interface SseHandle {
  events: Array<{ event: string; data: any; receivedAt: string }>;
  /** Resolves once the SSE stream has issued its 200 response headers (i.e.
   * the HTTP layer has accepted the subscription). The daemon emits
   * subsequent events through this connection. */
  ready: Promise<void>;
  close: () => void;
}

function openSseAndCollect(
  api: string,
  token: string,
  shouldKeep: (event: string, data: any) => boolean,
): SseHandle {
  const events: Array<{ event: string; data: any; receivedAt: string }> = [];
  const u = new URL(api + '/api/events');
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const req = http.get({
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/event-stream',
    },
  }, (res) => {
    if (res.statusCode !== 200) {
      rejectReady(new Error(`SSE subscribe failed: HTTP ${res.statusCode}`));
      return;
    }
    resolveReady();
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
  req.on('error', rejectReady);
  return { events, ready, close: () => req.destroy() };
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
  // Preflight: actionable error if any precondition is missing — beats
  // the cryptic ECONNREFUSED / ENOENT chain the inline ethers/contract
  // calls produce when devnet isn't running.
  await assertDevnetReady({
    expectedNodes: 6,
    requireWallets: true,
    startCommandHint:
      './scripts/devnet.sh clean && ./scripts/devnet.sh start 6 && node devnet/_bootstrap/bootstrap.cjs',
  });
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
    // Deterministic ready: wait for the daemon's SSE handler to ack the
    // subscription with HTTP 200 before issuing the create. The previous
    // `sleep(500)` warm-up was a flake source on slow CI.
    await sse.ready;

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
    const expectedOps = ['assertion_created', 'assertion_written', 'assertion_finalized', 'assertion_promoted'] as const;
    expect(ops, `expected exactly 4 lifecycle events in order; got: ${ops.join(', ')}`)
      .toEqual(expectedOps);
    // Pin: each operation appears EXACTLY once. A duplicate would indicate
    // the daemon double-emitted (e.g. retries or an idempotency-bug
    // regression that re-fires the SSE on a no-op call). The previous
    // assertion only checked the array equality, which would not catch a
    // duplicate in the middle (`['a','a','b','c']`).
    for (const op of expectedOps) {
      const matches = ops.filter((o) => o === op);
      expect(matches.length, `${op} fired ${matches.length} times; expected exactly 1`).toBe(1);
    }
    // Each event payload must reference the same assertionName.
    for (const e of sse.events) {
      expect(e.data?.contextGraphId).toBe(CONTEXT_GRAPH);
      // The daemon includes the assertion's URI fragment somewhere in the
      // payload — `assertionUri` for create/write/finalize, or `name` /
      // `merkleRoot` for promote depending on shape. We just verify no
      // event leaked from a different assertion (CG isolation).
      const blob = JSON.stringify(e.data);
      expect(blob, `event ${e.data.operation} did not reference ${assertionName}`).toContain(assertionName);
    }
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
    expectTxSuccess(receipt, 'NFT.withdraw(tier-0)');

    // Strict event verification — event MUST fire exactly once with the
    // correct amount and the correct tokenId. The previous loop allowed
    // a missing event to silently set `eventAmount = 0n` and then match
    // a `raw=0` position — bug-hiding.
    const iface = new ethers.Interface(NFT_ABI);
    const withdrawEvent = parseEventOrThrow(
      iface,
      receipt.logs,
      'PositionWithdrawn',
      (parsed) => (parsed.args.tokenId as bigint) === tokenIdRaw,
    ) as { args: { tokenId: bigint; amount: bigint } };
    expect(withdrawEvent.args.amount, 'PositionWithdrawn.amount must equal raw stake').toBe(expectedAmount);

    // RewardsClaimed is emitted iff the auto-claim component returned > 0.
    // For a tier-0 no-rewards-yet position we expect NO RewardsClaimed
    // event. If one fires, log the amount as a finding (it would mean
    // RS has accrued rewards on this position since bootstrap — useful
    // signal for downstream tests).
    const rewardsEvent = parseEventIfPresent(
      iface,
      receipt.logs,
      'RewardsClaimed',
      (parsed) => (parsed.args.tokenId as bigint) === tokenIdRaw,
    ) as { args: { tokenId: bigint; amount: bigint } } | undefined;
    if (rewardsEvent && rewardsEvent.args.amount > 0n) {
      recordFinding(
        `RewardsClaimed during tier-0 withdraw: tokenId=${tokenIdRaw}, amount=${ethers.formatEther(rewardsEvent.args.amount)} TRAC. ` +
          `Adjust the TRAC-delta assertion to expect raw + claimed if this happens regularly.`,
      );
    }

    const tracAfter = await state.token.balanceOf(target!.address);
    const expectedDelta = expectedAmount + (rewardsEvent?.args.amount ?? 0n);
    expect(
      tracAfter - tracBefore,
      `TRAC delta must equal raw stake (+ claimed rewards if any). ` +
        `expected ${expectedDelta}, got ${tracAfter - tracBefore}`,
    ).toBe(expectedDelta);

    // NFT burned — ownerOf reverts. Use the explicit ERC721NonexistentToken
    // marker substring rather than ".rejects.toThrow()" so a different
    // revert (e.g. RPC error) doesn't masquerade as a successful burn.
    await expectRevert(() => nft.ownerOf(tokenIdRaw), 'ownerOf after burn');
    // Position cleared — every field that should be 0 IS 0.
    const positionAfter = await state.css.getPosition(tokenIdRaw);
    expect(positionAfter.raw).toBe(0n);
    expect(positionAfter.identityId).toBe(0n);
    expect(positionAfter.lockTier).toBe(0n);
    expect(positionAfter.expiryTimestamp).toBe(0n);
    expect(positionAfter.multiplier18).toBe(0n);
  }, 60_000);

  it('still-locked tier-3 position reverts withdraw (lock window enforced)', async () => {
    const target = state.delegators.find((d) => d.tier === 3);
    expect(target, 'no tier-3 delegator found').toBeDefined();
    const wallet = new ethers.Wallet(target!.privateKey, state.provider);
    const nft = new ethers.Contract(state.nft.target, NFT_ABI, wallet);
    const tokenId = BigInt(target!.tokenId);

    const positionBefore = await state.css.getPosition(tokenId);
    if (positionBefore.raw === 0n) {
      // Already withdrawn (re-run on warm devnet). Surface as a finding so
      // an operator running the suite knows the lock-revert assertion did
      // not exercise — previously silently `return`ed and let the test
      // appear green.
      recordFinding(
        `tier-3 lock-revert assertion not exercised: tokenId=${tokenId} already withdrawn ` +
          `(raw=0). To validate the lock branch on this devnet, re-run \`devnet/_bootstrap/bootstrap.cjs\`.`,
      );
      return;
    }
    const block = await state.provider.getBlock('latest');
    expect(block, 'provider returned no head block').toBeTruthy();
    if (positionBefore.expiryTimestamp <= BigInt(block!.timestamp)) {
      recordFinding(
        `tier-3 lock-revert assertion not exercised: lock has already expired ` +
          `(expiry=${positionBefore.expiryTimestamp}, now=${block!.timestamp}). ` +
          `A long evm_increaseTime in a prior phase warped past the lock; clean devnet to re-arm.`,
      );
      return;
    }
    // Negative test — withdraw() on a tier > 0 position before
    // expiryTimestamp must revert. We use staticCall to keep the nonce
    // pristine (a real tx that reverts still consumes a nonce, which can
    // race with subsequent same-wallet ops in the suite).
    await expectRevert(
      () => nft.withdraw.staticCall(tokenId),
      'tier-3 lock must block withdraw',
    );
  }, 30_000);

  // ────────────────────────────────────────────────────────────────────────
  // Negative: ERC-721 withdraw is owner-only.
  //
  // Documents and pins the access-control rule on
  // `DKGStakingConvictionNFT.withdraw(tokenId)` — only the NFT's current
  // owner can call it. A regression that allowed any caller to withdraw
  // would silently drain stakes; this test catches it cheaply.
  // ────────────────────────────────────────────────────────────────────────
  it('non-owner withdraw reverts (NFT access control)', async () => {
    const stillStaked = state.delegators
      .filter((d) => d.tier === 0)
      .find(async (d) => {
        const p = await state.css.getPosition(BigInt(d.tokenId));
        return p.raw !== 0n;
      });
    if (!stillStaked) {
      recordFinding('non-owner-withdraw test skipped: no tier-0 stake remaining post-test-3a.');
      return;
    }
    const tokenId = BigInt(stillStaked.tokenId);
    const positionAtStart = await state.css.getPosition(tokenId);
    if (positionAtStart.raw === 0n) {
      recordFinding('non-owner-withdraw test skipped: position withdrawn between picks.');
      return;
    }
    // Random fresh wallet — not the NFT owner.
    const stranger = ethers.Wallet.createRandom().connect(state.provider);
    await state.provider.send('hardhat_setBalance', [
      stranger.address,
      '0x' + ethers.parseEther('1').toString(16),
    ]);
    const strangerNft = new ethers.Contract(state.nft.target, NFT_ABI, stranger);
    await expectRevert(
      () => strangerNft.withdraw.staticCall(tokenId),
      'non-owner cannot withdraw an NFT-keyed position',
    );
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
    expectTxSuccess(claimReceipt, 'NFT.claim');

    // RewardsClaimed event — pin the on-chain reward amount that the
    // delegator actually received (vs. the operator-fee accrual we measure
    // via getOperatorFeeBalance). gross = delegatorReward + operatorFee.
    const claimIface = new ethers.Interface(NFT_ABI);
    const rewardsEvt = parseEventOrThrow(
      claimIface,
      claimReceipt.logs,
      'RewardsClaimed',
      (p) => (p.args.tokenId as bigint) === BigInt(candidate!.tokenId),
    ) as { args: { tokenId: bigint; amount: bigint } };
    const delegatorReward = rewardsEvt.args.amount;
    expect(delegatorReward, 'delegator must receive a non-zero reward share').toBeGreaterThan(0n);

    const balAfter = BigInt(await state.css.getOperatorFeeBalance(identityId));
    const accrued: bigint = balAfter - BigInt(balBefore);
    expect(accrued, 'operator-fee must accrue on first claim').toBeGreaterThan(0n);

    // RFC-26 conformance: accrual within 0.5% of `gross × bps / 10_000`.
    // Tightened from 1% (100 bps) — on a deterministic devnet the drift
    // is only the rounding loss in the integer fee math (≤1 wei in
    // practice), so 0.5% is plenty of slack but tight enough to catch
    // any real formula regression. If a real-world gas/RS-noise effect
    // ever justifies relaxing this, that's a finding worth reviewing —
    // not a knob to turn quietly.
    const driftAbs: bigint = expectedFee > accrued ? expectedFee - accrued : accrued - expectedFee;
    const driftBps = expectedFee > 0n ? Number((driftAbs * 10000n) / expectedFee) : 0;
    expect(driftBps, `accrual ${ethers.formatUnits(accrued, 18)} TRAC drifts ${driftBps} bps from RFC prediction ${ethers.formatUnits(expectedFee, 18)} TRAC`)
      .toBeLessThan(50);
    if (driftBps > 0) recordFinding(`operator-fee accrual drift: ${driftBps} bps from RFC-26 prediction`);

    // Conservation check: gross epoch reward routed to this position
    // (from RS) MUST equal delegatorReward + operatorFeeAccrued (within
    // the same 50 bps slack — the math is a single multiply/divide so
    // any real discrepancy is a bug). This catches a class of regressions
    // where the fee path either over- or under-credits.
    const totalCredited = delegatorReward + accrued;
    const totalDriftAbs: bigint = grossNode1 > totalCredited ? grossNode1 - totalCredited : totalCredited - grossNode1;
    const totalDriftBps = grossNode1 > 0n ? Number((totalDriftAbs * 10000n) / grossNode1) : 0;
    expect(
      totalDriftBps,
      `delegatorReward+operatorFee=${ethers.formatUnits(totalCredited, 18)} vs gross=${ethers.formatUnits(grossNode1, 18)} drifts ${totalDriftBps} bps`,
    ).toBeLessThan(50);

    // (f) Withdrawal cycle: request → assert cooldown → warp → finalize.
    const adminTracBefore = await state.token.balanceOf(state.adminWallet.address);
    const stakingWrite = state.staking.connect(state.adminWallet) as ethers.Contract;

    // Negative: requesting 0 must revert (input validation).
    await expectRevert(
      () => stakingWrite.requestOperatorFeeWithdrawal.staticCall(identityId, 0n),
      'requestOperatorFeeWithdrawal must reject 0 amount',
    );
    // Negative: requesting more than the balance must revert (overflow guard).
    await expectRevert(
      () => stakingWrite.requestOperatorFeeWithdrawal.staticCall(identityId, balAfter + 1n),
      'requestOperatorFeeWithdrawal must reject withdrawal > balance',
    );
    // Negative: non-admin caller must be rejected. Identity-admin is
    // enforced at the StakingV10 layer via IdentityStorage.keyHasPurpose
    // — a stranger should hit the access-control branch.
    const stranger = ethers.Wallet.createRandom().connect(state.provider);
    await state.provider.send('hardhat_setBalance', [
      stranger.address,
      '0x' + ethers.parseEther('1').toString(16),
    ]);
    const stakingAsStranger = state.staking.connect(stranger) as ethers.Contract;
    await expectRevert(
      () => stakingAsStranger.requestOperatorFeeWithdrawal.staticCall(identityId, 1n),
      'non-admin must not be able to request operator-fee withdrawal',
    );

    const reqTx = await stakingWrite.requestOperatorFeeWithdrawal(identityId, balAfter);
    const reqReceipt = await reqTx.wait();
    expectTxSuccess(reqReceipt, 'requestOperatorFeeWithdrawal');

    const queued = await state.css.getOperatorFeeWithdrawalRequest(identityId);
    expect(queued.amount).toBe(balAfter);
    expect(await state.css.getOperatorFeeBalance(identityId)).toBe(0n);

    // Negative: a second request while one is queued must revert (the
    // queued amount is non-zero — `getOperatorFeeWithdrawalRequest`
    // returned a valid record above). Pin: the contract MUST NOT
    // overwrite an in-flight request without explicit cancellation.
    await expectRevert(
      () => stakingWrite.requestOperatorFeeWithdrawal.staticCall(identityId, 1n),
      'second request while one is queued must revert',
    );

    // Early finalize must revert (cooldown enforcement).
    await expectRevert(
      () => stakingWrite.finalizeOperatorFeeWithdrawal.staticCall(identityId),
      'finalize before cooldown elapses must revert',
    );

    const delay = await state.params.stakeWithdrawalDelay();
    await state.provider.send('evm_increaseTime', [Number(delay) + 5]);
    await state.provider.send('evm_mine', []);

    // Use a fresh nonce — interval mining + the admin wallet being shared
    // with other devnet processes can desync ethers' nonce cache.
    const nonce = await state.provider.getTransactionCount(state.adminWallet.address);
    const finTx = await stakingWrite.finalizeOperatorFeeWithdrawal(identityId, { nonce });
    const finReceipt = await finTx.wait();
    expectTxSuccess(finReceipt, 'finalizeOperatorFeeWithdrawal');

    const adminTracAfter = await state.token.balanceOf(state.adminWallet.address);
    expect(adminTracAfter - adminTracBefore, 'TRAC must transfer to operator EOA on finalize')
      .toBe(balAfter);
    const queuedAfter = await state.css.getOperatorFeeWithdrawalRequest(identityId);
    expect(queuedAfter.amount).toBe(0n);

    // Replay-safety: a second finalize call after the request slot is
    // cleared must revert. Pins idempotency — without this, a partially
    // observed finalize tx that races with retry logic could double-pay.
    await expectRevert(
      () => stakingWrite.finalizeOperatorFeeWithdrawal.staticCall(identityId),
      'finalize after the queued request is cleared must revert',
    );
  }, 600_000);
});
