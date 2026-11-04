// The OT-RFC-27 smoke test's phases, interrupted and resumed, on the real
// contracts of the development deploy: the phases themselves, with their real
// runner, journal and state file, on the in-process chain. An interruption is the
// journal stopping the run right after it records a step, as a crash would; a
// resume is a new runner, report and state file over what that left behind. No
// fork or network is needed: the run is `npx hardhat test
// test/rfc27-smoke-resume.test.ts --network hardhat --config hardhat.node.config.ts`.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import type { Signer, TransactionRequest } from 'ethers';
import hre from 'hardhat';

import { CLASS_INFERENCE, TRAC, bucket, walletRequestOf } from './helpers/conviction-service';
import { hardhatWallet, queryInferenceDomain } from './helpers/query-inference';
import { deployRewardsStack, rewardsHelpers } from './helpers/query-inference-rewards';
import { Contracts, Stack } from '../scripts/rfc27/contracts';
import { Fork } from '../scripts/rfc27/fork';
import { Redactor, Report, fmt } from '../scripts/rfc27/report';
import { phaseCheck } from '../scripts/rfc27/smoke/check';
import { phaseCloseClaim } from '../scripts/rfc27/smoke/close-claim';
import { NOTHING_YET, needsOf, plannedAmounts } from '../scripts/rfc27/smoke/config';
import { PoolCtx, withPool } from '../scripts/rfc27/smoke/context';
import { expectedClaims, phaseFinalize } from '../scripts/rfc27/smoke/finalize';
import { rewardClaims } from '../scripts/rfc27/smoke/reward-claims';
import type { Roles } from '../scripts/rfc27/smoke/roles';
import { phaseServe } from '../scripts/rfc27/smoke/serve';
import { phaseSetup } from '../scripts/rfc27/smoke/setup';
import { PhaseName, SetupState, StateFile, decodeState, isSetup } from '../scripts/rfc27/smoke/state';
import { SmokeTx, stoppingAt, tracMoved } from '../scripts/rfc27/smoke/tx';
import { phaseWithdraw } from '../scripts/rfc27/smoke/withdraw';

/** A report that keeps its checks and prints nothing. */
class QuietReport extends Report {
  constructor() {
    super(new Redactor());
  }
  override say(): void {}
}

/** What stops a run where a crash would. */
class Crash extends Error {}

const MUTATING = /^(eth_sendTransaction|eth_sendRawTransaction|evm_|hardhat_|anvil_)/;

/** The JSON-RPC methods `body` calls, as the provider sees them: what a fork helper would send shows here, whatever path it takes. */
async function rpcCalls(body: () => Promise<unknown>): Promise<string[]> {
  const provider = hre.network.provider;
  const [send, request] = [provider.send.bind(provider), provider.request.bind(provider)];
  const seen: string[] = [];
  provider.send = (method: string, params?: unknown[]) => {
    seen.push(method);
    return send(method, params);
  };
  provider.request = (args: { method: string; params?: unknown[] }) => {
    seen.push(args.method);
    return request(args);
  };
  try {
    await body();
  } finally {
    provider.send = send;
    provider.request = request;
  }
  return seen;
}

const derived = (role: string) => ethers.HDNodeWallet.fromSeed(ethers.id(`rfc27-smoke-resume/${role}`)).connect(hre.ethers.provider);

/** The stack, a seller in the sharding table, an owner with ETH and no TRAC, and the clock at the start of an epoch. */
async function deployFixture() {
  const f = await deployRewardsStack();
  const helpers = rewardsHelpers({ f, domain: await queryInferenceDomain(f.QIS), firstAccount: 30, key: hardhatWallet(60) });
  const seller = await helpers.createSeller(100_000n * TRAC, 0n);
  // The scripts look it up for the fork's stand-in proofs: here the scores are written directly.
  await f.Hub.setContractAddress('RandomSampling', f.accounts[49].address);
  await f.accounts[0].sendTransaction({ to: derived('owner').address, value: 10n ** 19n });
  await time.increaseTo((await f.Chronos.timestampForEpoch((await f.Chronos.getCurrentEpoch()) + 1n)) + 60n);
  return { f, seller, helpers, state: undefined as string | undefined };
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

describe('@integration the OT-RFC-27 smoke test, interrupted and resumed, on the real contracts', function () {
  this.timeout(600_000);

  let fx: Fixture;
  let dir: string;
  let stateFile: string;
  const ownerWallet = () => derived('owner');
  /** A run's keys: its own but for the owner, as the script derives them from the run's label. */
  const roles = (run: string): Roles => ({
    owner: ownerWallet(),
    ownerAddr: ownerWallet().address,
    ownerImpersonated: false,
    buyer: derived(`${run}/buyer`),
    edgeBuyer: derived(`${run}/edge-buyer`),
    caSession: derived(`${run}/ca-session`),
    walletSession: derived(`${run}/wallet-session`),
    edgeSession: derived(`${run}/edge-session`),
    seller: fx.seller.operational,
    sellerAddr: fx.seller.operational.address,
    sellerImpersonated: false,
  });

  /** A phase's context, as the entry point builds it; `local` makes the in-process chain stand for the fork. */
  const ctxOf = async (phase: PhaseName, o: { send?: boolean; local?: boolean; warp?: boolean; proofs?: boolean; stopAt?: string; owner?: Signer; run?: string } = {}): Promise<PoolCtx> => {
    const send = o.send ?? true;
    const run = o.run ?? 'test';
    const file_ = run === 'test' ? stateFile : path.join(dir, `${run}.json`);
    const report = new QuietReport();
    const net = { chainId: 31337n, client: 'in-process', local: o.local ?? false, name: 'the in-process chain', forkBlock: o.local ? 1n : undefined };
    const stack = await Stack.at(hre, await fx.f.Hub.getAddress());
    const file = new StateFile(file_, new Redactor(), !send);
    const stop = (): never => {
      throw new Crash(`stopped after ${o.stopAt}`);
    };
    return withPool({
      hre,
      env: { phase, send, warp: o.warp ?? false, proofs: o.proofs ?? false, run, stateFile: file_ },
      net,
      report,
      stack,
      base: await stack.base(),
      fork: new Fork(hre, net, report),
      file,
      tx: new SmokeTx(hre, report, send, o.stopAt ? stoppingAt(file, o.stopAt, stop) : file),
      roles: { ...roles(run), ...(o.owner ? { owner: o.owner } : {}) },
    });
  };

  const stops = async (p: Promise<unknown>): Promise<void> => {
    let thrown: unknown;
    await p.catch((e: unknown) => {
      thrown = e;
    });
    expect(thrown, String(thrown)).to.be.instanceOf(Crash);
  };
  const errorOf = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'no error',
      (e: unknown) => (e as Error).message,
    );
  const failedLabels = (ctx: PoolCtx): string[] => ctx.report.checks.filter((c) => !c.ok).map((c) => `${c.label} — ${c.detail ?? ''}`);
  const passes = (ctx: PoolCtx): void => {
    expect(failedLabels(ctx)).to.deep.equal([]);
    expect(ctx.report.status).to.equal('ran');
  };
  const checkOf = (ctx: PoolCtx, part: string) => {
    const c = ctx.report.checks.find((x) => x.label.includes(part));
    if (!c) throw new Error(`no check "${part}" among ${ctx.report.checks.map((x) => x.label).join(' | ')}`);
    return c;
  };
  const stateNow = (): SetupState => {
    const s = decodeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    if (!isSetup(s)) throw new Error('setup has not completed');
    return s;
  };
  const rawState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const editState = (edit: (raw: ReturnType<typeof rawState>) => void) => {
    const raw = rawState();
    edit(raw);
    fs.writeFileSync(stateFile, JSON.stringify(raw));
  };
  const head = () => hre.ethers.provider.getBlockNumber();
  /**
   * The owner's key, with `alongside` landing in the very block of its transaction
   * calling `selector`, as a stranger's transaction does on a live chain.
   */
  const ownerBeside = (selector: string, alongside: () => Promise<unknown>): Signer => {
    const wallet = ownerWallet();
    const provider = hre.network.provider;
    return {
      getAddress: () => wallet.getAddress(),
      sendTransaction: async (tx: TransactionRequest) => {
        if (!String(tx.data).startsWith(selector)) return wallet.sendTransaction(tx);
        await provider.send('evm_setAutomine', [false]);
        try {
          await alongside();
          const sent = await wallet.sendTransaction(tx);
          await provider.send('evm_mine', []);
          return sent;
        } finally {
          await provider.send('evm_setAutomine', [true]);
        }
      },
    } as unknown as Signer;
  };
  const inTheBlockOf = async (key: string, other: { hash: string }): Promise<number> => {
    const block = (await hre.ethers.provider.getTransactionReceipt(rawState().steps[key].hash))?.blockNumber;
    expect((await hre.ethers.provider.getTransactionReceipt(other.hash))?.blockNumber).to.equal(block);
    return block ?? 0;
  };
  const claimOf = (subscriptionId: string) => fx.f.QIS.getSellerClaim(subscriptionId, 0n, fx.seller.identityId);
  const scoreIn = (epoch: bigint) => fx.helpers.scoreEpoch(epoch, fx.seller, 10n ** 18n);
  /** Past the batch deadline of the run's periods, in E+1. */
  const toDeadline = async () => time.increaseTo((await fx.f.QS.batchDeadline(stateNow().periods.ca)) + 1n);
  const toEpoch = async (e: bigint, plus = 60n) => time.increaseTo((await fx.f.Chronos.timestampForEpoch(e)) + plus);
  /** The upkeep cron's finalizeClaims on the run's claims, `only` if named. */
  const upkeepFinalizes = async (only?: 'account' | 'wallet') => {
    const refs = expectedClaims(stateNow()).filter((x) => !only || x.period === only);
    const tx = await fx.f.QS.connect(fx.f.accounts[20]).finalizeClaims(refs.map(({ subscriptionId, bucketIndex, seller }) => ({ subscriptionId, bucketIndex, seller })));
    return tx.wait();
  };

  /** The fixture a test runs from: its chain, its bindings, and the state file it left. */
  const use = (from: Fixture) => {
    fx = from;
    fs.rmSync(stateFile, { force: true });
    if (from.state !== undefined) fs.writeFileSync(stateFile, from.state);
    return from;
  };
  const fundExactly = async () => {
    const a = await plannedAmounts(await (await Stack.at(hre, await fx.f.Hub.getAddress())).base(), undefined, 0n);
    const needed = needsOf(a, 0n, NOTHING_YET).ownerTrac;
    await fx.f.Token.mint(ownerWallet().address, needed);
    return { a, needed };
  };
  async function afterSetup() {
    use(await loadFixture(deployFixture));
    await fundExactly();
    const ctx = await ctxOf('setup');
    await phaseSetup(ctx);
    passes(ctx);
    return { ...fx, state: fs.readFileSync(stateFile, 'utf8') };
  }
  async function afterServe() {
    use(await loadFixture(afterSetup));
    const ctx = await ctxOf('serve');
    await phaseServe(ctx);
    passes(ctx);
    return { ...fx, state: fs.readFileSync(stateFile, 'utf8') };
  }
  async function afterFinalize() {
    use(await loadFixture(afterServe));
    await toDeadline();
    await scoreIn(stateNow().E + 1n);
    const ctx = await ctxOf('finalize');
    await phaseFinalize(ctx);
    passes(ctx);
    return { ...fx, state: fs.readFileSync(stateFile, 'utf8') };
  }
  async function afterCloseClaim() {
    use(await loadFixture(afterFinalize));
    await toEpoch(stateNow().E + 2n);
    const ctx = await ctxOf('close-claim');
    await phaseCloseClaim(ctx);
    passes(ctx);
    return { ...fx, state: fs.readFileSync(stateFile, 'utf8') };
  }

  beforeEach(() => {
    hre.helpers.resetDeploymentsJson();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc27-smoke-'));
    stateFile = path.join(dir, 'test.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('a run stopped and resumed in setup', () => {
    it('after the stake is mined: the movement of the first run stands, no second stake is sent, and an owner who had exactly the TRAC needed goes on', async () => {
      use(await loadFixture(deployFixture));
      const { a, needed } = await fundExactly();
      const owner = ownerWallet().address;
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.stake' })));

      const record = rawState().steps['setup.stake'];
      expect(record.status).to.equal('mined');
      expect(await fx.f.Token.balanceOf(owner)).to.equal(needed - a.stake);
      const tokensAfterStake = await fx.f.StakingNFT.nextTokenId();
      // Someone else's TRAC reaches the vault before the resume: the stake's own movement must not change.
      await fx.f.Token.mint(await fx.f.Vault.getAddress(), 7n);

      const resumed = await ctxOf('setup');
      await phaseSetup(resumed);
      passes(resumed);
      expect(resumed.file.done('setup')).to.equal(true);
      expect(await fx.f.StakingNFT.nextTokenId()).to.equal(tokensAfterStake);
      expect(rawState().steps['setup.stake'].hash).to.equal(record.hash);
      const moved = checkOf(resumed, 'the stake moved into the vault');
      expect(moved.ok).to.equal(true);
      expect(moved.detail).to.equal(`${fmt(a.stake)} TRAC, by its own Transfer logs`);
      const trac = checkOf(resumed, 'holds the TRAC the run still spends');
      expect(trac.label).to.contain('the commitment, the wallet period');
      expect(trac.label).to.not.contain('the stake');
      expect(trac.detail).to.equal(`${fmt(needed - a.stake)} of ${fmt(needed - a.stake)} TRAC`);
      expect(await fx.f.Token.balanceOf(owner)).to.equal(0n);
    });

    it('after the stake is sent, before its receipt: the movement is read from the receipt, and it is not sent again', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.stake:sent' })));
      const record = rawState().steps['setup.stake'];
      expect(record.status).to.equal('sent');
      const tokensAfterStake = await fx.f.StakingNFT.nextTokenId();
      await fx.f.Token.mint(await fx.f.Vault.getAddress(), 7n);

      const resumed = await ctxOf('setup');
      await phaseSetup(resumed);
      passes(resumed);
      expect(await fx.f.StakingNFT.nextTokenId()).to.equal(tokensAfterStake);
      expect(rawState().steps['setup.stake'].status).to.equal('mined');
      expect(checkOf(resumed, 'the stake moved into the vault').detail).to.equal(`${fmt(a.stake)} TRAC, by its own Transfer logs`);
    });

    it('after the assignment is mined: the consent the replay signs is thrown away, and changes nothing', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.assign-buyer' })));
      const raw = rawState();
      const before = await fx.f.CSS.getAssignment(raw.accountId, derived('test/buyer').address);
      const nonce = await fx.f.CSS.assignmentNonce(raw.accountId);
      const steps = Object.keys(raw.steps).length;
      const blocks = await head();
      let resumed: PoolCtx | undefined;
      const calls = await rpcCalls(async () => {
        resumed = await ctxOf('setup');
        await phaseSetup(resumed);
      });
      if (!resumed) throw new Error('no context');
      passes(resumed);
      // Each transaction sent is a step the journal did not hold: none for the replayed assignment.
      const sent = Object.keys(rawState().steps).length - steps;
      expect(calls.filter((m) => m === 'eth_sendRawTransaction')).to.have.length(sent);
      expect((await head()) - blocks).to.equal(sent);
      expect(rawState().steps['setup.assign-buyer'].hash).to.equal(raw.steps['setup.assign-buyer'].hash);
      const after = await fx.f.CSS.getAssignment(raw.accountId, derived('test/buyer').address);
      expect([after.nonce, after.assignedAt, after.revokedAt]).to.deep.equal([before.nonce, before.assignedAt, before.revokedAt]);
      expect(await fx.f.CSS.assignmentNonce(raw.accountId)).to.equal(nonce);
    });

    it('at each later step that moves money: every check passes, and nothing is sent twice', async () => {
      for (const stopAt of ['setup.create-account', 'setup.fund-account-period', 'setup.fund-wallet-period']) {
        use(await loadFixture(deployFixture));
        const { needed } = await fundExactly();
        await stops(phaseSetup(await ctxOf('setup', { stopAt })));
        const before = rawState().steps;
        const resumed = await ctxOf('setup');
        await phaseSetup(resumed);
        passes(resumed);
        const after = rawState().steps;
        for (const k of Object.keys(before)) expect(after[k].hash, k).to.equal(before[k].hash);
        expect(await fx.f.Token.balanceOf(ownerWallet().address), stopAt).to.equal(0n);
        expect(needed).to.be.greaterThan(0n);
      }
    });

    it('a resume after everything is spent needs no more TRAC, and PHASE=check agrees on a run in progress', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.stake' })));
      const check = await ctxOf('check', { send: false });
      await phaseCheck(check);
      expect(checkOf(check, 'holds the TRAC the run still spends').ok).to.equal(true);
      expect(check.report.data.needs).to.include({ ownerTrac: String(a.committed + a.walletValue) });
    });

    it('in a later epoch, after another caller claimed the position: a claim\'s own effects are no failure', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      const start = await fx.f.Chronos.getCurrentEpoch();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.stake' })));
      const tokenId = await fx.f.StakingNFT.nextTokenId();
      await scoreIn(start);
      await fx.helpers.publishingPool(start, 10n * TRAC);
      await toEpoch(start + 1n);
      await fx.f.StakingV10.connect(fx.f.accounts[20]).claimFor(tokenId);
      const claimed = await fx.f.Vault.getPosition(tokenId);
      expect(claimed.raw).to.be.greaterThan(a.stake);
      expect(claimed.lastClaimedEpoch).to.equal(start);

      const resumed = await ctxOf('setup');
      await phaseSetup(resumed);
      passes(resumed);
      expect(stateNow().E).to.equal(start + 1n);
      expect(stateNow().stakeEpoch).to.equal(start);
    });

    it('PHASE=check on a run whose transaction is not on this chain answers at once, counting it unconfirmed', async () => {
      use(await loadFixture(deployFixture));
      const { needed } = await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.stake' })));
      editState((raw) => {
        raw.steps['setup.stake'].hash = `0x${'ab'.repeat(32)}`;
      });
      const check = await ctxOf('check', { send: false });
      await phaseCheck(check);
      expect(check.report.data.needs).to.include({ ownerTrac: String(needed) });
    });

    it('with too little TRAC for what is left: it still stops, sending nothing', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.stake' })));
      await ownerWallet().sendTransaction({ to: await fx.f.Token.getAddress(), data: fx.f.Token.interface.encodeFunctionData('transfer', [fx.f.accounts[20].address, a.walletValue]) });
      const before = await head();
      const resumed = await ctxOf('setup');
      expect(await errorOf(phaseSetup(resumed))).to.equal('a check failed: see above');
      expect(await head()).to.equal(before);
    });
  });

  describe('on a live chain, with a stranger\'s transaction in the same block', () => {
    const stranger = () => fx.f.accounts[22];

    it('a deposit into the vault beside the stake fails neither the phase nor its resume', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      await fx.f.Token.mint(stranger().address, 7n * TRAC);
      const vault = await fx.f.Vault.getAddress();
      let deposit: { hash: string } = { hash: '' };
      const owner = ownerBeside(fx.f.StakingNFT.interface.getFunction('createConviction').selector, async () => {
        deposit = await fx.f.Token.connect(stranger()).transfer(vault, 7n * TRAC);
      });
      await stops(phaseSetup(await ctxOf('setup', { owner, stopAt: 'setup.stake' })));
      const block = await inTheBlockOf('setup.stake', deposit);
      // What reading the block around it would have seen: the stake and the stranger's deposit together.
      const atBlock = await fx.f.Token.balanceOf(vault, { blockTag: block });
      expect(atBlock - (await fx.f.Token.balanceOf(vault, { blockTag: block - 1 }))).to.equal(a.stake + 7n * TRAC);

      const resumed = await ctxOf('setup');
      await phaseSetup(resumed);
      passes(resumed);
      expect(checkOf(resumed, 'the stake moved into the vault').detail).to.equal(`${fmt(a.stake)} TRAC, by its own Transfer logs`);
      expect(resumed.file.done('setup')).to.equal(true);
    });

    it('the same deposit fails no first run either, and the phase is done', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await fx.f.Token.mint(stranger().address, 7n * TRAC);
      const owner = ownerBeside(fx.f.StakingNFT.interface.getFunction('createConviction').selector, async () => fx.f.Token.connect(stranger()).transfer(await fx.f.Vault.getAddress(), 7n * TRAC));
      const ctx = await ctxOf('setup', { owner });
      await phaseSetup(ctx);
      passes(ctx);
      expect(ctx.file.done('setup')).to.equal(true);
    });

    it('a stranger\'s wallet period funded beside ours moves the vault and the due more, and fails nothing', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      const value = 5n * TRAC;
      await fx.f.Token.mint(stranger().address, value);
      await fx.f.Token.connect(stranger()).approve(await fx.f.SSW.getAddress(), value);
      const epoch = await fx.f.Chronos.getCurrentEpoch();
      let funding: { hash: string } = { hash: '' };
      const owner = ownerBeside(fx.f.SSW.interface.getFunction('fundFromWallet').selector, async () => {
        funding = await fx.f.SSW.connect(stranger()).fundFromWallet(walletRequestOf(epoch, { buckets: [bucket(0, CLASS_INFERENCE, value, 10n ** 15n)], sessionKey: hardhatWallet(61).address }));
      });
      await stops(phaseSetup(await ctxOf('setup', { owner, stopAt: 'setup.fund-wallet-period' })));
      await inTheBlockOf('setup.fund-wallet-period', funding);
      expect((await fx.f.QIS.dueIn(epoch + 1n)).wallet).to.equal(a.walletValue + value);

      const resumed = await ctxOf('setup');
      await phaseSetup(resumed);
      passes(resumed);
      expect(checkOf(resumed, 'moved into the vault and is due').detail).to.contain(`${fmt(a.walletValue)} TRAC by its own Transfer logs; due ${fmt(a.walletValue + value)} TRAC`);
    });

    it('TRAC sent to the owner beside its withdrawal fails neither the phase nor its resume', async () => {
      use(await loadFixture(afterCloseClaim));
      const owner = ownerWallet().address;
      const e = (await fx.f.Chronos.getCurrentEpoch()) + 1n;
      await toEpoch(e, (await fx.f.Chronos.epochLength()) / 2n);
      await fx.helpers.publishingPool(e, 10n * TRAC);
      await scoreIn(e);
      await fx.f.Token.mint(stranger().address, 3n * TRAC);
      let gift: { hash: string } = { hash: '' };
      const signer = ownerBeside(fx.f.StakingNFT.interface.getFunction('withdraw').selector, async () => {
        gift = await fx.f.Token.connect(stranger()).transfer(owner, 3n * TRAC);
      });
      await stops(phaseWithdraw(await ctxOf('withdraw', { owner: signer, stopAt: 'withdraw.withdraw' })));
      await inTheBlockOf('withdraw.withdraw', gift);

      const resumed = await ctxOf('withdraw');
      await phaseWithdraw(resumed);
      passes(resumed);
      expect(checkOf(resumed, 'the withdrawal pays the stake').ok).to.equal(true);
    });
  });

  describe('a step whose receipt does not show what it did', () => {
    /** The run stopped right after `key`, its journal then naming another transaction of the run, with none of what `key` emits. */
    const pointedElsewhere = (key: string, other: string) =>
      editState((raw) => {
        raw.steps[key].hash = raw.steps[other].hash;
      });
    const failsAndIsNotDone = (ctx: PoolCtx, phase: PhaseName, label: string) => {
      expect(failedLabels(ctx).join(' | ')).to.contain(label);
      expect(ctx.file.done(phase)).to.equal(false);
    };

    it('fails setup, which is not done, at the stake', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.stake' })));
      pointedElsewhere('setup.stake', 'setup.approve-staking');
      const ctx = await ctxOf('setup');
      await phaseSetup(ctx);
      failsAndIsNotDone(ctx, 'setup', 'the stake\'s Staked event is in its transaction\'s receipt');
    });

    it('fails setup, which is not done, at the account period, and at the wallet period', async () => {
      for (const [stopAt, label] of [
        ['setup.fund-account-period', 'the account period\'s PeriodFunded event'],
        ['setup.fund-wallet-period', 'the wallet period\'s PeriodFunded event'],
      ]) {
        use(await loadFixture(deployFixture));
        await fundExactly();
        await stops(phaseSetup(await ctxOf('setup', { stopAt })));
        pointedElsewhere(stopAt, 'setup.opt-in');
        const ctx = await ctxOf('setup');
        await phaseSetup(ctx);
        failsAndIsNotDone(ctx, 'setup', label);
        expect(ctx.file.failedChecks('setup')).to.be.greaterThan(0);
      }
    });

    it('fails setup, which is not done, when a step moved other than the run planned', async () => {
      for (const [stopAt, amount, label] of [
        ['setup.stake', 'stake', 'the stake moved into the vault'],
        ['setup.create-account', 'committed', 'the commitment moved into the vault'],
      ]) {
        use(await loadFixture(deployFixture));
        await fundExactly();
        await stops(phaseSetup(await ctxOf('setup', { stopAt })));
        editState((raw) => {
          raw.amounts[amount] = String(BigInt(raw.amounts[amount]) + 1n);
        });
        const ctx = await ctxOf('setup');
        await phaseSetup(ctx);
        failsAndIsNotDone(ctx, 'setup', label);
      }
    });

    it('fails setup, which is not done, at a wallet funding whose receipt moved another amount', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.fund-wallet-period' })));
      const stranger = fx.f.accounts[22];
      const value = 5n * TRAC;
      await fx.f.Token.mint(stranger.address, value);
      await fx.f.Token.connect(stranger).approve(await fx.f.SSW.getAddress(), value);
      const funding = await fx.f.SSW.connect(stranger).fundFromWallet(walletRequestOf(await fx.f.Chronos.getCurrentEpoch(), { buckets: [bucket(0, CLASS_INFERENCE, value, 10n ** 15n)], sessionKey: hardhatWallet(61).address }));
      editState((raw) => {
        raw.steps['setup.fund-wallet-period'].hash = funding.hash;
      });
      const ctx = await ctxOf('setup');
      await phaseSetup(ctx);
      failsAndIsNotDone(ctx, 'setup', 'moved into the vault and is due');
    });

    it('nets what a receipt moved in and out of an account, and reads none from a receipt with no Transfer in it', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.fund-wallet-period' })));
      const vault = await fx.f.Vault.getAddress();
      const receipt = await hre.ethers.provider.getTransactionReceipt(rawState().steps['setup.fund-wallet-period'].hash);
      if (!receipt) throw new Error('no receipt');
      const c = await (await Stack.at(hre, await fx.f.Hub.getAddress())).base();
      expect(tracMoved(receipt, c.token, vault)).to.equal(a.walletValue);
      expect(tracMoved(receipt, c.token, ownerWallet().address)).to.equal(-a.walletValue);
      const noTransfer = new Proxy(receipt, { get: (t, k) => (k === 'logs' ? t.logs.filter((l: { address: string }) => l.address.toLowerCase() !== String(c.token.target).toLowerCase()) : Reflect.get(t, k)) });
      expect(tracMoved(noTransfer, c.token, vault)).to.equal(0n);
    });

    it('fails serve, which is not done, at the top-up', async () => {
      use(await loadFixture(afterSetup));
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.top-up' })));
      pointedElsewhere('serve.top-up', 'setup.opt-in');
      const ctx = await ctxOf('serve');
      await phaseServe(ctx);
      failsAndIsNotDone(ctx, 'serve', 'the top-up\'s PeriodToppedUp event');
    });

    it('fails the withdrawal, which stays on its part', async () => {
      use(await loadFixture(afterCloseClaim));
      const e = (await fx.f.Chronos.getCurrentEpoch()) + 1n;
      await toEpoch(e, (await fx.f.Chronos.epochLength()) / 2n);
      await scoreIn(e);
      await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: 'withdraw.withdraw' })));
      pointedElsewhere('withdraw.withdraw', 'setup.opt-in');
      const ctx = await ctxOf('withdraw');
      await phaseWithdraw(ctx);
      failsAndIsNotDone(ctx, 'withdraw', 'the withdrawal pays the stake');
      expect(rawState().withdrawal).to.equal(undefined);
    });
  });

  describe('a run stopped and resumed in serve', () => {
    it('after the top-up is mined: its movement stands, and no second top-up is sent', async () => {
      use(await loadFixture(afterSetup));
      const s = stateNow();
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.top-up' })));
      const record = rawState().steps['serve.top-up'];
      const period = await fx.f.CSS.getSubscription(s.periods.ca);
      const due = await fx.f.QIS.dueIn(s.E + 1n);

      const resumed = await ctxOf('serve');
      await phaseServe(resumed);
      passes(resumed);
      expect(resumed.file.done('serve')).to.equal(true);
      expect(checkOf(resumed, 'the top-up is accepted').ok).to.equal(true);
      expect(rawState().steps['serve.top-up'].hash).to.equal(record.hash);
      expect((await fx.f.CSS.getSubscription(s.periods.ca)).value).to.equal(period.value);
      // The edge period, funded after the stop, is all that adds to the due.
      expect((await fx.f.QIS.dueIn(s.E + 1n)).conviction - due.conviction).to.equal(s.amounts.edgeValue);
    });

    it('at every other step: every check passes, the edge\'s refusal included, and nothing is sent twice', async () => {
      for (const stopAt of ['serve.batch-1', 'serve.batch-2', 'serve.edge-assign', 'serve.edge-fund', 'serve.edge-revoke', 'serve.edge-reassign']) {
        use(await loadFixture(afterSetup));
        await stops(phaseServe(await ctxOf('serve', { stopAt })));
        const before = rawState().steps;
        const resumed = await ctxOf('serve');
        await phaseServe(resumed);
        passes(resumed);
        const after = rawState().steps;
        for (const k of Object.keys(before)) expect(after[k].hash, `${stopAt}: ${k}`).to.equal(before[k].hash);
      }
    });
  });

  describe('a phase with a failed check', () => {
    /** A run stopped at serve's last step, its state then saying the wallet period was worth more than it was. */
    const failingServe = async () => {
      use(await loadFixture(afterSetup));
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.edge-reassign' })));
      const walletValue = rawState().amounts.walletValue;
      editState((raw) => {
        raw.amounts.walletValue = String(BigInt(walletValue) + TRAC);
      });
      return walletValue;
    };

    it('stays failed across a reload: it is not done, it runs again sending nothing, and the later phases refuse', async () => {
      await failingServe();
      const first = await ctxOf('serve');
      await phaseServe(first);
      expect(first.report.failed).to.be.greaterThan(0);
      expect(first.file.done('serve')).to.equal(false);
      expect(first.file.failedChecks('serve')).to.equal(first.report.failed);

      const blocks = await head();
      const again = await ctxOf('serve');
      await phaseServe(again);
      expect(again.report.status).to.equal('ran');
      expect(again.report.failed).to.equal(first.report.failed);
      expect(await head()).to.equal(blocks);

      await toDeadline();
      const later = await ctxOf('finalize');
      expect(await errorOf(phaseFinalize(later))).to.match(/^PHASE=serve ended with \d+ failed checks?: run it again first/);

      const check = await ctxOf('check', { send: false });
      await phaseCheck(check);
      expect(checkOf(check, 'PHASE=serve of this run has no failed check').ok).to.equal(false);
    });

    it('passes once its cause is gone, sending nothing, and the phases after it go on', async () => {
      const walletValue = await failingServe();
      await phaseServe(await ctxOf('serve'));
      await toEpochOfServe();
      editState((raw) => {
        raw.amounts.walletValue = walletValue;
      });
      const blocks = await head();
      const again = await ctxOf('serve');
      await phaseServe(again);
      passes(again);
      expect(again.file.done('serve')).to.equal(true);
      expect(again.file.failedChecks('serve')).to.equal(0);
      expect(await head()).to.equal(blocks);
      const done = await ctxOf('serve');
      await phaseServe(done);
      expect(done.report.status).to.equal('done earlier');
    });

    it('reads as failed from a state file that recorded it done with failed checks', async () => {
      use(await loadFixture(afterServe));
      editState((raw) => {
        raw.phases.serve = { status: 'done', failedChecks: 1 };
      });
      const reload = new StateFile(stateFile, new Redactor(), false);
      reload.load();
      expect(reload.done('serve')).to.equal(false);
      expect(reload.failedChecks('serve')).to.equal(1);
      const blocks = await head();
      const again = await ctxOf('serve');
      await phaseServe(again);
      passes(again);
      expect(again.file.done('serve')).to.equal(true);
      expect(await head()).to.equal(blocks);
    });

    /** Serve runs in E only: nothing here moved the clock past it. */
    const toEpochOfServe = async () => expect(await fx.f.Chronos.getCurrentEpoch()).to.equal(stateNow().E);
  });

  describe('finalize', () => {
    const setupAndServe = async () => {
      use(await loadFixture(afterServe));
      await toDeadline();
    };

    it('fails when the serve batches\' receipts show neither claim, however little R holds, and sends nothing', async () => {
      await setupAndServe();
      await scoreIn(stateNow().E + 1n);
      editState((raw) => {
        raw.steps['serve.batch-1'].hash = raw.steps['setup.opt-in'].hash;
        raw.steps['serve.batch-2'].hash = raw.steps['setup.opt-in'].hash;
      });
      const blocks = await head();
      const ctx = await ctxOf('finalize');
      await phaseFinalize(ctx);
      expect(ctx.report.status).to.equal('failed');
      expect(checkOf(ctx, 'the serve batches claimed').ok).to.equal(false);
      expect(ctx.file.done('finalize')).to.equal(false);
      expect(await head()).to.equal(blocks);
    });

    it('fails when they show only one of the two claims', async () => {
      await setupAndServe();
      await scoreIn(stateNow().E + 1n);
      editState((raw) => {
        raw.steps['serve.batch-1'].hash = raw.steps['setup.opt-in'].hash; // batch 2 claims on the account period alone
      });
      const ctx = await ctxOf('finalize');
      await phaseFinalize(ctx);
      expect(ctx.report.status).to.equal('failed');
      expect(checkOf(ctx, 'the serve batches claimed').detail).to.equal('their receipts show no wallet claim');
      expect(ctx.file.done('finalize')).to.equal(false);
    });

    it('waits while the seller has no score, then finalizes after its proof, with a skipped attempt in its journal', async () => {
      await setupAndServe();
      const s = stateNow();
      // The first run sends nothing: both would be skipped NoScore.
      const blocks = await head();
      const waiting = await ctxOf('finalize');
      await phaseFinalize(waiting);
      expect(waiting.report.status).to.equal('waiting');
      expect(waiting.report.why).to.contain('NoScore');
      expect(waiting.file.done('finalize')).to.equal(false);
      expect(await head()).to.equal(blocks);

      // An attempt that did go out before the proof, as a slow run's might: its skips are history, not outcomes.
      const early = await upkeepFinalizes();
      editState((raw) => {
        raw.steps['finalize.finalize-claims.1'] = { status: 'mined', label: 'an attempt', role: 'owner', hash: early?.hash, estimate: '1', gasLimit: '1' };
      });
      const stillWaiting = await ctxOf('finalize');
      await phaseFinalize(stillWaiting);
      expect(stillWaiting.report.status).to.equal('waiting');
      expect(failedLabels(stillWaiting)).to.deep.equal([]);
      expect(rawState().refs).to.equal(undefined);

      await scoreIn(s.E + 1n);
      const proved = await ctxOf('finalize');
      await phaseFinalize(proved);
      passes(proved);
      expect(proved.file.done('finalize')).to.equal(true);
      expect(rawState().steps['finalize.finalize-claims.2'].status).to.equal('mined');
      expect(checkOf(proved, 'every claim is finalized').detail).to.equal('account finalized, wallet finalized');
      expect((await claimOf(s.periods.ca)).finalized).to.equal(true);
      expect((await claimOf(s.periods.wallet)).finalized).to.equal(true);
    });

    it('resumed after its attempt is sent: attributes the claims to this run, and sends nothing again', async () => {
      await setupAndServe();
      await scoreIn(stateNow().E + 1n);
      await stops(phaseFinalize(await ctxOf('finalize', { stopAt: 'finalize.finalize-claims.1:sent' })));
      const blocks = await head();
      const resumed = await ctxOf('finalize');
      await phaseFinalize(resumed);
      passes(resumed);
      expect(checkOf(resumed, 'every claim is finalized').detail).to.equal('account finalized, wallet finalized');
      expect(await head()).to.equal(blocks);
      expect(Object.keys(rawState().steps).filter((k) => k.startsWith('finalize.'))).to.deep.equal(['finalize.finalize-claims.1']);
    });

    it('takes claims the upkeep cron finalized in E+1, and says who did, when first run in E+1', async () => {
      await setupAndServe();
      await scoreIn(stateNow().E + 1n);
      await upkeepFinalizes();
      const blocks = await head();
      const ctx = await ctxOf('finalize');
      await phaseFinalize(ctx);
      passes(ctx);
      expect(await head()).to.equal(blocks);
      expect(checkOf(ctx, 'every claim is finalized').label).to.contain('some by another caller (the upkeep cron)');
      expect(checkOf(ctx, 'every claim is finalized').detail).to.equal('account finalized by another caller, wallet finalized by another caller');
    });

    it('takes them too when first run in E+2: they are finalized, not void', async () => {
      await setupAndServe();
      const s = stateNow();
      await scoreIn(s.E + 1n);
      await upkeepFinalizes();
      await toEpoch(s.E + 2n);
      const ctx = await ctxOf('finalize');
      await phaseFinalize(ctx);
      passes(ctx);
      expect(ctx.file.done('finalize')).to.equal(true);
      expect(checkOf(ctx, 'every claim is finalized').detail).to.equal('account finalized by another caller, wallet finalized by another caller');
      expect(checkOf(ctx, 'R in epoch').ok).to.equal(true);
    });

    it('calls a claim void, and fails, only if it is still unfinalized once E+1 has ended', async () => {
      await setupAndServe();
      const s = stateNow();
      await toEpoch(s.E + 2n);
      const blocks = await head();
      const ctx = await ctxOf('finalize');
      await phaseFinalize(ctx);
      expect(ctx.report.status).to.equal('failed');
      expect(failedLabels(ctx)).to.have.length(2);
      expect(failedLabels(ctx).join()).to.contain('the account claim is finalized').and.to.contain('the wallet claim is finalized').and.to.contain('the claim is void');
      expect(ctx.file.done('finalize')).to.equal(false);
      expect(await head()).to.equal(blocks);
    });

    it('calls void only the claim that is unfinalized, when the upkeep cron finalized the other', async () => {
      await setupAndServe();
      const s = stateNow();
      await scoreIn(s.E + 1n);
      await upkeepFinalizes('wallet');
      await toEpoch(s.E + 2n);
      const ctx = await ctxOf('finalize');
      await phaseFinalize(ctx);
      expect(ctx.report.status).to.equal('failed');
      expect(failedLabels(ctx)).to.have.length(1);
      expect(failedLabels(ctx)[0]).to.contain('the account claim is finalized');
    });

    it('in a dry run, with the fork\'s switches on and no score, sends nothing and moves nothing', async () => {
      await setupAndServe();
      const s = stateNow();
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      const blocks = await head();
      const clock = await time.latest();
      let ctx: PoolCtx | undefined;
      const calls = await rpcCalls(async () => {
        ctx = await ctxOf('finalize', { send: false, local: true, warp: true, proofs: true });
        await phaseFinalize(ctx);
      });
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect(calls).to.include('eth_call');
      expect(await head()).to.equal(blocks);
      expect(await time.latest()).to.equal(clock);
      expect(await fx.f.RSS.getNodeEpochScore(s.E + 1n, fx.seller.identityId)).to.equal(0n);
      expect(ctx?.report.status).to.equal('waiting');
    });

    it('in a dry run before it opens, with FORK_WARP, defers and leaves the clock', async () => {
      use(await loadFixture(afterServe));
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      const clock = await time.latest();
      let ctx: PoolCtx | undefined;
      const calls = await rpcCalls(async () => {
        ctx = await ctxOf('finalize', { send: false, local: true, warp: true, proofs: true });
        await phaseFinalize(ctx);
      });
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect(await time.latest()).to.equal(clock);
      expect(ctx?.report.status).to.equal('deferred');
    });
  });

  describe('a dry run of the other phases, with the fork\'s switches on', () => {
    it('sends nothing in setup, nor funds anyone', async () => {
      use(await loadFixture(deployFixture));
      const owner = ownerWallet().address;
      const calls = await rpcCalls(async () => phaseSetup(await ctxOf('setup', { send: false, local: true, warp: true, proofs: true })));
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect(await fx.f.Token.balanceOf(owner)).to.equal(0n);
      expect(fs.existsSync(stateFile)).to.equal(false);
    });

    it('sends nothing in serve', async () => {
      use(await loadFixture(afterSetup));
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      const before = fs.readFileSync(stateFile, 'utf8');
      const calls = await rpcCalls(async () => phaseServe(await ctxOf('serve', { send: false, local: true, warp: true, proofs: true })));
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect(fs.readFileSync(stateFile, 'utf8')).to.equal(before);
    });

    it('sends nothing in withdraw, and leaves the position', async () => {
      use(await loadFixture(afterCloseClaim));
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      const s = stateNow();
      await toEpoch((await fx.f.Chronos.getCurrentEpoch()) + 1n, 86_400n);
      const calls = await rpcCalls(async () => phaseWithdraw(await ctxOf('withdraw', { send: false, local: true, warp: true, proofs: true })));
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect((await fx.f.Vault.getPosition(s.tokenId)).identityId).to.equal(fx.seller.identityId);
    });
  });

  describe('two runs of one owner in the same epoch, whose wallet period can only be one of theirs', () => {
    const fundOwner = async () => {
      const { needed } = await fundExactly();
      return needed;
    };

    it('defers the second run before it spends anything, and the first goes on', async () => {
      use(await loadFixture(afterSetup));
      const needed = await fundOwner();
      const owner = ownerWallet().address;
      const tokens = await fx.f.StakingNFT.nextTokenId();
      const blocks = await head();
      const second = await ctxOf('setup', { run: 'b' });
      await phaseSetup(second);
      expect(second.report.status).to.equal('deferred');
      expect(second.report.why).to.contain('is another run\'s: session key');
      expect(await head()).to.equal(blocks);
      expect(await fx.f.StakingNFT.nextTokenId()).to.equal(tokens);
      expect(await fx.f.Token.balanceOf(owner)).to.equal(needed);
      expect(fs.existsSync(path.join(dir, 'b.json'))).to.equal(false);

      // The first run's resume is untouched: its period is its own.
      const first = await ctxOf('serve');
      await phaseServe(first);
      passes(first);
      expect(first.file.done('serve')).to.equal(true);
    });

    it('lets the second run through in the next epoch, with a wallet period of its own that it can serve', async () => {
      use(await loadFixture(afterSetup));
      await fundOwner();
      const E = stateNow().E;
      await toEpoch(E + 1n);
      const second = await ctxOf('setup', { run: 'b' });
      await phaseSetup(second);
      passes(second);
      const serve = await ctxOf('serve', { run: 'b' });
      await phaseServe(serve);
      passes(serve);
      const held = decodeState(JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8')));
      expect(held.E).to.equal(E + 1n);
      expect((await fx.f.CSS.getSubscription(held.periods.wallet ?? '')).sessionKey).to.equal(derived('b/wallet-session').address);
    });

    it('stops a run whose account period is funded in that epoch when another run took the wallet period, sending nothing', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { run: 'b', stopAt: 'setup.fund-account-period' })));
      const first = await ctxOf('setup');
      await phaseSetup(first);
      passes(first);
      const blocks = await head();
      expect(await errorOf(phaseSetup(await ctxOf('setup', { run: 'b' })))).to.match(/is another run's: .*and this run funded its account period in that epoch: start a new run$/);
      expect(await head()).to.equal(blocks);
    });

    it('keeps a resume of the same run working, whose period is its own', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.fund-wallet-period:sent' })));
      const resumed = await ctxOf('setup');
      await phaseSetup(resumed);
      passes(resumed);
      expect(resumed.file.done('setup')).to.equal(true);
    });

    it('takes a period of the run\'s own key on other terms for a clash too: PHASE=check says so, and a resume stops, sending nothing', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.fund-wallet-period' })));
      editState((raw) => {
        raw.amounts.walletValue = String(BigInt(raw.amounts.walletValue) + TRAC);
      });
      const check = await ctxOf('check', { send: false });
      await phaseCheck(check);
      expect(checkOf(check, 'if it has one, is this run\'s').ok).to.equal(false);
      const blocks = await head();
      expect(await errorOf(phaseSetup(await ctxOf('setup')))).to.match(/and this run funded its account period in that epoch: start a new run$/);
      expect(await head()).to.equal(blocks);
    });

    it('says so at PHASE=check, for the second run and not the first', async () => {
      use(await loadFixture(afterSetup));
      const second = await ctxOf('check', { run: 'b', send: false });
      await phaseCheck(second);
      expect(checkOf(second, 'if it has one, is this run\'s').ok).to.equal(false);
      const first = await ctxOf('check', { send: false });
      await phaseCheck(first);
      expect(checkOf(first, 'if it has one, is this run\'s').ok).to.equal(true);
    });
  });

  describe('close-claim, after the finalization', () => {
    const served = async () => {
      use(await loadFixture(afterServe));
      await toDeadline();
      const s = stateNow();
      await scoreIn(s.E + 1n);
      return s;
    };

    it('refuses a run with one claim finalized and one void, sends nothing, and the run goes no further', async () => {
      const s = await served();
      await upkeepFinalizes('wallet');
      await toEpoch(s.E + 2n);
      const finalize = await ctxOf('finalize');
      await phaseFinalize(finalize);
      expect(finalize.report.status).to.equal('failed');
      expect(finalize.file.done('finalize')).to.equal(false);

      const blocks = await head();
      const ctx = await ctxOf('close-claim');
      await phaseCloseClaim(ctx);
      expect(ctx.report.status).to.equal('failed');
      expect(checkOf(ctx, 'both of the run\'s claims are finalized').ok).to.equal(false);
      expect(checkOf(ctx, 'both of the run\'s claims are finalized').detail).to.contain('the account claim is not');
      expect(ctx.file.done('close-claim')).to.equal(false);
      expect(await head()).to.equal(blocks);
      expect(await errorOf(phaseWithdraw(await ctxOf('withdraw')))).to.equal('run PHASE=close-claim SEND=1 first');
    });

    it('refuses a run with neither finalized', async () => {
      const s = await served();
      await toEpoch(s.E + 2n);
      const ctx = await ctxOf('close-claim');
      await phaseCloseClaim(ctx);
      expect(ctx.report.status).to.equal('failed');
      expect(checkOf(ctx, 'both of the run\'s claims are finalized').detail).to.contain('the account and wallet claim is not');
      expect(ctx.file.done('close-claim')).to.equal(false);
    });

    it('takes both claims finalized by the upkeep cron, with PHASE=finalize never run', async () => {
      const s = await served();
      await upkeepFinalizes();
      await toEpoch(s.E + 2n);
      const ctx = await ctxOf('close-claim');
      await phaseCloseClaim(ctx);
      passes(ctx);
      expect(ctx.file.done('close-claim')).to.equal(true);
      expect(checkOf(ctx, 'both of the run\'s claims are finalized').ok).to.equal(true);
    });

    it('refuses while PHASE=finalize stands failed, though both claims are finalized', async () => {
      const s = await served();
      await upkeepFinalizes();
      await toEpoch(s.E + 2n);
      editState((raw) => {
        raw.phases.finalize = { status: 'failed', failedChecks: 1 };
      });
      expect(await errorOf(phaseCloseClaim(await ctxOf('close-claim')))).to.match(/^PHASE=finalize ended with 1 failed check/);
    });

    it('defers before E+1 has ended, without calling a claim void', async () => {
      await served();
      const ctx = await ctxOf('close-claim');
      await phaseCloseClaim(ctx);
      expect(ctx.report.status).to.equal('deferred');
      expect(ctx.report.failed).to.equal(0);
    });
  });

  describe('close-claim', () => {
    /** A claim of the position outside the phase, as the upkeep cron's would be. */
    const upkeepClaims = async (tokenId: bigint) => (await fx.f.StakingV10.connect(fx.f.accounts[20]).claimFor(tokenId)).wait();

    it('resumed after its close and after its claim: nothing is sent again, also an epoch later', async () => {
      for (const stopAt of ['close-claim.close-epochs', 'close-claim.claim']) {
        use(await loadFixture(afterFinalize));
        const s = stateNow();
        await toEpoch(s.E + 2n);
        await stops(phaseCloseClaim(await ctxOf('close-claim', { stopAt })));
        const before = await fx.f.Vault.getPosition(s.tokenId);
        const later = stopAt === 'close-claim.claim';
        if (later) await toEpoch(s.E + 3n);
        const resumed = await ctxOf('close-claim');
        await phaseCloseClaim(resumed);
        passes(resumed);
        expect(resumed.file.done('close-claim'), stopAt).to.equal(true);
        const after = await fx.f.Vault.getPosition(s.tokenId);
        if (later) {
          expect(after.raw).to.equal(before.raw);
          expect(after.lastClaimedEpoch).to.equal(before.lastClaimedEpoch);
          expect(checkOf(resumed, 'the position was claimed for epochs').label).to.contain('by this phase before it was interrupted');
        }
      }
    });

    it('checks what the upkeep cron claimed, from the claims the chain recorded, and claims the rest itself', async () => {
      use(await loadFixture(afterFinalize));
      const s = stateNow();
      await toEpoch(s.E + 2n);
      await upkeepClaims(s.tokenId);
      await toEpoch(s.E + 3n);
      const ctx = await ctxOf('close-claim');
      await phaseCloseClaim(ctx);
      passes(ctx);
      const by = checkOf(ctx, 'the position was claimed for epochs');
      expect(by.label).to.contain('another caller (the upkeep cron)');
      expect(by.detail).to.contain('in 1 claim');
      expect(checkOf(ctx, 'claimFor pays what StakingKPI previewed').ok).to.equal(true);
      expect(checkOf(ctx, 'the position is paid a share of epoch').ok).to.equal(true);
    });
  });

  describe('a position\'s claims, read from what the chain recorded', () => {
    it('gives each claim its window and payment: a cursor moved with no reward, grouped epochs, and more than one claim', async () => {
      use(await loadFixture(deployFixture));
      const { f, helpers } = fx;
      const staker = f.accounts[21];
      const start = await f.Chronos.getCurrentEpoch();
      const stakeRaw = 1_000n * TRAC;
      const tokenId = await helpers.delegate(staker, fx.seller.identityId, stakeRaw);
      const fromBlock = await head();
      const stack = await Stack.at(hre, await f.Hub.getAddress());
      const c: Contracts = { ...(await stack.base()), ...(await stack.pool()) };
      const read = (raw = stakeRaw) => rewardClaims(hre.ethers.provider, c, { tokenId, node: fx.seller.identityId, stakeRaw: raw, firstEpoch: start, fromBlock });
      const pay = async (e: bigint) => {
        await scoreIn(e);
        await helpers.publishingPool(e, 10n * TRAC);
      };
      const claim = () => f.StakingV10.connect(f.accounts[20]).claimFor(tokenId);

      expect((await read()).claims).to.deep.equal([]);
      await toEpoch(start + 1n); // the epoch of the stake held nothing: the cursor moves, and nothing is paid
      await claim();
      await pay(start + 1n);
      await toEpoch(start + 2n);
      await pay(start + 2n);
      await toEpoch(start + 3n); // two epochs in one claim
      await claim();
      await pay(start + 3n);
      await toEpoch(start + 4n); // and one more, on the stake compounded so far
      await claim();

      const { claims, per, total, through } = await read();
      expect(claims.map((x) => [x.from, x.to])).to.deep.equal([
        [start, start],
        [start + 1n, start + 2n],
        [start + 3n, start + 3n],
      ]);
      expect(claims[0].paid).to.equal(0n);
      expect(claims[1].paid).to.be.greaterThan(0n);
      expect(claims[2].paid).to.be.greaterThan(0n);
      for (const x of claims) expect(x.paid).to.equal(x.previewed);
      const pos = await f.Vault.getPosition(tokenId);
      expect(total).to.equal(pos.cumulativeRewardsClaimed);
      expect(through).to.equal(pos.lastClaimedEpoch);
      expect(pos.raw).to.equal(stakeRaw + total);
      expect(per.filter((x) => x.scored).map((x) => x.epoch)).to.deep.equal([start + 1n, start + 2n, start + 3n]);

      // A claim that paid otherwise than the preview shows by itself: here, read as if on another stake.
      expect((await read(stakeRaw * 2n)).claims.some((x) => x.paid !== x.previewed)).to.equal(true);
    });
  });

  describe('withdraw', () => {
    /** The middle of the epoch after the run's close-claim, before any proof in it, with something for it to pay. */
    const toMiddle = async () => {
      const e = await fx.f.Chronos.getCurrentEpoch();
      await toEpoch(e + 1n, (await fx.f.Chronos.epochLength()) / 2n);
      await fx.helpers.publishingPool(e + 1n, 10n * TRAC);
      return e + 1n;
    };

    it('waits, burning nothing, until the position holds score in the epoch, then goes through', async () => {
      use(await loadFixture(afterCloseClaim));
      const s = stateNow();
      const e = await toMiddle();
      const blocks = await head();
      const waiting = await ctxOf('withdraw');
      await phaseWithdraw(waiting);
      expect(waiting.report.status).to.equal('waiting');
      expect(waiting.report.why).to.contain(`position ${s.tokenId} holds no score in epoch ${e}`);
      expect(await head()).to.equal(blocks);
      expect((await fx.f.Vault.getPosition(s.tokenId)).identityId).to.equal(fx.seller.identityId);
      expect(await fx.f.StakingNFT.ownerOf(s.tokenId)).to.equal(ownerWallet().address);
      expect(rawState().withdrawal).to.equal(undefined);

      await scoreIn(e);
      const proved = await ctxOf('withdraw');
      await phaseWithdraw(proved);
      passes(proved);
      expect((await fx.f.Vault.getPosition(s.tokenId)).identityId).to.equal(0n);
      expect(BigInt(rawState().withdrawal.epoch)).to.equal(e);

      await toEpoch(e + 1n);
      const claimed = await ctxOf('withdraw');
      expect((await phaseWithdraw(claimed)).part).to.equal('claim');
      passes(claimed);
      expect(claimed.file.done('withdraw')).to.equal(true);
      expect(checkOf(claimed, 'claimWithdrawnEpoch pays the owner').ok).to.equal(true);

      const again = await ctxOf('withdraw');
      await phaseWithdraw(again);
      expect(again.report.status).to.equal('done earlier');
    });

    it('resumed after the withdrawal is mined: its result stands though the position is gone, also an epoch later, and the claim goes on', async () => {
      use(await loadFixture(afterCloseClaim));
      const s = stateNow();
      const e = await toMiddle();
      await scoreIn(e);
      const owner = ownerWallet().address;
      const before = await fx.f.Token.balanceOf(owner);
      await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: 'withdraw.withdraw' })));
      const paid = (await fx.f.Token.balanceOf(owner)) - before;
      expect(paid).to.be.greaterThan(0n);
      expect((await fx.f.Vault.getPosition(s.tokenId)).identityId).to.equal(0n);

      await toEpoch(e + 1n);
      await fx.f.Token.mint(owner, 3n); // the owner's balance moves for another reason: the withdrawal's movement must not
      const blocks = await head();
      const resumed = await ctxOf('withdraw');
      await phaseWithdraw(resumed);
      passes(resumed);
      expect(await head()).to.equal(blocks);
      expect(checkOf(resumed, 'the withdrawal pays the stake').ok).to.equal(true);
      expect(resumed.report.checks.some((x) => x.label.includes('WithdrawnEpochInProgress'))).to.equal(false);

      await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: 'withdraw.claim-withdrawn-epoch' })));
      const blocks2 = await head();
      const claimed = await ctxOf('withdraw');
      await phaseWithdraw(claimed);
      passes(claimed);
      expect(await head()).to.equal(blocks2);
      expect(claimed.file.done('withdraw')).to.equal(true);
      expect(checkOf(claimed, 'claimWithdrawnEpoch pays the owner').ok).to.equal(true);
    });

    it('reads a claim of the withdrawn epoch by another caller from its own transaction, whatever else the owner received', async () => {
      use(await loadFixture(afterCloseClaim));
      const s = stateNow();
      const e = await toMiddle();
      await scoreIn(e);
      await phaseWithdraw(await ctxOf('withdraw'));
      await toEpoch(e + 1n);
      await fx.f.StakingV10.connect(fx.f.accounts[20]).claimWithdrawnEpoch(s.tokenId);
      await fx.f.Token.mint(ownerWallet().address, 3n); // other TRAC of the owner's
      const ctx = await ctxOf('withdraw');
      await phaseWithdraw(ctx);
      passes(ctx);
      expect(ctx.file.done('withdraw')).to.equal(true);
      expect(checkOf(ctx, 'claimed by another caller').detail).to.contain('by that transaction\'s Transfer logs');
    });

    it('stays on its part while a check fails, and runs again sending nothing', async () => {
      use(await loadFixture(afterCloseClaim));
      const e = await toMiddle();
      await scoreIn(e);
      await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: 'withdraw.withdraw' })));
      const expected = rawState().steps['withdraw.withdraw'].expected.raw;
      editState((raw) => {
        raw.steps['withdraw.withdraw'].expected.raw = '1';
      });
      const failing = await ctxOf('withdraw');
      await phaseWithdraw(failing);
      expect(failing.report.failed).to.equal(1);
      expect(rawState().withdrawal).to.equal(undefined);
      editState((raw) => {
        raw.steps['withdraw.withdraw'].expected.raw = expected;
      });
      const blocks = await head();
      const fixed = await ctxOf('withdraw');
      await phaseWithdraw(fixed);
      passes(fixed);
      expect(await head()).to.equal(blocks);
      expect(rawState().withdrawal).to.not.equal(undefined);
    });
  });

  describe('what a completed phase leaves', () => {
    it('records the Hub of the stack it was given, and refuses a state of another', async () => {
      use(await loadFixture(afterSetup));
      expect(rawState().hub).to.equal(await fx.f.Hub.getAddress());
      editState((raw) => {
        raw.hub = hardhatWallet(62).address;
      });
      expect(await errorOf(phaseServe(await ctxOf('serve')))).to.match(/belongs to another run: Hub 0x[0-9a-fA-F]{40}, this stack's is 0x[0-9a-fA-F]{40}/);
    });

    it('gates the phases after setup on a state typed to hold what setup records, and refuses one that lacks it', async () => {
      use(await loadFixture(afterSetup));
      editState((raw) => {
        delete raw.accountId;
      });
      const ctx = await ctxOf('serve');
      expect(await errorOf(phaseServe(ctx))).to.contain('says setup completed, but holds no accountId');
    });

    it('keeps no claim state, and carries a whole run to its end', async () => {
      use(await loadFixture(afterCloseClaim));
      const raw = rawState();
      expect(raw.refs).to.equal(undefined);
      expect(raw.finalizedValue).to.equal(undefined);
      for (const p of ['setup', 'serve', 'finalize', 'close-claim']) expect(raw.phases[p], p).to.deep.equal({ status: 'done', failedChecks: 0 });
      const check = await ctxOf('check', { send: false });
      await phaseCheck(check);
      expect(failedLabels(check)).to.deep.equal([]);
      expect(check.report.data.needs).to.include({ ownerTrac: '0' });
    });
  });
});
