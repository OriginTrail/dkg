// =============================================================================
// rfc27-testnet-fork-rehearsal.ts — OT-RFC-27 testnet deploy rehearsal on a
// LOCAL anvil fork of Base Sepolia
// =============================================================================
//
// Rehearses the testnet deploy of the OT-RFC-27 contract stack with the
// repository's own deploy pipeline, against an anvil fork of Base Sepolia, then
// drives one full marketplace cycle on the fork, and the emergency switch. Every
// write goes to the local anvil; the upstream RPC is only ever read, by anvil.
// The procedure it rehearses is scripts/RFC27_TESTNET_DEPLOY_RUNBOOK.md.
//
// The stack: ServiceSubscriptionsStorage (052c), ServiceSubscriptions and
// ServiceSubscriptionsWallet (052d), QueryInferenceStorage (052e),
// QueryInferenceSettlement (052f), StakingV10Ledger (054a) and
// ConvictionWithdrawalStorage (054b) are new; PublishingConviction moves to
// 10.2.0, StakingV10 to 10.1.0 (055) and StakingKPI to 10.1.0 (024); 998
// registers and initializes everything in one Hub transaction, and 998b
// leaves the activation epoch to the Hub owner, after it.
//
// Why an external anvil fork: Hardhat's in-process fork has no Base hardfork
// history (see scripts/fork-rehearsal.ts). The deploy pipeline runs through
// scripts/rfc27-testnet-fork.config.ts, which keeps the network name
// `base_sepolia_v10` and the `testnet` environment, hard-codes the URL to the
// local anvil and uses anvil's remote accounts, so no key is involved. The
// deployer is anvil's first development account, which is not the Hub owner:
// 998 then prints the Hub transaction, decoded, and the `hub` phase sends it
// as the impersonated Hub owner. The config never writes the tracked
// deployments file: each deploy reads and writes a scratch copy,
// cache/rfc27-fork/deployments/base_sepolia_v10_contracts.json, seeded from the
// tracked file when the deploy starts, and fails if the tracked file changed.
//
// Usage (from packages/evm-module; unset every *BASE_SEPOLIA* / *PRIVATE_KEY* /
// *MNEMONIC* variable first, e.g. with `env -u`):
//
//   anvil --fork-url <base-sepolia-rpc> --fork-block-number <N> --host 127.0.0.1 --port 8545 &
//   CFG=scripts/rfc27-testnet-fork.config.ts
//   RUN="npx hardhat run scripts/rfc27-testnet-fork-rehearsal.ts --network base_sepolia_v10 --config $CFG"
//
//   # 1. what the live contracts do before the upgrade, inside a reverted snapshot
//   PHASE=pre $RUN
//
//   # 2. the real deploy pipeline. REDEPLOY lists the entries the scratch copy
//   #    marks not deployed, which is how the three upgrades are redeployed, as
//   #    the deploy's first step, 000, asks.
//   #    2a. the guard: with StakingV10 left deployed, 000 refuses the run, before it deploys anything
//   REDEPLOY=PublishingConviction,StakingKPI npx hardhat deploy --network base_sepolia_v10 --config $CFG  # fails
//   #    2b. the real run
//   REDEPLOY=PublishingConviction,StakingV10,StakingKPI npx hardhat deploy --network base_sepolia_v10 \
//     --config $CFG | tee cache/rfc27-fork/deploy.log
//
//   # 3. optional: the Hub owner's two transactions sent with cast as the
//   #    runbook sends them, from the impersonated Hub owner (`--unlocked` in
//   #    place of the hardware wallet), inside a snapshot that is reverted, so
//   #    the hub phase sends them again
//   R=http://127.0.0.1:8545
//   HUB=$(node -p "require('./deployments/base_sepolia_v10_contracts.json').contracts.Hub.evmAddress")
//   OWNER=$(cast call $HUB 'owner()(address)' -r $R)
//   DATA=$(sed -n 's/.*Hub owner transaction (JSON): //p' cache/rfc27-fork/deploy.log | node -p 'JSON.parse(require("fs").readFileSync(0)).data')
//   SNAP=$(cast rpc evm_snapshot -r $R)
//   cast rpc anvil_impersonateAccount $OWNER -r $R; cast rpc anvil_setBalance $OWNER 0x56BC75E2D63100000 -r $R
//   cast call $HUB --data $DATA --from $OWNER -r $R
//   cast send $HUB --data $DATA --from $OWNER --unlocked --gas-limit 4000000 -r $R
//   QIS=$(cast call $HUB 'getContractAddress(string)(address)' QueryInferenceStorage -r $R)
//   CHRONOS=$(cast call $HUB 'getContractAddress(string)(address)' Chronos -r $R)
//   ACT=$(cast calldata 'setActivationEpoch(uint40)' $(( $(cast call $CHRONOS 'getCurrentEpoch()(uint256)' -r $R | cut -d' ' -f1) + 1 )))
//   cast call $HUB 'forwardCall(address,bytes)' $QIS $ACT --from $OWNER -r $R
//   cast send $HUB 'forwardCall(address,bytes)' $QIS $ACT --from $OWNER --unlocked --gas-limit 200000 -r $R
//   cast rpc evm_revert $SNAP -r $R
//
//   # 4. the activation refused before the Hub transaction (and, in a reverted
//   #    snapshot, while the settlement or StakingV10 does not read the pool),
//   #    then the Hub owner's transaction 998 printed, then the activation;
//   #    each with its smallest gas limit, and the Hub's contract order after it
//   PHASE=hub DEPLOY_LOG=cache/rfc27-fork/deploy.log $RUN
//
//   # 5. the emergency switch, off and on again, inside a reverted snapshot:
//   #    the settlement removed by name and the storage paused, then a fresh
//   #    settlement registered; and a removal of the Hub's last entry, by
//   #    address and by name
//   PHASE=switch $RUN
//
//   # 6. existing accounts and positions after the upgrade, with every
//   #    position's first-claim gas and the longest history's withdrawal gas;
//   # 7. one full cycle: a batch refused before its seller proves in the epoch;
//   #    a budget's funding overrun, with the first batch landed counting whole
//   #    and a later one what is left; a minimum that refuses less, and a top-up
//   #    that lifts it; a withdrawal in the middle of an epoch, its payout against
//   #    the views, and its claimWithdrawnEpoch; the claims of the next epoch, with
//   #    nothing run first; and the settlement removed in a reverted snapshot;
//   # 8. an account untouched for several epochs, booked late;
//   # 9. the money, value, pool and unused share of every ended epoch, read from
//   #    storage against the rollover rule, and, in a reverted snapshot, a sale
//   #    after a long quiet spell, whose pool walks the whole run back
//   PHASE=existing $RUN
//   PHASE=cycle $RUN
//   PHASE=late-booking $RUN
//   PHASE=unused $RUN
//
// Each phase writes cache/rfc27-fork/<phase>.json (REHEARSAL_DIR overrides the
// directory) and reads what the earlier phases wrote, decoded and checked
// where it is loaded (scripts/rfc27/rehearsal/results.ts). The switch phase
// follows the hub phase directly, before the activation epoch ends, and
// reverts all it does. A phase that fails, by an error or a failed check, leaves
// the fork as it found it, so it can run again: each runs in a snapshot that stays
// only if it succeeds, and the snapshots inside it are reverted however it ends. A
// later phase refuses the results file of a phase that failed its checks.
// REHEARSAL_FAIL_AT=<part of a transaction's label> makes a phase fail just
// before that transaction, which shows it.
//
// The phases live in scripts/rfc27/rehearsal/, one module each, on the script
// support of scripts/rfc27/ that the smoke test shares: the contracts through
// the Hub, the chain guard, the fork-only stand-ins, the report, and the
// transaction runner. The shapes, digests and builders of requests, receipts
// and subscriptions, and the emission model, are test/helpers'.
//
// Fork-only shortcuts, each named where it is taken:
//   - the Hub owner, the KnowledgeAssetsLifecycle contract, RandomSampling,
//     node operational keys and position owners are impersonated;
//   - the KnowledgeAssetsLifecycle impersonation calls the publishing NFT's
//     `coverPublishingCost` as a publish would, without the publish's node
//     signatures;
//   - node scores for the epochs after the fork are written through the
//     contract the Hub holds as RandomSampling, as a valid proof writes them
//     (the proofs themselves cannot be produced on a fork), each node scoring
//     what it scored in the last full epoch before the fork; each such proof
//     is listed as a stand-in, not among the phase's transactions;
//   - test buyers get their TRAC from the Hub owner's balance;
//   - an anvil account is added as an admin key of the first seller, through
//     the contract the Hub holds as Identity, so that its operator fee can be
//     set through Profile.updateOperatorFee and withdrawn through
//     StakingV10Ledger (every testnet node charges 0 %).
// anvil does not enforce EIP-7825's 2^24 per-transaction gas cap, which Base
// Sepolia does. So every transaction goes through the shared runner
// (scripts/rfc27/tx.ts): its estimate, the smallest gas limit it goes through
// with, must fit under 2^24, or that check fails, the transaction is not sent
// and the phase exits nonzero; it is sent with the estimate plus a quarter and
// 50,000 as its gas limit, a margin anvil's estimates need (they have come out
// a few thousand gas short where a call's 63/64 forwarding meets storage
// refunds). The gas used, which the phases report, does not depend on it.

import hre from 'hardhat';

import { decodeError, errorData, errorMessage } from './rfc27/contracts';
import { rpc } from './rfc27/network';
import { Redactor, Report } from './rfc27/report';
import { Ctx, createContext } from './rfc27/rehearsal/context';
import { phaseCycle } from './rfc27/rehearsal/cycle';
import { phaseExisting } from './rfc27/rehearsal/existing';
import { phaseHub } from './rfc27/rehearsal/hub';
import { phaseLateBooking } from './rfc27/rehearsal/late-booking';
import { phasePre } from './rfc27/rehearsal/pre';
import { phaseSwitch } from './rfc27/rehearsal/switch';
import { phaseUnused } from './rfc27/rehearsal/unused';

const PHASES: Readonly<Record<string, (ctx: Ctx) => Promise<void>>> = {
  pre: phasePre,
  hub: phaseHub,
  switch: phaseSwitch,
  existing: phaseExisting,
  cycle: phaseCycle,
  'late-booking': phaseLateBooking,
  unused: phaseUnused,
};

const PHASE = process.env.PHASE ?? '';
const report = new Report(new Redactor());

async function main(): Promise<void> {
  const run = Object.prototype.hasOwnProperty.call(PHASES, PHASE) ? PHASES[PHASE] : undefined;
  if (!run) throw new Error(`set PHASE to ${Object.keys(PHASES).join(', ')}`);
  report.say(`client ${String(await rpc(hre, 'web3_clientVersion'))}, chain ${BigInt(String(await rpc(hre, 'eth_chainId')))}, phase ${PHASE}`);
  const ctx = await createContext(hre, report);
  await ctx.fork.undoIfFailed(() => run(ctx), () => report.failed > 0);
}

main()
  .catch(async (e: unknown) => {
    const data = errorData(e);
    report.fail(data ? `reverted: ${await decodeError(hre, data)}` : errorMessage(e));
  })
  .finally(() => {
    report.say(`\n${report.summary()}`);
    if (report.failed || report.status === 'failed') process.exitCode = 1;
  });
