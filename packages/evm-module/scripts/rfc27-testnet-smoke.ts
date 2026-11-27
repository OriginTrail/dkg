// =============================================================================
// rfc27-testnet-smoke.ts — the OT-RFC-27 marketplace smoke test on Base
// Sepolia, after the deploy, with real signers and real time
// =============================================================================
//
// One marketplace cycle on the live contracts, across one epoch boundary,
// playing every role:
//   - the owner, a hot testnet wallet with Base Sepolia ETH and test TRAC,
//     opens a new Conviction Account under PublishingConviction 10.2.0 (an
//     account opened under 10.0.8 cannot buy services), opts it in, grants a
//     buyer, funds a wallet-paid subscription, stakes a small position on the
//     seller's node, so that the pool share is checked on a position it
//     controls, and makes the upkeep calls;
//   - the buyer funds a Conviction Account subscription and tops it up;
//   - the session keys sign the requests;
//   - the seller, one of our testnet Core Nodes, submits them as receipt
//     batches from one of its operational keys.
// The buyers and the session keys are derived from the owner key and the
// run label, keccak256(ownerKey ‖ "rfc27-smoke/<run>/<role>") as an HD seed,
// so no key is ever stored. No step is a Hub owner action.
//
// Usage, from packages/evm-module, on Base Sepolia once the deploy and the Hub
// owner's two transactions are in (scripts/RFC27_TESTNET_DEPLOY_RUNBOOK.md):
//
//   export RFC27_SMOKE_OWNER_KEY=...    # the owner's key: never printed, never stored
//   export RFC27_SMOKE_SELLER_KEY=...   # an operational key of the seller node
//   export RFC27_SMOKE_RUN=smoke-1      # the run label: names the state file, derives the keys
//   export RPC_BASE_SEPOLIA_V10=...     # optional, https://sepolia.base.org when unset; never printed
//   SMOKE="npx hardhat run scripts/rfc27-testnet-smoke.ts --network base_sepolia_v10 --config hardhat.node.config.ts"
//
//   PHASE=check $SMOKE                  # read-only, then the plan; also shows a run's progress
//   PHASE=setup $SMOKE                  # without SEND=1 every phase is a dry run
//   PHASE=setup SEND=1 $SMOKE           # epoch E, with at least an hour of it left
//   PHASE=serve SEND=1 $SMOKE           # still in epoch E, once the seller has proved in E: a batch lands only then
//   PHASE=claim SEND=1 $SMOKE           # from the start of E+1, with nothing run first
//   PHASE=withdraw SEND=1 $SMOKE        # optional: in the middle of an epoch after claim,
//   PHASE=withdraw SEND=1 $SMOKE        #   then again once that epoch has ended
//
// What each phase does and checks is in its module, scripts/rfc27/smoke/. A
// phase that opens later is deferred with the time it opens; serve waits, and
// says so, while the seller has not proved in E (a batch reverts NoNodeScore until
// it has), and is run again after the node's next proof, before E ends; withdraw
// waits likewise until the position holds score in the epoch, as a withdrawal
// without it would burn the position and record nothing to claim.
//
// Amounts, in TRAC: RFC27_SMOKE_STAKE (50), RFC27_SMOKE_CA_VALUE (3),
// RFC27_SMOKE_CA_TOPUP (1), RFC27_SMOKE_EDGE_VALUE (0.5),
// RFC27_SMOKE_WALLET_VALUE (2), RFC27_SMOKE_COMMITTED (by default the lock
// times the first window's spends, rounded up, plus 1 TRAC a window; there is
// no contract minimum, and the floor is the lock times those spends), and
// RFC27_SMOKE_KEY_ETH, the ETH the owner sends each derived buyer (0.0002,
// or what its gas needs at the current fee if more). Setup records them; later
// phases read them from the state file.
//
// The upkeep cron may call claimFor or claimWithdrawnEpoch first. Each phase
// detects that, and checks what the other caller did, from storage and recorded
// events, instead of failing.
//
// Output: every check as PASS or FAIL, and the results in
// cache/rfc27-smoke/<run>.<phase>.json (.dry-run.json for a dry run). A run
// resumes from cache/rfc27-smoke/<run>.json, which git ignores: ids, epochs,
// addresses and transaction hashes, never a key, bound to its network.
//
// Resuming: a phase stopped at any point is run again as it was. A transaction
// the journal holds is not sent again, and its checks read what it did from its
// own receipt. A resumed setup needs only what its remaining
// steps will spend. A phase with a failed check is not done: it exits nonzero, the
// phases after it refuse to start, and running it again sends nothing it sent
// already, until its checks pass.
//
// Safety:
//   - Dry run by default: each transaction is simulated with eth_estimateGas
//     and printed; only SEND=1 sends. A transaction that needs an earlier one
//     the dry run did not send is listed, not simulated.
//   - The chain guard: chain id 84532 only, Base Sepolia or a local anvil fork
//     of it on 127.0.0.1; mainnet chain ids are refused by name, every other
//     chain too. Time travel, impersonation and the balance setters run only
//     on that fork.
//   - No key and no RPC URL is printed or written: all output is redacted.
//   - Gas: each transaction's estimate, its smallest gas limit, must fit under
//     Base's per-transaction cap of 2^24, or its check fails and it is not
//     sent; the limit is set by hand, the estimate plus a quarter and 50,000,
//     always under 2^24.
//
// On a local anvil fork, before the contracts are on testnet: fork Base
// Sepolia, deploy the stack and run the rehearsal's hub phase, as in
// scripts/rfc27-testnet-fork-rehearsal.ts, then run the phases with
//   --network base_sepolia_v10 --config scripts/rfc27-testnet-fork.config.ts
// and RFC27_SMOKE_SELLER_ADDRESS, the operational address of a real node to
// impersonate (or RFC27_SMOKE_SELLER_ID, found from its recent proofs). Two
// fork-only switches stand in for the testnet days: FORK_WARP=1 moves the
// clock to the first moment a phase may run, and FORK_PROOFS=1 writes the
// seller's proofs where the real node would have proved, through the contract
// the Hub holds as RandomSampling, impersonated (a fork cannot produce a
// proof). Without RFC27_SMOKE_OWNER_KEY the owner is an impersonated address,
// and the derived keys come from a fork-only seed; the owner's ETH and TRAC
// and the seller's ETH come from anvil's balance setters. Both switches and the
// setters act with SEND=1 only: a dry run changes nothing on the fork, and says
// what it would have stood in for. FORK_STOP_AFTER=<step>, or <step>:sent, ends
// the process right after the journal records that step, as a crash would, to
// resume from (test/rfc27-smoke-resume.test.ts does the same with no fork).

import * as fs from 'fs';
import * as path from 'path';

import hre from 'hardhat';

import { Stack, decodeError, errorData, errorMessage } from './rfc27/contracts';
import { Fork } from './rfc27/fork';
import { guardNetwork } from './rfc27/network';
import { Redactor, Report, iso, span } from './rfc27/report';
import { deployed, phaseCheck } from './rfc27/smoke/check';
import { phaseClaim } from './rfc27/smoke/claim';
import { LIVE_JSON, RESULTS_DIR, SmokeEnv, readEnv } from './rfc27/smoke/config';
import { Ctx, withPool } from './rfc27/smoke/context';
import { roles } from './rfc27/smoke/roles';
import { phaseServe } from './rfc27/smoke/serve';
import { phaseSetup } from './rfc27/smoke/setup';
import { StateFile } from './rfc27/smoke/state';
import { SmokeTx, stoppingAt } from './rfc27/smoke/tx';
import { phaseWithdraw } from './rfc27/smoke/withdraw';

const redactor = new Redactor();
const report = new Report(redactor);
let env: SmokeEnv | undefined;
let guarded = false;
let part = '';

async function main(): Promise<void> {
  env = readEnv();
  const net = await guardNetwork(hre, redactor);
  guarded = true;
  if (!net.local && (env.warp || env.proofs || env.stopAfter)) throw new Error('refusing to run: FORK_WARP, FORK_PROOFS and FORK_STOP_AFTER are for the local fork only');
  const block = await hre.ethers.provider.getBlock('latest');
  if (!block) throw new Error('no latest block');
  report.set('network', { name: net.name, chainId: net.chainId, client: net.client, forkBlock: net.forkBlock, block: block.number, timestamp: block.timestamp });
  report.say(`${net.name}: chain ${net.chainId}, ${net.client}, block ${block.number} at ${iso(BigInt(block.timestamp))}`);
  const flags = [env.send ? 'SEND=1: transactions are sent' : 'dry run: nothing is sent', net.local && env.warp ? 'FORK_WARP=1' : '', net.local && env.proofs ? 'FORK_PROOFS=1' : ''];
  report.say(`run "${env.run}", phase ${env.phase}, ${flags.filter(Boolean).join(', ')}`);

  // The deployment this run is on: the phases take it from the stack.
  const stack = await Stack.at(hre, (JSON.parse(fs.readFileSync(LIVE_JSON, 'utf8')) as { contracts: { Hub: { evmAddress: string } } }).contracts.Hub.evmAddress);
  const base = await stack.base();
  const current = await base.chronos.getCurrentEpoch();
  const next = await base.chronos.timestampForEpoch(current + 1n);
  report.say(`epoch ${current}, ends ${iso(next)}, in ${span(next - BigInt(block.timestamp))}; epoch length ${await base.chronos.epochLength()} s`);
  const fork = new Fork(hre, net, report);
  const file = new StateFile(env.stateFile, redactor, !env.send);
  const stop = (): never => {
    report.say(`\nFORK_STOP_AFTER=${env?.stopAfter}: stopping here, as a crash would`);
    process.exit(75);
  };
  const journal = env.stopAfter ? stoppingAt(file, env.stopAfter, stop) : file;
  const ctx: Ctx = { hre, env, net, report, stack, base, fork, file, tx: new SmokeTx(hre, report, env.send, journal), roles: await roles({ hre, fork, redactor, c: base, run: env.run }) };

  if (env.phase === 'check') return phaseCheck(ctx);
  if (!(await deployed(ctx))) throw new Error('the OT-RFC-27 contracts are not deployed yet: run PHASE=check once the deploy and the Hub owner\'s two transactions are in');
  const pool = await withPool(ctx);
  if (env.phase === 'setup') return phaseSetup(pool);
  if (env.phase === 'serve') return phaseServe(pool);
  if (env.phase === 'claim') return phaseClaim(pool);
  part = (await phaseWithdraw(pool)).part === 'claim' ? '-claim' : '';
}

main()
  .catch(async (e: unknown) => {
    const data = errorData(e);
    // A revert reads by its decoded error; a provider's message can carry raw return bytes.
    report.fail(data ? `reverted: ${await decodeError(hre, data)}` : errorMessage(e).replace(/\p{Cc}+/gu, ' '));
  })
  .finally(() => {
    report.say(`\n${report.summary()}`);
    if (report.failed || report.status === 'failed') process.exitCode = 1;
    // A phase done earlier keeps the results it wrote then. A run the chain guard refused, or
    // without a valid PHASE and run label, writes none.
    if (report.status === 'done earlier' || !env || !guarded) return;
    const dry = env.send || env.phase === 'check' ? '' : '.dry-run';
    const file = path.join(RESULTS_DIR, `${env.run}.${env.phase}${part}${dry}.json`);
    report.write(file, { phase: env.phase, run: env.run, mode: env.send ? 'send' : 'dry run' });
    report.say(`results: ${file}`);
  });
