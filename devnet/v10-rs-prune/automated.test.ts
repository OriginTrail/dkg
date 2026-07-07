/**
 * V10 Random Sampling — expired-KA prune keeper, end-to-end on a live devnet.
 *
 * Exercises the case where a CG's sampling list accumulates expired "dead slots"
 * that can starve the bounded within-CG draw, against the DEPLOYED V10 contracts
 * + the REAL publish path — the layer the hardhat unit tests can't reach. The within-CG starvation mechanic itself is proven deterministically in
 * `packages/evm-module/test/unit/RandomSampling.test.ts` ("recovery path: a
 * clogged CG starves previewChallengeForSeed before pruning, succeeds after").
 * Here we prove the operational story on a running network:
 *
 *   1. A real CLI publish registers a KA into BOTH per-CG lists (the append-only
 *      `_contextGraphKAList` the chain-reconciler reads AND the compacted
 *      `_samplingKAList` the draw reads) — verified against the deployed
 *      ContextGraphStorage.
 *   2. The permissionless keeper `RandomSampling.pruneExpiredKnowledgeAssets`
 *      is callable as an ordinary tx by an arbitrary funded wallet, and prunes
 *      ONLY the sampling list.
 *   3. Reconciler-safety holds on-chain: pruning shrinks `getSamplingKaCount`
 *      but leaves `getContextGraphKaCount` (the registration ordinal) untouched,
 *      so a later publish can never be skipped by the reconciler.
 *
 * NOTE — the network-wide draw (`createChallenge` / `previewChallengeForSeed`)
 * selects across EVERY weighted CG on the devnet, so per-CG starvation is not
 * deterministically assertable on a shared devnet; that is covered by the unit
 * test. Here the assertions are per-CG count invariants, which ARE deterministic.
 *
 * Run:
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   pnpm test:devnet:v10-rs-prune
 *
 * Tuning: DKG_RS_PRUNE_FLOOD (default 8) — number of 1-epoch KAs to flood.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';

// ───────────────────────────── constants ─────────────────────────────────
const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
// Well-known hardhat account #0 — funded; the keeper is permissionless so any
// funded wallet can call it (that is the point of the test).
const HARDHAT_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FLOOD = Number(process.env.DKG_RS_PRUNE_FLOOD ?? 8);
const LIVE_EPOCHS = 50; // the one KA that must survive the warp + prune
const PUBLISH_NODE = Number(process.env.DKG_RS_PRUNE_NODE ?? 1);

interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
}

interface ScenarioState {
  provider: ethers.JsonRpcProvider;
  node: DevnetNode;
  contextGraphStorage: ethers.Contract;
  randomSampling: ethers.Contract;
  chronos: ethers.Contract;
  cgName: string;
  cgCanonicalId: string;
  cgId: bigint;
  liveKaId: bigint;
  floodKaIds: bigint[];
}

const state: Partial<ScenarioState> = {};

// ───────────────────────────── helpers ───────────────────────────────────
function readNodeConfig(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(
      `Devnet node${num} home missing — run ./scripts/devnet.sh start <N> first`,
    );
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  let authToken = '';
  if (existsSync(join(home, 'auth.token'))) {
    authToken =
      readFileSync(join(home, 'auth.token'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  return { num, apiPort: config.apiPort, home, authToken };
}

async function ensureIdentity(node: DevnetNode, timeoutS = 60): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (node.authToken) headers.Authorization = `Bearer ${node.authToken}`;
  const statusUrl = `http://127.0.0.1:${node.apiPort}/api/status`;
  const status = (await (await fetch(statusUrl)).json()) as { identityId: string };
  if (BigInt(status.identityId) > 0n) return;
  await fetch(`http://127.0.0.1:${node.apiPort}/api/identity/ensure`, {
    method: 'POST',
    headers,
  });
  for (let i = 0; i < timeoutS; i++) {
    const st = (await (await fetch(statusUrl)).json()) as { identityId: string };
    if (BigInt(st.identityId) > 0n) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`node${node.num} did not register an identity within ${timeoutS}s`);
}

function runDkgCli(node: DevnetNode, args: string[], timeoutMs = 90_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'packages/cli/dist/cli.js'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DKG_NO_BLUE_GREEN: '1', DKG_HOME: node.home, DKG_API_PORT: String(node.apiPort) },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`dkg CLI timeout after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rej(err);
    });
  });
}

async function publish(node: DevnetNode, cg: string, name: string, epochs: number): Promise<bigint> {
  const dir = join(__dirname, 'turns');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.nq`);
  const subject = `urn:test:${name}`;
  writeFileSync(
    file,
    `<${subject}> <https://schema.org/name> "${name}" <did:dkg:context-graph:${cg}> .\n` +
      `<${subject}> <https://schema.org/description> "rs-prune devnet scenario" <did:dkg:context-graph:${cg}> .\n`,
  );
  // #1410 replaced the one-shot `dkg publish <cg> --file` with the KA
  // lifecycle CLI: `ka create --share` stages the KA (WM -> finalize -> SWM),
  // then `ka publish` performs the on-chain SWM -> VM publish. `name` is
  // already unique per call (live/flood-N), so it doubles as the KA name.
  const created = await runDkgCli(node, ['ka', 'create', name, '--context-graph-id', cg, '--input-file', file, '--share']);
  if (created.code !== 0) {
    throw new Error(`ka create --share ${name} failed (exit ${created.code})\nstdout: ${created.stdout}\nstderr: ${created.stderr}`);
  }
  const r = await runDkgCli(node, ['ka', 'publish', name, '--context-graph-id', cg, '--publish-epochs', String(epochs)]);
  if (r.code !== 0) {
    throw new Error(`ka publish ${name} failed (exit ${r.code})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  const status = (/Status:\s*(\w+)/i.exec(r.stdout)?.[1] ?? 'unknown').toLowerCase();
  expect(['confirmed', 'finalized', 'tentative'], `ka publish ${name} status=${status}\n${r.stdout}`).toContain(status);
  const kaId = /K[AC] ID:\s*(\d+)/i.exec(r.stdout)?.[1];
  expect(kaId, `ka publish ${name} surfaced no KA ID\n${r.stdout}`).toBeTruthy();
  return BigInt(kaId!);
}

async function timeWarpSeconds(provider: ethers.JsonRpcProvider, seconds: number): Promise<void> {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}

// ───────────────────────────── scenario ──────────────────────────────────
describe('V10 RS prune keeper — flood → expire → prune → reconciler-safe (live devnet)', () => {
  beforeAll(async () => {
    if (!existsSync(DEVNET_DIR)) {
      throw new Error('No .devnet/ — start a devnet first: ./scripts/devnet.sh start 6');
    }
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
    const contractsPath = join(REPO_ROOT, 'packages/evm-module/deployments/localhost_contracts.json');
    // The deploy writes { contracts: { Hub: { evmAddress } } } (schema since the
    // localhost_contracts.json consolidation) — read through the wrapper.
    const hubAddress: string = JSON.parse(readFileSync(contractsPath, 'utf8')).contracts.Hub.evmAddress;
    const hub = new ethers.Contract(
      hubAddress,
      ['function getContractAddress(string) view returns (address)', 'function getAssetStorageAddress(string) view returns (address)'],
      provider,
    );
    const cgsAddr = await hub.getAssetStorageAddress('ContextGraphStorage');
    const rsAddr = await hub.getContractAddress('RandomSampling');
    const chronosAddr = await hub.getContractAddress('Chronos');

    state.provider = provider;
    state.node = readNodeConfig(PUBLISH_NODE);
    state.contextGraphStorage = new ethers.Contract(
      cgsAddr,
      [
        'function getContextGraphKaCount(uint256) view returns (uint256)',
        'function getSamplingKaCount(uint256) view returns (uint256)',
        'function getSamplingKaAt(uint256,uint256) view returns (uint256)',
        'function kaToContextGraph(uint256) view returns (uint256)',
      ],
      provider,
    );
    state.randomSampling = new ethers.Contract(
      rsAddr,
      ['function pruneExpiredKnowledgeAssets(uint256,uint256,uint256) returns (uint256)'],
      provider,
    );
    state.chronos = new ethers.Contract(chronosAddr, ['function epochLength() view returns (uint256)'], provider);
    state.cgName = `rs-prune-${Date.now()}`;
    state.floodKaIds = [];

    await ensureIdentity(state.node);

    // The retired one-shot `dkg publish` auto-created its context graph; the
    // #1410 `ka` lifecycle requires an existing, ON-CHAIN-registered CG (the
    // flood publishes to VM). Create + register it once up front.
    const cgCreate = await runDkgCli(state.node, ['context-graph', 'create', state.cgName, '--name', state.cgName]);
    if (cgCreate.code !== 0) {
      throw new Error(`context-graph create failed (exit ${cgCreate.code})\nstdout: ${cgCreate.stdout}\nstderr: ${cgCreate.stderr}`);
    }
    // A curated CG's canonical id is "<curatorAddress>/<slug>" — register and
    // publishes must use the canonical form from create's output. Keep cgName
    // (the slug) for KA names/filenames: the "/" would break both.
    const canonicalId = /^\s*ID:\s+(.+)$/m.exec(cgCreate.stdout)?.[1]?.trim();
    if (!canonicalId) {
      throw new Error(`could not parse context graph ID from:\n${cgCreate.stdout}`);
    }
    state.cgCanonicalId = canonicalId;
    // Inner CLI timeout must stay below the hook budget (420s) or vitest's
    // opaque hook timeout fires before this call's pointed error can.
    const cgRegister = await runDkgCli(state.node, ['context-graph', 'register', state.cgCanonicalId], 240_000);
    if (cgRegister.code !== 0) {
      throw new Error(`context-graph register failed (exit ${cgRegister.code})\nstdout: ${cgRegister.stdout}\nstderr: ${cgRegister.stderr}`);
    }
  }, 420_000);

  it('publishes a live KA + a flood of 1-epoch KAs; both per-CG lists mirror on-chain', async () => {
    const s = state as ScenarioState;
    // Live KA first → it lands at sampling index 0 and is never swapped out.
    s.liveKaId = await publish(s.node, s.cgCanonicalId, `${s.cgName}-live`, LIVE_EPOCHS);
    s.cgId = await s.contextGraphStorage.kaToContextGraph(s.liveKaId);
    expect(s.cgId, 'live KA has no CG binding').toBeGreaterThan(0n);

    for (let i = 0; i < FLOOD; i++) {
      const ka = await publish(s.node, s.cgCanonicalId, `${s.cgName}-flood-${i}`, 1);
      s.floodKaIds.push(ka);
      expect(await s.contextGraphStorage.kaToContextGraph(ka)).to.equal(s.cgId);
    }

    const expected = BigInt(FLOOD + 1);
    // Dual-write: the registration list and the sampling list both hold all KAs.
    expect(await s.contextGraphStorage.getContextGraphKaCount(s.cgId)).to.equal(expected);
    expect(await s.contextGraphStorage.getSamplingKaCount(s.cgId)).to.equal(expected);
  }, 600_000);

  it('advancing past the 1-epoch lifetime leaves the dead slots in the sampling list (no auto-prune)', async () => {
    const s = state as ScenarioState;
    const epochLength = await s.chronos.epochLength();
    await timeWarpSeconds(s.provider, Number(epochLength) * 3);
    // Nothing prunes automatically — the dead slots persist until the keeper runs.
    expect(await s.contextGraphStorage.getSamplingKaCount(s.cgId)).to.equal(BigInt(FLOOD + 1));
  }, 120_000);

  it('the permissionless keeper prunes ONLY the sampling list; the registration ordinal is preserved', async () => {
    const s = state as ScenarioState;
    const keeper = new ethers.Wallet(HARDHAT_DEPLOYER_KEY, s.provider);
    const rs = s.randomSampling.connect(keeper) as ethers.Contract;

    // An arbitrary funded wallet (not a privileged role) can call it.
    const removed: bigint = await rs.pruneExpiredKnowledgeAssets.staticCall(s.cgId, 0n, 1000n);
    expect(removed).to.equal(BigInt(FLOOD));
    await (await rs.pruneExpiredKnowledgeAssets(s.cgId, 0n, 1000n)).wait();

    // Sampling list now holds only the live KA...
    expect(await s.contextGraphStorage.getSamplingKaCount(s.cgId)).to.equal(1n);
    expect(await s.contextGraphStorage.getSamplingKaAt(s.cgId, 0n)).to.equal(s.liveKaId);
    // ...but the append-only registration ordinal is UNCHANGED (reconciler-safe).
    expect(await s.contextGraphStorage.getContextGraphKaCount(s.cgId)).to.equal(BigInt(FLOOD + 1));
    // ...and the reverse binding of a pruned KA survives (readers/dedup intact).
    expect(await s.contextGraphStorage.kaToContextGraph(s.floodKaIds[0]!)).to.equal(s.cgId);
  }, 120_000);
});
