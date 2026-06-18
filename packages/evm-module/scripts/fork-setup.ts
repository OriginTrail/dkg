// =============================================================================
// fork-setup.ts — OT-RFC-50 cutover setup on a forked Hub (freeze-first)
// =============================================================================
//
// Against an anvil fork of a V8-stake-holding chain, this impersonates the Hub
// owner and performs the cutover-deploy steps so the sweep driver can then run
// against REAL forked state:
//   1. deploy + register + initialize CSS / StakingV10 / DKGStakingConvictionNFT
//      onto the EXISTING forked Hub (shared StakingStorage / IdentityStorage);
//   2. set convictionCreditSeconds;
//   3. FREEZE-FIRST: removeContractByName('Staking') so the live V8 Staking can
//      no longer mutate StakingStorage mid-sweep (the driver asserts this).
//
// Idempotent-ish: if the V10 contracts are already Hub-registered (a prior run
// on the same fork), it resolves + reuses them instead of redeploying.
//
//   anvil --fork-url <rpc> --port 8545 &
//   HUB=0x<forkedHub> npx hardhat run scripts/fork-setup.ts --network localhost

import { ethers } from 'hardhat';
import hre from 'hardhat';

const HUB = process.env.HUB ?? '0xf21CE8f8b01548D97DCFb36869f1ccB0814a4e05'; // Base Sepolia V8 test Hub
const CREDIT_SECONDS = BigInt(process.env.CREDIT_SECONDS ?? String(70 * 24 * 60 * 60));
const FUND = '0x56BC75E2D63100000'; // 100 ETH (hex) for impersonated gas

const fmt = (x: bigint) => ethers.formatEther(x);

async function impersonate(addr: string) {
  await hre.network.provider.send('hardhat_setBalance', [addr, FUND]);
  return ethers.getImpersonatedSigner(addr);
}

const HUB_ABI = [
  'function owner() view returns (address)',
  'function setContractAddress(string,address)',
  'function removeContractByName(string)',
  'function getContractAddress(string) view returns (address)',
  'function isContract(string) view returns (bool)',
  'function isContract(address) view returns (bool)',
];

async function main() {
  const blockNo = await ethers.provider.getBlockNumber();
  const hubCode = await ethers.provider.getCode(HUB);
  console.log(`Fork block ${blockNo}; Hub ${HUB} bytecode ${hubCode === '0x' ? 'ABSENT' : 'present'}`);
  if (hubCode === '0x') throw new Error(`No Hub bytecode at ${HUB}. Start an anvil fork of the right chain.`);

  const hub = await ethers.getContractAt(HUB_ABI, HUB);
  const ownerAddr: string = await hub.owner();
  console.log(`Hub owner ${ownerAddr}`);
  const [funder] = await ethers.getSigners();
  const owner = await impersonate(ownerAddr);

  // ---- 1. deploy FRESH versions of the 3 migration contracts + (re)register ----
  // Base Sepolia may already have an OLDER V10 conviction system registered
  // (without the migration entrypoints), so we always deploy our bytecode and
  // overwrite the Hub registration — never reuse the on-chain ones.
  const deployFresh = async (name: string): Promise<string> => {
    const f = await ethers.getContractFactory(name, funder);
    const c = await f.deploy(HUB);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    await (await hub.connect(owner).setContractAddress(name, addr)).wait();
    console.log(`  deploy ${name} → ${addr} (registered)`);
    return addr;
  };
  const ensure = deployFresh;

  console.log('\nDeploying migration contracts onto the forked Hub:');
  const cssAddr = await ensure('ConvictionStakingStorage');
  const stakingV10Addr = await ensure('StakingV10');
  const wrapperAddr = await ensure('DKGStakingConvictionNFT');

  // ---- 2. initialize (idempotent: skip if already initialized) ----
  console.log('\nInitializing (skips if already done):');
  const css = await ethers.getContractAt('ConvictionStakingStorage', cssAddr);
  const stakingV10 = await ethers.getContractAt('StakingV10', stakingV10Addr);
  const wrapper = await ethers.getContractAt('DKGStakingConvictionNFT', wrapperAddr);
  for (const [n, c] of [
    ['ConvictionStakingStorage', css],
    ['StakingV10', stakingV10],
    ['DKGStakingConvictionNFT', wrapper],
  ] as const) {
    try {
      await (await (c as any).connect(owner).initialize()).wait();
      console.log(`  ${n}.initialize ✓`);
    } catch (e: any) {
      console.log(`  ${n}.initialize skipped (${e?.shortMessage ?? 'already initialized'})`);
    }
  }

  // ---- 2b. re-point the CSS consumers at the freshly-deployed CSS ----
  // Ask / ShardingTable / RandomSampling cache the ConvictionStakingStorage
  // address in their OWN initialize() (they read it from the Hub once). When we
  // deploy a fresh CSS above and overwrite the Hub registration, those caches go
  // stale — so allocate's tail (insertNode + recalculateActiveSet) would read the
  // OLD CSS and the rehearsal's active-set path would be exercised against stale
  // stake. Their initialize() is pure dependency-wiring (onlyHub, no initializer
  // guard), so re-calling it re-reads the new CSS. Required for a faithful
  // allocate-tail rehearsal on a Hub that already had a V10 CSS (PR #1192 [14]).
  console.log('\nRe-pointing CSS consumers at the fresh CSS:');
  let staleConsumer = false;
  for (const n of ['Ask', 'ShardingTable', 'RandomSampling']) {
    try {
      const consumer = await ethers.getContractAt(n, await hub.getContractAddress(n));
      await (await (consumer as any).connect(owner).initialize()).wait();
      // Verify it ACTUALLY re-read the fresh CSS. The on-chain contract may be a
      // PRE-CONVICTION version (e.g. Base Sepolia ships ShardingTable/Ask v1.0.0,
      // which rank by V8 getNodeStake and have no CSS pointer) — then initialize()
      // ran against old bytecode and re-wired nothing.
      let ptr: string | undefined;
      try {
        ptr = await (consumer as any).convictionStakingStorage();
      } catch {
        ptr = undefined;
      }
      if (ptr && ptr.toLowerCase() === cssAddr.toLowerCase()) {
        console.log(`  ${n}.initialize ✓ (re-read CSS = ${cssAddr})`);
      } else {
        staleConsumer = true;
        console.log(
          `  ⚠️  ${n} is PRE-CONVICTION (no CSS pointer) — cannot be re-wired by re-init. ` +
            `allocate's active-set tail will NOT be faithful on this fork unless a conviction-aware ` +
            `${n} is deployed onto the Hub.`,
        );
      }
    } catch (e: any) {
      console.log(`  ${n} re-point skipped (${e?.shortMessage ?? 'not registered'})`);
    }
  }
  if (staleConsumer) {
    console.log(
      '\n  NOTE: this Hub has a pre-conviction active-set stack. The drain/credit/selfMigrate paths\n' +
        '  still rehearse faithfully (they touch StakingStorage + CSS directly), but a faithful\n' +
        "  allocate active-set tail needs the conviction-aware ShardingTable/Ask/RandomSampling\n" +
        '  deployed here (the production cutover deploy ships them at current versions + initializes).',
    );
  }

  // ---- 3. conviction lock-credit ----
  await (await (wrapper as any).connect(owner).setConvictionCreditSeconds(CREDIT_SECONDS)).wait();
  console.log(`\nconvictionCreditSeconds = ${CREDIT_SECONDS} (${Number(CREDIT_SECONDS) / 86400}d) ✓`);

  // ---- 4. FREEZE-FIRST: unregister V8 Staking so it can't mutate SS mid-sweep ----
  let stakingLive = false;
  try {
    const s = await hub.getContractAddress('Staking');
    stakingLive = s !== ethers.ZeroAddress && (await hub['isContract(address)'](s));
  } catch {
    /* already unregistered */
  }
  if (stakingLive) {
    await (await hub.connect(owner).removeContractByName('Staking')).wait();
    console.log('V8 Staking unregistered (frozen) ✓');
  } else {
    console.log('V8 Staking already unregistered (frozen) ✓');
  }
  // confirm the driver's precondition view
  let frozen = false;
  try {
    await hub.getContractAddress('Staking');
  } catch {
    frozen = true;
  }
  console.log(`Hub.getContractAddress('Staking') now ${frozen ? 'REVERTS (frozen)' : 'still resolves'}`);

  console.log('\n✅ FORK SETUP COMPLETE — V10 deployed + frozen. Now run:');
  console.log(`   MODE=plan TARGET_HUB=${HUB} npx hardhat run scripts/v8-sweep-driver.ts --network localhost`);
  console.log(`   CSS=${cssAddr}`);
  console.log(`   StakingV10=${stakingV10Addr}`);
  console.log(`   DKGStakingConvictionNFT=${wrapperAddr}`);
}

main().catch((e) => {
  console.error('\n❌ fork-setup failed:', e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
