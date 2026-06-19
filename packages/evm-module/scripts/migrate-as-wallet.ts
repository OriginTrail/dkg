// =============================================================================
// migrate-as-wallet.ts — V8→V10 testnet allocation, signed by a real wallet
// =============================================================================
//
// Runs the staker-facing half of the migration on a live testnet, signing with
// a wallet you control (TARGET_PK). Under the admin-push model the protocol has
// ALREADY drained this wallet's V8 stake into migration credit (via
// DKGStakingConvictionNFT.adminDrainBatch), so the
// user NEVER drains — they only ALLOCATE pre-populated credit:
//   allocate(targetNode, amount, lockTier)
//
// Run:
//   TARGET_NFT=0x<DKGStakingConvictionNFT> TARGET_PK=0x<delegator private key> \
//   TARGET_NODE=<existing profile id> [LOCK_TIER=12] [AMOUNT=<wei>] \
//   npx hardhat run scripts/migrate-as-wallet.ts --network base_sepolia_v10
//
// AMOUNT defaults to the full pre-populated migration credit. TARGET_NODE must
// be an EXISTING profile on the target (allocate checks it). LOCK_TIER=0 makes
// the position immediately withdrawable (the recover-to-wallet path).

import hre from 'hardhat';

const NFT_ADDR = process.env.TARGET_NFT!;
const PK = process.env.TARGET_PK!;
const TARGET_NODE = BigInt(process.env.TARGET_NODE ?? '0');
const LOCK_TIER = BigInt(process.env.LOCK_TIER ?? '12');
const AMOUNT = process.env.AMOUNT ? BigInt(process.env.AMOUNT) : undefined;

const fmt = (x: bigint) => hre.ethers.formatEther(x);

async function main() {
  if (!NFT_ADDR || !PK || TARGET_NODE === 0n) {
    throw new Error('Set TARGET_NFT, TARGET_PK and TARGET_NODE (an existing profile id).');
  }
  const wallet = new hre.ethers.Wallet(PK, hre.ethers.provider);
  const me = await wallet.getAddress();
  const w = (await hre.ethers.getContractAt('DKGStakingConvictionNFT', NFT_ADDR)).connect(wallet) as any;
  console.log(`Allocating as ${me} via wrapper ${NFT_ADDR}`);

  // ---- credit is pre-populated by the admin drain; the user only allocates ----
  const credit: bigint = await w.migrationCredit(me);
  console.log(`  migration credit ${fmt(credit)} TRAC`);
  const amount = AMOUNT ?? credit;
  if (amount === 0n) {
    throw new Error(
      'No migration credit for this wallet — has the admin drain (adminDrainBatch) run for it yet?',
    );
  }

  // ---- allocate: spend credit into a fresh conviction position ----
  const tx = await w.allocate(TARGET_NODE, amount, LOCK_TIER);
  console.log(`allocate(node ${TARGET_NODE}, ${fmt(amount)} TRAC, tier ${LOCK_TIER}) tx ${tx.hash} …`);
  const rcpt = await tx.wait();
  // Read the minted tokenId from the Allocated event — NOT a staticCall predict:
  // a concurrent allocation could consume the next id before this tx mines.
  let tokenId: bigint | undefined;
  for (const log of rcpt.logs) {
    try {
      const parsed = w.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'Allocated') {
        tokenId = parsed.args.tokenId as bigint;
        break;
      }
    } catch {
      /* not a wrapper event */
    }
  }
  if (tokenId === undefined) throw new Error('Allocated event not found in the receipt');
  const owner: string = await w.ownerOf(tokenId);
  console.log(`  minted conviction NFT tokenId ${tokenId} → owner ${owner}`);
  console.log(`  remaining credit ${fmt(await w.migrationCredit(me))}`);
  console.log(`\n✅ Allocation complete: migration credit → conviction NFT #${tokenId}`);
}

main().catch((e) => {
  console.error('\n❌ allocation reverted:', e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
