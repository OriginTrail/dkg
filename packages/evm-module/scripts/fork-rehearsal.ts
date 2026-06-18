// =============================================================================
// fork-rehearsal.ts — OT-RFC-50 high-fidelity pre-flight (Base mainnet fork)
// =============================================================================
//
// Forks Base mainnet at the live freeze Hub (0x99Aa…), deploys ONLY the 3 new
// migration contracts onto the REAL Hub, wires them by impersonating the Hub
// owner. Then it exercises the admin-push flow against REAL deployed state:
// the impersonated Hub owner ADMIN-DRAINS a REAL mainnet delegator's V8 stake
// into that delegator's migration credit (adminMigrateToCredit), and the
// delegator then ALLOCATES it — against the REAL StakingStorage / ShardingTable
// / Ask / Identity / Profile state.
//
// This is the gate that a fixture CANNOT provide: `drainV8ToCredit` hits the
// real deployed StakingStorage bytecode + real stake, and `allocate`'s tail
// (profileExists, sharding insert, ask.recalculateActiveSet) runs against the
// real ~59-node active set — not a synthetic 1-node fixture.
//
// IMPORTANT — run against an EXTERNAL Base fork, NOT hardhat's in-process node.
// Hardhat 2.28.6's bundled EDR has no hardfork history for Base (chainId 8453)
// and silently drops the `networks.hardhat.chains[8453].hardforkHistory`
// workaround, so `hardhat_reset { forking }` errors with "No known hardfork …
// not configured with a hardfork activation history". anvil forks OP-stack
// chains natively, so we point hardhat at an anvil fork as a plain RPC:
//
//   anvil --fork-url <base-rpc> --port 8545 &       # needs Foundry installed
//   npx hardhat run scripts/fork-rehearsal.ts --network localhost
//
// hardhat's default `localhost` network targets http://127.0.0.1:8545; anvil
// supports the hardhat_ RPC namespace (impersonateAccount/setBalance) this uses.
// Nothing here touches mainnet — anvil's fork is a local in-memory chain.

import { ethers } from 'hardhat';
import hre from 'hardhat';

// ---- live Base-mainnet coordinates (freeze Hub holding the V8 stake) ----
const HUB = '0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13';
// Real Base-mainnet V8 delegator discovered via DelegatorsInfo.getDelegators():
//   single position, node 3, 17.3754…  TRAC, no pending withdrawal.
const DELEGATOR = process.env.DELEGATOR ?? '0x7D1E9050f02044CBf200BC2B75d443D8e464A0d9';
const SOURCE_NODE = BigInt(process.env.SOURCE_NODE ?? '3');
const TARGET_NODE = BigInt(process.env.TARGET_NODE ?? '3'); // re-stake to a real node
const LOCK_TIER = BigInt(process.env.LOCK_TIER ?? '12'); // eligible tier (6/12)
const CREDIT_SECONDS = BigInt(process.env.CREDIT_SECONDS ?? String(70 * 24 * 60 * 60));

const FUND = '0x56BC75E2D63100000'; // 100 ETH in wei (hex) for impersonated gas

const fmt = (x: bigint) => ethers.formatEther(x);

async function impersonate(addr: string) {
  await hre.network.provider.send('hardhat_setBalance', [addr, FUND]);
  return ethers.getImpersonatedSigner(addr);
}

async function deploy(name: string, deployer: any): Promise<string> {
  const f = await ethers.getContractFactory(name, deployer);
  const c = await f.deploy(HUB);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  deployed ${name} → ${addr}`);
  return addr;
}

async function main() {
  // ---- 1. confirm we're talking to a Base fork (anvil): the live freeze Hub
  //         bytecode must be present at a Base-height block. ----
  const blockNo = await ethers.provider.getBlockNumber();
  const hubCode = await ethers.provider.getCode(HUB);
  console.log(`Connected at block ${blockNo}; Hub bytecode ${hubCode === '0x' ? 'ABSENT' : `present (${hubCode.length} chars)`}`);
  if (hubCode === '0x') {
    throw new Error(
      `No Hub bytecode at ${HUB}. Start a Base fork and target it:\n` +
        `  anvil --fork-url <base-rpc> --port 8545 &\n` +
        `  npx hardhat run scripts/fork-rehearsal.ts --network localhost`,
    );
  }

  const hub = await ethers.getContractAt(
    ['function owner() view returns (address)', 'function setContractAddress(string,address)', 'function getContractAddress(string) view returns (address)', 'function isContract(address) view returns (bool)'],
    HUB,
  );
  const hubOwnerAddr: string = await hub.owner();
  console.log(`Hub ${HUB}\n  owner ${hubOwnerAddr}`);

  const [funder] = await ethers.getSigners();
  const owner = await impersonate(hubOwnerAddr);
  const delegator = await impersonate(DELEGATOR);

  // ---- sanity: the delegator's real V8 position on the forked storage ----
  const ssAddr: string = await hub.getContractAddress('StakingStorage');
  const ss = await ethers.getContractAt(
    [
      'function getDelegatorStakeBase(uint72,bytes32) view returns (uint96)',
      'function getDelegatorWithdrawalRequestAmount(uint72,bytes32) view returns (uint96)',
      'function getNodeStake(uint72) view returns (uint96)',
      'function getTotalStake() view returns (uint96)',
    ],
    ssAddr,
  );
  const v8Key = ethers.keccak256(ethers.solidityPacked(['address'], [DELEGATOR]));
  const baseBefore: bigint = await ss.getDelegatorStakeBase(SOURCE_NODE, v8Key);
  // The drain absorbs stakeBase + any pending withdrawal (D8). totalStake already
  // excludes pending, so credited == base + pending while total drops by base only.
  const pendingBefore: bigint = await ss.getDelegatorWithdrawalRequestAmount(SOURCE_NODE, v8Key);
  const nodeBefore: bigint = await ss.getNodeStake(SOURCE_NODE);
  const totalBefore: bigint = await ss.getTotalStake();
  console.log(`\nReal V8 position (forked StakingStorage ${ssAddr}):`);
  console.log(`  delegator stakeBase node ${SOURCE_NODE} = ${fmt(baseBefore)} (+ pending ${fmt(pendingBefore)}) TRAC`);
  console.log(`  node ${SOURCE_NODE} stake = ${fmt(nodeBefore)} | total = ${fmt(totalBefore)} TRAC`);
  if (baseBefore + pendingBefore === 0n) throw new Error('Delegator has no V8 stake on the fork — wrong block/address?');

  // ---- 2. deploy the 3 new contracts onto the REAL Hub ----
  console.log('\nDeploying migration contracts onto the forked Hub:');
  const cssAddr = await deploy('ConvictionStakingStorage', funder);
  const stakingV10Addr = await deploy('StakingV10', funder);
  const wrapperAddr = await deploy('DKGStakingConvictionNFT', funder);

  // ---- 3. register them in the Hub (impersonated owner) ----
  console.log('\nRegistering in Hub (as owner):');
  for (const [n, a] of [
    ['ConvictionStakingStorage', cssAddr],
    ['StakingV10', stakingV10Addr],
    ['DKGStakingConvictionNFT', wrapperAddr],
  ] as const) {
    await (await hub.connect(owner).setContractAddress(n, a)).wait();
    console.log(`  ${n} ✓ isContract=${await hub.isContract(a)}`);
  }

  // ---- 4. initialize (owner-gated). Register-all-first so lookups resolve. ----
  console.log('\nInitializing:');
  const css = await ethers.getContractAt('ConvictionStakingStorage', cssAddr);
  const stakingV10 = await ethers.getContractAt('StakingV10', stakingV10Addr);
  const wrapper = await ethers.getContractAt('DKGStakingConvictionNFT', wrapperAddr);
  await (await (css as any).connect(owner).initialize()).wait();
  console.log('  CSS.initialize ✓ (tiers seeded)');
  await (await (stakingV10 as any).connect(owner).initialize()).wait();
  console.log('  StakingV10.initialize ✓ (12 deps resolved)');
  await (await (wrapper as any).connect(owner).initialize()).wait();
  console.log('  wrapper.initialize ✓');

  // ---- 4b. re-point the CSS consumers at the fresh CSS (PR #1192 [14]) ----
  // Ask / ShardingTable / RandomSampling cache the CSS address in their own
  // initialize(); deploying a fresh CSS leaves those caches stale, so allocate's
  // tail would read the OLD CSS. Re-init re-reads it — but only works if the
  // on-chain contract is conviction-aware (has the CSS pointer); a pre-conviction
  // version can't be re-wired and the allocate tail won't be faithful here.
  console.log('\nRe-pointing CSS consumers at the fresh CSS:');
  for (const n of ['Ask', 'ShardingTable', 'RandomSampling']) {
    try {
      const c = await ethers.getContractAt(n, await hub.getContractAddress(n));
      await (await (c as any).connect(owner).initialize()).wait();
      let ptr: string | undefined;
      try {
        ptr = await (c as any).convictionStakingStorage();
      } catch {
        ptr = undefined;
      }
      console.log(
        ptr && ptr.toLowerCase() === cssAddr.toLowerCase()
          ? `  ${n}.initialize ✓ (re-read CSS)`
          : `  ⚠️  ${n} is PRE-CONVICTION — allocate's active-set tail is NOT faithful unless a conviction-aware ${n} is deployed here`,
      );
    } catch (e: any) {
      console.log(`  ${n} re-point skipped (${e?.shortMessage ?? 'not registered'})`);
    }
  }

  // ---- 5. set the conviction lock-credit (universal 6/12; no eligibility/freeze) ----
  console.log('\nSetting the conviction lock-credit (as owner):');
  await (await (wrapper as any).connect(owner).setConvictionCreditSeconds(CREDIT_SECONDS)).wait();
  console.log(`  convictionCreditSeconds = ${CREDIT_SECONDS} (${Number(CREDIT_SECONDS) / 86400}d) ✓`);

  // ---- 6. THE REHEARSAL: ADMIN drains the delegator → the delegator allocates ----
  console.log(`\n=== Rehearsal: Hub owner admin-drains ${DELEGATOR}, then it allocates ===`);
  const w = (wrapper as any).connect(delegator);

  // Admin-push: the impersonated Hub owner drains the delegator's V8 stake into
  // ITS migration credit (no self-service startMigration in the admin-push model).
  const adminW = (wrapper as any).connect(owner);
  const credited: bigint = await adminW.adminMigrateToCredit.staticCall(DELEGATOR, [SOURCE_NODE]);
  await (await adminW.adminMigrateToCredit(DELEGATOR, [SOURCE_NODE])).wait();
  const credBal: bigint = await (wrapper as any).migrationCredit(DELEGATOR);
  console.log(`adminMigrateToCredit(${DELEGATOR}, [${SOURCE_NODE}]) → credited ${fmt(credited)} TRAC`);
  console.log(`  migrationCredit=${fmt(credBal)}`);

  // V8 must be drained; TRAC moved SS→CSS (collateralization invariant)
  const baseAfter: bigint = await ss.getDelegatorStakeBase(SOURCE_NODE, v8Key);
  const totalAfter: bigint = await ss.getTotalStake();
  console.log(`  V8 stakeBase after = ${fmt(baseAfter)} (was ${fmt(baseBefore)})`);
  console.log(`  V8 total after = ${fmt(totalAfter)} (Δ ${fmt(totalAfter - totalBefore)})`);

  const tokenId: bigint = await w.allocate.staticCall(TARGET_NODE, credBal, LOCK_TIER);
  await (await w.allocate(TARGET_NODE, credBal, LOCK_TIER)).wait();
  const nftOwner: string = await (wrapper as any).ownerOf(tokenId);
  const nodeV10: bigint = await (css as any).nodeStakeV10(TARGET_NODE).catch(() => -1n);
  console.log(`\nallocate(node ${TARGET_NODE}, ${fmt(credBal)}, tier ${LOCK_TIER}) → tokenId ${tokenId}`);
  console.log(`  NFT owner = ${nftOwner} ${nftOwner.toLowerCase() === DELEGATOR.toLowerCase() ? '✓' : '✗'}`);
  console.log(`  remaining credit = ${fmt(await (wrapper as any).migrationCredit(DELEGATOR))} (expect 0)`);
  if (nodeV10 >= 0n) console.log(`  CSS nodeStakeV10(${TARGET_NODE}) = ${fmt(nodeV10)} TRAC`);

  // ---- assertions ----
  const checks: [string, boolean][] = [
    ['V8 stake fully drained', baseAfter === 0n],
    ['credit == drained (base + pending)', credited === baseBefore + pendingBefore],
    ['V8 total drops by active base (pending was already excluded from total)', totalBefore - totalAfter === baseBefore],
    ['NFT minted to delegator', nftOwner.toLowerCase() === DELEGATOR.toLowerCase()],
    ['credit fully spent', (await (wrapper as any).migrationCredit(DELEGATOR)) === 0n],
  ];
  console.log('\n--- assertions ---');
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    ok &&= pass;
  }
  console.log(ok ? '\n✅ FORK REHEARSAL PASSED — real bytecode, real stake, real active set' : '\n❌ FORK REHEARSAL FAILED');
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('\n❌ rehearsal reverted:', e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
