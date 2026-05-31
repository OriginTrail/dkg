/**
 * End-to-end smoke test of the V8→V10 migration credit pipeline against
 * a local Hardhat node.
 *
 * What this script exercises (the bits that the unit/integration test
 * suite does NOT exercise on its own):
 *   * Real `hardhat deploy --network localhost` artifacts (not a
 *     `loadFixture` snapshot).
 *   * The real `upload_v8_eligibility.ts` CLI as a subprocess, including
 *     CSV parsing, idempotent `setEligibleBatch` chunking, count
 *     verification, and the `--freeze` step.
 *   * `DKGStakingConvictionNFT.selfMigrateV8` from each test signer
 *     under four scenarios in one shot:
 *
 *       Scenario              | Tier | In registry | Expect credit?
 *       ----------------------|------|-------------|---------------
 *       eligible-12           |  12  | yes         | yes (60d)
 *       eligible-6            |   6  | yes         | yes (60d)
 *       eligible-low-tier     |   3  | yes         | NO (lower tier)
 *       ineligible-12         |  12  | no          | NO (not in registry)
 *
 * What this DOES NOT exercise: the `snapshot_v8_eligibility.ts` event
 * replay (a fresh hardhat node has no 60-day V8 history). That part of
 * the pipeline is validated separately against Gnosis mainnet data and
 * will be exercised end-to-end on Base Sepolia.
 *
 * Prereq:
 *   1. `npx hardhat node` running (separate terminal).
 *   2. `npx hardhat --network localhost --config hardhat.node.config.ts deploy`
 *      already completed against that node.
 *   3. `deployments/localhost_contracts.json` written by step 2.
 *
 * Run:
 *   npx ts-node --esm scripts/devnet-credit-smoke.ts
 */

import { ethers } from 'ethers';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const RPC = process.env.RPC_LOCALHOST ?? 'http://localhost:8545';
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

const TIER_DURATIONS_S: Record<number, bigint> = {
  1: 30n * 24n * 60n * 60n,
  3: 90n * 24n * 60n * 60n,
  6: 180n * 24n * 60n * 60n,
  12: 366n * 24n * 60n * 60n,
};

// ---- Minimal ABIs (keep the script standalone; no typechain dep) -----------

const HUB_ABI = [
  'function setContractAddress(string,address) external',
  'function owner() view returns (address)',
];

const TOKEN_ABI = [
  'function mint(address,uint256) external',
  'function balanceOf(address) view returns (uint256)',
];

const PROFILE_ABI = [
  'function createProfile(address,address[],string,bytes,uint16) external returns (uint72)',
];

const STAKING_STORAGE_ABI = [
  'function increaseDelegatorStakeBase(uint72,bytes32,uint96) external',
  'function increaseNodeStake(uint72,uint96) external',
  'function increaseTotalStake(uint96) external',
];

const NFT_ABI = [
  'function selfMigrateV8(uint72,uint40) external returns (uint256)',
  'function nextTokenId() view returns (uint256)',
];

const CSS_ABI = [
  'function getPosition(uint256) view returns (tuple(uint96 raw,uint40 lockTier,uint40 expiryTimestamp,uint72 identityId,uint96 cumulativeRewardsClaimed,uint64 multiplier18,uint32 lastClaimedEpoch,uint32 migrationEpoch))',
];

const CHRONOS_ABI = ['function epochLength() view returns (uint256)'];

const REGISTRY_ABI = [
  'function frozen() view returns (bool)',
  'function eligibleCount() view returns (uint256)',
  'function isEligible(uint72,address) view returns (bool)',
];

// ---- helpers ---------------------------------------------------------------

type Deployments = {
  contracts: Record<string, { evmAddress: string; version?: string }>;
};

function readDeployments(): Deployments {
  const p = resolve(REPO_ROOT, 'deployments', 'localhost_contracts.json');
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function addressOf(d: Deployments, name: string): string {
  const e = d.contracts[name];
  if (!e?.evmAddress) {
    throw new Error(`${name} not found in deployments/localhost_contracts.json`);
  }
  return e.evmAddress;
}

function signerAt(provider: ethers.JsonRpcProvider, idx: number): ethers.Wallet {
  const m = ethers.Mnemonic.fromPhrase(HARDHAT_MNEMONIC);
  return ethers.HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${idx}`).connect(
    provider,
  ) as unknown as ethers.Wallet;
}

function fmtSeconds(s: bigint): string {
  const days = Number(s) / 86400;
  return `${days.toFixed(2)}d`;
}

// ---- main ------------------------------------------------------------------

type Scenario = {
  label: string;
  signerIdx: number;
  identityId: bigint;
  identityKey: string; // 'A' or 'B'
  tier: number;
  registerEligible: boolean;
  expectCredit: boolean;
  v8StakeTrac: string;
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  // Sanity: are we actually talking to a local node?
  try {
    await provider.getBlockNumber();
  } catch {
    throw new Error(`Cannot reach ${RPC} — start hardhat node first.`);
  }

  const deployer = signerAt(provider, 0); // HubOwner / deployer
  const opNodeA = signerAt(provider, 1); // operational caller for profile A
  const opNodeB = signerAt(provider, 2); // operational caller for profile B
  const adminWallet = signerAt(provider, 3); // adminWallet for both profiles

  // Per-scenario delegator signers, deliberately disjoint from the
  // operational/admin wallets so identity-key collisions don't bite.
  const aliceSigner = signerAt(provider, 10); // eligible-12 on node A
  const bobSigner = signerAt(provider, 11); // eligible-6 on node A
  const carolSigner = signerAt(provider, 12); // eligible-low-tier on node A
  const daveSigner = signerAt(provider, 13); // ineligible-12 on node B

  const d = readDeployments();
  console.log('--- Loaded deployments/localhost_contracts.json ---');
  console.log(`StakingV10 ${d.contracts.StakingV10?.version}`);
  console.log(`ConvictionStakingStorage ${d.contracts.ConvictionStakingStorage?.version}`);
  console.log(`V8MigrationEligibility ${d.contracts.V8MigrationEligibility?.version}`);
  console.log();

  const Hub = new ethers.Contract(addressOf(d, 'Hub'), HUB_ABI, deployer);
  const Token = new ethers.Contract(addressOf(d, 'Token'), TOKEN_ABI, deployer);
  const Profile = new ethers.Contract(addressOf(d, 'Profile'), PROFILE_ABI, opNodeA);
  const StakingStorage = new ethers.Contract(
    addressOf(d, 'StakingStorage'),
    STAKING_STORAGE_ABI,
    deployer,
  );
  const NFT = new ethers.Contract(addressOf(d, 'DKGStakingConvictionNFT'), NFT_ABI, deployer);
  const CSS = new ethers.Contract(
    addressOf(d, 'ConvictionStakingStorage'),
    CSS_ABI,
    provider,
  );
  const Chronos = new ethers.Contract(addressOf(d, 'Chronos'), CHRONOS_ABI, provider);
  const Registry = new ethers.Contract(
    addressOf(d, 'V8MigrationEligibility'),
    REGISTRY_ABI,
    provider,
  );

  // 1. Make sure HubOwner is wired so the test's SS-direct seeding works
  //    (the existing v10-converttonft-drain-fix integration uses the same
  //    setContractAddress("HubOwner", ...) idiom; we mirror it here).
  const owner = await Hub.owner();
  console.log(`Hub.owner: ${owner}`);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error('Deployer is not Hub.owner — re-deploy with the right account.');
  }

  // Manage the deployer's nonce manually. Hardhat node refuses to queue
  // pending txs under automine, and ethers v6's contract callers can race
  // when several txs go out from the same signer in quick succession —
  // the chain accepts tx N, but the next call still asks for N from
  // `getTransactionCount` and gets shoved out of order. Tracking the
  // nonce ourselves avoids that without disabling automine.
  let dNonce = await provider.getTransactionCount(deployer.address, 'pending');
  const send = async <T extends ethers.ContractTransactionResponse>(p: Promise<T>) => {
    const tx = await p;
    await tx.wait();
    return tx;
  };
  const next = () => ({ nonce: dNonce++ });

  await send(Hub.setContractAddress('HubOwner', deployer.address, next()));

  // 2. Create two distinct profiles. Profile.createProfile is keyed by
  //    msg.sender, so each profile needs a different operational wallet.
  console.log('Creating profile A (operational=accounts[1])...');
  const txA = await Profile.connect(opNodeA).createProfile(
    adminWallet.address,
    [],
    'devnet-node-A',
    ethers.hexlify(ethers.randomBytes(32)),
    0,
  );
  const recA = await txA.wait();
  const idA = BigInt(recA!.logs[0].topics[1]);
  console.log(`  identityId A = ${idA}`);

  console.log('Creating profile B (operational=accounts[2])...');
  const txB = await Profile.connect(opNodeB).createProfile(
    adminWallet.address,
    [],
    'devnet-node-B',
    ethers.hexlify(ethers.randomBytes(32)),
    0,
  );
  const recB = await txB.wait();
  const idB = BigInt(recB!.logs[0].topics[1]);
  console.log(`  identityId B = ${idB}`);

  const scenarios: Scenario[] = [
    {
      label: 'eligible-12 (alice on A)',
      signerIdx: 10,
      identityId: idA,
      identityKey: 'A',
      tier: 12,
      registerEligible: true,
      expectCredit: true,
      v8StakeTrac: '5000',
    },
    {
      label: 'eligible-6 (bob on A)',
      signerIdx: 11,
      identityId: idA,
      identityKey: 'A',
      tier: 6,
      registerEligible: true,
      expectCredit: true,
      v8StakeTrac: '3000',
    },
    {
      label: 'eligible-low-tier (carol on A, tier 3)',
      signerIdx: 12,
      identityId: idA,
      identityKey: 'A',
      tier: 3,
      registerEligible: true,
      expectCredit: false,
      v8StakeTrac: '1000',
    },
    {
      label: 'ineligible-12 (dave on B)',
      signerIdx: 13,
      identityId: idB,
      identityKey: 'B',
      tier: 12,
      registerEligible: false,
      expectCredit: false,
      v8StakeTrac: '7500',
    },
  ];

  // 3. Seed V8 stake into StakingStorage for each scenario delegator.
  //    Mints TRAC into SS to back the V8 accounting (mirrors the
  //    seedV8Stake helper used in the contract integration tests).
  for (const s of scenarios) {
    const wallet = signerAt(provider, s.signerIdx);
    const wei = ethers.parseEther(s.v8StakeTrac);
    const v8Key = ethers.keccak256(ethers.solidityPacked(['address'], [wallet.address]));

    await send(Token.mint(await StakingStorage.getAddress(), wei, next()));
    await send(
      StakingStorage.increaseDelegatorStakeBase(s.identityId, v8Key, wei, next()),
    );
    await send(StakingStorage.increaseNodeStake(s.identityId, wei, next()));
    await send(StakingStorage.increaseTotalStake(wei, next()));
    console.log(
      `Seeded V8 stake: ${s.label} ${s.v8StakeTrac} TRAC on identityId=${s.identityId}`,
    );
  }

  // 4. Write the synthetic eligibility CSV. Only the entries the
  //    snapshot script would mark with eligibleAmount > 0 go in.
  const tmp = mkdtempSync(join(tmpdir(), 'v8-credit-smoke-'));
  const csvPath = join(tmp, 'eligibility.csv');
  const lines = ['identityId,delegator,eligibleAmount'];
  for (const s of scenarios) {
    const wallet = signerAt(provider, s.signerIdx);
    if (!s.registerEligible) continue;
    const wei = ethers.parseEther(s.v8StakeTrac);
    lines.push(`${s.identityId},${wallet.address.toLowerCase()},${wei}`);
  }
  // Add a duplicate row to prove client-side dedup works.
  if (lines.length > 1) lines.push(lines[1]);
  writeFileSync(csvPath, lines.join('\n') + '\n');
  console.log(`\nWrote synthetic eligibility CSV: ${csvPath}`);
  for (const l of lines) console.log(`  ${l}`);

  // 5. First run the upload script in --dry-run mode so the
  //    operator-facing CLI gets exercised, then again with --freeze.
  console.log('\n--- upload_v8_eligibility.ts --dry-run ---');
  runUpload(['--network', 'localhost', '--csv', csvPath, '--dry-run']);

  console.log('\n--- upload_v8_eligibility.ts (real run + --freeze) ---');
  runUpload(['--network', 'localhost', '--csv', csvPath, '--chunk', '50', '--freeze']);

  // 6. Verify on-chain registry state matches expectations.
  const [frozen, count] = await Promise.all([Registry.frozen(), Registry.eligibleCount()]);
  console.log(`\nRegistry frozen=${frozen}, eligibleCount=${count}`);
  const expectedCount = scenarios.filter((s) => s.registerEligible).length;
  if (Number(count) !== expectedCount) {
    throw new Error(`expected eligibleCount=${expectedCount}, got ${count}`);
  }
  if (!frozen) throw new Error('expected registry to be frozen');
  for (const s of scenarios) {
    const wallet = signerAt(provider, s.signerIdx);
    const isOn = await Registry.isEligible(s.identityId, wallet.address);
    if (isOn !== s.registerEligible) {
      throw new Error(
        `${s.label}: expected isEligible=${s.registerEligible}, got ${isOn}`,
      );
    }
  }
  console.log('Registry state matches expectations.');

  // 7. Self-migrate per scenario and verify the resulting V10 NFT
  //    expiryTimestamp. StakingV10 3.1.0 review follow-up: the credit is
  //    a fixed 60-day literal, independent of `chronos.epochLength`.
  const epochLength = BigInt(await Chronos.epochLength());
  const credit = 60n * 24n * 60n * 60n;
  console.log(
    `\nChronos.epochLength()=${epochLength}s (${fmtSeconds(epochLength)}); fixed credit=${credit}s (${fmtSeconds(credit)})\n`,
  );

  type Result = { scenario: Scenario; ok: boolean; detail: string };
  const results: Result[] = [];
  for (const s of scenarios) {
    const wallet = signerAt(provider, s.signerIdx);
    const tokenId: bigint = await NFT.connect(provider).nextTokenId();
    const expectedTokenId = tokenId + 1n;

    const tx = await NFT.connect(wallet).selfMigrateV8(s.identityId, s.tier);
    const receipt = await tx.wait();
    const blockTs = BigInt((await provider.getBlock(receipt!.blockNumber))!.timestamp);

    const pos = await CSS.getPosition(expectedTokenId);
    const tierDuration = TIER_DURATIONS_S[s.tier];
    const expectedExpiry = blockTs + tierDuration - (s.expectCredit ? credit : 0n);

    const ok = BigInt(pos.expiryTimestamp) === expectedExpiry;
    const shortenedBy = blockTs + tierDuration - BigInt(pos.expiryTimestamp);
    results.push({
      scenario: s,
      ok,
      detail:
        `tokenId=${expectedTokenId} ` +
        `tier=${s.tier} ` +
        `expiry=${pos.expiryTimestamp} ` +
        `(default ${blockTs + tierDuration}, shortenedBy=${shortenedBy}s, ` +
        `expected shortenedBy=${s.expectCredit ? credit : 0n}s)`,
    });
  }

  console.log('=== Smoke test results ===');
  let failed = 0;
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${r.scenario.label}: ${r.detail}`);
    if (!r.ok) failed++;
  }
  if (failed) {
    console.error(`\n${failed}/${results.length} scenarios failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} scenarios passed.`);
}

function runUpload(args: string[]) {
  // `npx ts-node --esm` is unreliable across pnpm/Node versions: the
  // evm-module ts-node binary errors with `Unknown file extension ".ts"`
  // under Node's native ESM loader. The repo root ships `tsx` as a dev dep
  // which transparently runs `.ts` files under ESM, so prefer it. Fall
  // back to the local ts-node only if tsx is missing.
  const workspaceRoot = resolve(REPO_ROOT, '..', '..');
  const tsxBin = resolve(workspaceRoot, 'node_modules', '.bin', 'tsx');
  const tsNodeBin = resolve(REPO_ROOT, 'node_modules', '.bin', 'ts-node');
  let cmd: string;
  let cmdArgs: string[];
  try {
    readFileSync(tsxBin);
    cmd = tsxBin;
    cmdArgs = ['scripts/upload_v8_eligibility.ts', ...args];
  } catch {
    cmd = tsNodeBin;
    cmdArgs = ['--esm', 'scripts/upload_v8_eligibility.ts', ...args];
  }
  const result = spawnSync(cmd, cmdArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`upload_v8_eligibility.ts exited with ${result.status}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
