// =============================================================================
// mirror-mainnet-delegator.ts — OT-RFC-50 testnet rehearsal helper
// =============================================================================
//
// Replicates ONE real mainnet V8 delegator's position onto a target deployment
// (local hardhat node or Base Sepolia) so the real wallet can rehearse the full
// pool-and-allocate migration with genuine data:
//   1. read the delegator's V8 stake across nodes from a SOURCE mainnet V8
//      StakingStorage (Base freeze Hub or Gnosis),
//   2. seed the same amounts into the TARGET StakingStorage (mint test-TRAC +
//      write the slots) under the same identityIds,
//   3. set convictionCreditSeconds (universal tier-6/12 lock-credit, rev 5),
//   4. admin-drain the seeded stake into the wallet's migration credit
//      (adminDrainBatch). The wallet then only runs allocate(...) — it never
//      self-migrates (startMigration was removed under the admin-push model).
//
// Run (against whatever HRE network is selected):
//   DELEGATOR=0x<realMainnetDelegator> \
//   TARGET_DELEGATOR=0x<yourTestnetWallet>   # optional; defaults to DELEGATOR \
//   SOURCE_RPC=https://<mainnet-rpc> SOURCE_STAKING_STORAGE=0x<v8 SS> \
//   [LAST_IDENTITY_ID=80] [CREDIT_SECONDS=6048000] \
//   npx hardhat run scripts/mirror-mainnet-delegator.ts --network <target>
//
// accounts[0] MUST be the target Hub owner (the deployer on a fresh deploy):
// the StakingStorage seed setters are `onlyContracts` (owner is allowed through
// HubDependent._checkHubContract) and the credit/drain calls are owner-gated.
// The script asserts this up front. On a public testnet you cannot sign as a
// scanned mainnet address, so set TARGET_DELEGATOR to a wallet you control.

import { ethers as ethersLib } from 'ethers';
import hre from 'hardhat';

// DELEGATOR = whose REAL mainnet V8 position to read (the data source).
// TARGET_DELEGATOR = the wallet the data is mirrored UNDER on the testnet and
//   that will sign allocate (the admin drains it; it never self-migrates).
//   Defaults to DELEGATOR. On a public
//   testnet you cannot sign as a scanned mainnet address, so set
//   TARGET_DELEGATOR to a wallet you control and seed the real shape under it.
const DELEGATOR = process.env.DELEGATOR!;
const TARGET_DELEGATOR = process.env.TARGET_DELEGATOR ?? DELEGATOR;
const SOURCE_RPC = process.env.SOURCE_RPC!;
const SOURCE_SS = process.env.SOURCE_STAKING_STORAGE!;
const LAST_IDENTITY_ID = Number(process.env.LAST_IDENTITY_ID ?? '80');
const CREDIT_SECONDS = BigInt(process.env.CREDIT_SECONDS ?? String(70 * 24 * 60 * 60)); // default 70d

const SS_READ_ABI = [
  'function getDelegatorStakeBase(uint72 identityId, bytes32 delegatorKey) view returns (uint96)',
  'function getDelegatorWithdrawalRequestAmount(uint72 identityId, bytes32 delegatorKey) view returns (uint96)',
];

function delegatorKey(addr: string): string {
  return ethersLib.keccak256(ethersLib.solidityPacked(['address'], [addr]));
}

async function main() {
  if (!DELEGATOR || !SOURCE_RPC || !SOURCE_SS) {
    throw new Error('Set DELEGATOR, SOURCE_RPC and SOURCE_STAKING_STORAGE env vars.');
  }
  const srcKey = delegatorKey(DELEGATOR);
  const tgtKey = delegatorKey(TARGET_DELEGATOR);
  console.log(`Reading real V8 position of ${DELEGATOR} (key ${srcKey.slice(0, 10)}…)`);
  if (TARGET_DELEGATOR.toLowerCase() !== DELEGATOR.toLowerCase()) {
    console.log(`Mirroring it UNDER ${TARGET_DELEGATOR} on the target (the signer wallet)`);
  }
  console.log(`  source V8 StakingStorage ${SOURCE_SS} via ${SOURCE_RPC.slice(0, 40)}…`);

  // ---- 1. read the delegator's V8 positions from the source mainnet ----
  const src = new ethersLib.JsonRpcProvider(SOURCE_RPC);
  const srcSS = new ethersLib.Contract(SOURCE_SS, SS_READ_ABI, src);
  const positions: { id: number; base: bigint; pending: bigint }[] = [];
  for (let id = 1; id <= LAST_IDENTITY_ID; id++) {
    const [base, pending] = await Promise.all([
      srcSS.getDelegatorStakeBase(id, srcKey) as Promise<bigint>,
      srcSS.getDelegatorWithdrawalRequestAmount(id, srcKey) as Promise<bigint>,
    ]);
    if (base > 0n || pending > 0n) positions.push({ id, base, pending });
  }
  if (positions.length === 0) {
    throw new Error(`No V8 stake found for ${DELEGATOR} on ${SOURCE_SS} over ids 1..${LAST_IDENTITY_ID}.`);
  }
  const total = positions.reduce((s, p) => s + p.base + p.pending, 0n);
  console.log(`  found ${positions.length} node(s); total ${ethersLib.formatEther(total)} TRAC`);
  positions.forEach((p) =>
    console.log(`    node ${p.id}: base ${ethersLib.formatEther(p.base)} + pending ${ethersLib.formatEther(p.pending)} TRAC`),
  );

  // ---- 2-4. seed the target + set credit + admin-drain ----
  const [admin] = await hre.ethers.getSigners();
  // base_sepolia_v10 sets saveDeployments:false, so a standalone `hardhat run`
  // can't resolve contracts via getContract(). Accept address overrides from
  // the `pnpm deploy:testnet` output; fall back to getContract() (localhost).
  const resolve = async (name: string, envVar: string) => {
    const addr = process.env[envVar];
    return addr ? hre.ethers.getContractAt(name, addr) : hre.ethers.getContract(name);
  };
  const SS = await resolve('StakingStorage', 'TARGET_SS');
  const Token = await resolve('Token', 'TARGET_TOKEN');
  const NFT = await resolve('DKGStakingConvictionNFT', 'TARGET_NFT');

  // The seed setters are `onlyContracts`, but HubDependent._checkHubContract
  // lets `hub.owner()` through. setConvictionCreditSeconds / adminDrainBatch are
  // `onlyOwnerOrMultiSigOwner`. So the signer MUST be the Hub owner — assert it
  // now and fail fast rather than reverting mid-seed.
  const Hub = await resolve('Hub', 'TARGET_HUB');
  const hubOwner: string = await (Hub as any).owner();
  if (hubOwner.toLowerCase() !== (await admin.getAddress()).toLowerCase()) {
    throw new Error(
      `Signer ${await admin.getAddress()} is not the Hub owner (${hubOwner}). ` +
        `Run with the deployer/Hub-owner key as accounts[0].`,
    );
  }

  // Fund the target StakingStorage vault with base + pending test-TRAC so the
  // drain's `transferStake` (SS→CSS) has tokens to move (the vault physically
  // holds the active base AND the pending-withdrawal TRAC; only base is in
  // node/total stake, matching V8 accounting). The deploy grants the deployer
  // MINTER_ROLE + 10M TRAC only in `environment: 'development'`; on a
  // `testnet`/`mainnet` deploy the Token pre-exists, so fall back to a transfer
  // from the deployer's balance, else fail clearly.
  const activeBase = positions.reduce((s, p) => s + p.base, 0n);
  const activePending = positions.reduce((s, p) => s + p.pending, 0n);
  const toBack = activeBase + activePending;
  const ssAddr = await SS.getAddress();
  const adminAddr = await admin.getAddress();
  const haveInVault: bigint = await (Token as any).balanceOf(ssAddr);
  if (toBack > haveInVault) {
    const need = toBack - haveInVault;
    const minterRole: string = await (Token as any).MINTER_ROLE();
    if (await (Token as any).hasRole(minterRole, adminAddr)) {
      await (await (Token as any).connect(admin).mint(ssAddr, need)).wait();
      console.log(`  minted ${ethersLib.formatEther(need)} TRAC into the vault (deployer has MINTER_ROLE)`);
    } else if (((await (Token as any).balanceOf(adminAddr)) as bigint) >= need) {
      await (await (Token as any).connect(admin).transfer(ssAddr, need)).wait();
      console.log(`  transferred ${ethersLib.formatEther(need)} TRAC into the vault from the deployer`);
    } else {
      throw new Error(
        `Cannot fund StakingStorage vault with ${ethersLib.formatEther(need)} TRAC: ` +
          `deployer ${adminAddr} lacks MINTER_ROLE and has insufficient Token balance. ` +
          `Deploy in 'development' mode (mints 10M to the deployer + grants MINTER_ROLE) or pre-fund the vault.`,
      );
    }
  }

  const nowTs = BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp);
  for (const p of positions) {
    if (p.base > 0n) {
      await (await (SS as any).connect(admin).increaseDelegatorStakeBase(p.id, tgtKey, p.base)).wait();
      await (await (SS as any).connect(admin).increaseNodeStake(p.id, p.base)).wait();
      await (await (SS as any).connect(admin).increaseTotalStake(p.base)).wait();
    }
    if (p.pending > 0n) {
      // Replicate the pending V8 withdrawal request faithfully (D8): the TRAC is
      // already in the vault (funded above) but is excluded from node/total
      // stake, exactly as V8 records it. The admin drain absorbs it into credit.
      await (
        await (SS as any).connect(admin).createDelegatorWithdrawalRequest(p.id, tgtKey, p.pending, 0, nowTs)
      ).wait();
    }
  }
  console.log(
    `  seeded ${ethersLib.formatEther(activeBase)} TRAC active base` +
      (activePending > 0n ? ` + ${ethersLib.formatEther(activePending)} TRAC pending withdrawal` : '') +
      ` into the target StakingStorage`,
  );

  // Set the conviction lock-credit (universal on tier 6/12, rev 5 — no
  // eligibility registry). Owner-gated.
  const ids = positions.map((p) => p.id);
  await (await (NFT as any).connect(admin).setConvictionCreditSeconds(CREDIT_SECONDS)).wait();
  console.log(`  set convictionCreditSeconds = ${CREDIT_SECONDS} (${Number(CREDIT_SECONDS) / 86400}d)`);

  // ---- admin-push: drain the wallet's seeded V8 stake into ITS migration
  //      credit (OT-RFC-50) via adminDrainBatch over the flattened
  //      (delegator,node) pairs — the same primary path production runs at scale. ----
  const delegators = ids.map(() => TARGET_DELEGATOR);
  await (await (NFT as any).connect(admin).adminDrainBatch(delegators, ids)).wait();
  const credit: bigint = await (NFT as any).migrationCredit(TARGET_DELEGATOR);
  console.log(`  admin-drained ${TARGET_DELEGATOR} → migrationCredit ${ethersLib.formatEther(credit)} TRAC`);
  console.log(`\n✅ Mirror + admin drain complete. ${TARGET_DELEGATOR} now only ALLOCATES:`);
  console.log(`   allocate(<liveTargetNode>, amount, tier)   — no startMigration (already drained)`);
  console.log(`   <liveTargetNode> must be an EXISTING profile on this target`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
