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

import { getStorageAt, loadFixture, setStorageAt, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import type { Signer, TransactionRequest } from 'ethers';
import hre from 'hardhat';

import type { ProfileStorage } from '../typechain';
import { CLASS_INFERENCE, TRAC, budget, walletRequestOf } from './helpers/conviction-service';
import { hardhatWallet, queryInferenceDomain } from './helpers/query-inference';
import { deployRewardsStack, rewardsHelpers } from './helpers/query-inference-rewards';
import { Contracts, Stack } from '../scripts/rfc27/contracts';
import { Fork } from '../scripts/rfc27/fork';
import { Redactor, Report, fmt } from '../scripts/rfc27/report';
import { phaseCheck } from '../scripts/rfc27/smoke/check';
import { phaseClaim } from '../scripts/rfc27/smoke/claim';
import { NOTHING_YET, needsOf, plannedAmounts, readEnv } from '../scripts/rfc27/smoke/config';
import { PoolCtx, withPool } from '../scripts/rfc27/smoke/context';
import { firstBlockAt, rewardClaims } from '../scripts/rfc27/smoke/reward-claims';
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
  /** The fee in force on the seller's node over every epoch, as its history says from here on. */
  const feeIs = async (feeBps: bigint) => {
    const contract = fx.f.accounts[47];
    await fx.f.Hub.setContractAddress('OperatorFeeWriter', contract.address);
    const profiles = await hre.ethers.getContract<ProfileStorage>('ProfileStorage');
    await profiles.connect(contract).setOperatorFees(fx.seller.identityId, [{ feePercentage: feeBps, effectiveDate: 1n }]);
  };
  /** `claim` run while half of every epoch's reward goes to the operator, which it does not: what it stores and what it pays are too small, and consistently so. */
  const tooSmall = async (claim: () => Promise<unknown>) => {
    await feeIs(5_000n);
    await claim();
    await feeIs(0n);
  };
  /** The owner's key, sending with too little gas for the transaction to get anywhere: it is mined, and reverts. */
  const ownerShortOfGas = (): Signer => {
    const wallet = ownerWallet();
    const provider = hre.network.provider;
    return {
      getAddress: () => wallet.getAddress(),
      sendTransaction: async (tx: TransactionRequest) => {
        await provider.send('evm_setAutomine', [false]);
        try {
          const sent = await wallet.sendTransaction({ ...tx, gasLimit: 40_000n });
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
  const scoreIn = (epoch: bigint) => fx.helpers.scoreEpoch(epoch, fx.seller, 10n ** 18n);
  const toEpoch = async (e: bigint, plus = 60n) => time.increaseTo((await fx.f.Chronos.timestampForEpoch(e)) + plus);

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
  /** Setup done, and the seller proved in E, which a batch needs. */
  async function afterProof() {
    use(await loadFixture(afterSetup));
    await scoreIn(stateNow().E);
    return { ...fx, state: fs.readFileSync(stateFile, 'utf8') };
  }
  async function afterServe() {
    use(await loadFixture(afterProof));
    const ctx = await ctxOf('serve');
    await phaseServe(ctx);
    passes(ctx);
    return { ...fx, state: fs.readFileSync(stateFile, 'utf8') };
  }
  async function afterClaim() {
    use(await loadFixture(afterServe));
    await toEpoch(stateNow().E + 1n);
    const ctx = await ctxOf('claim');
    await phaseClaim(ctx);
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
      expect(trac.label).to.contain('the commitment, the wallet subscription');
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

    it('after the grant is mined: the consent the replay signs is thrown away, and changes nothing', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.add-buyer' })));
      const raw = rawState();
      const before = await fx.f.SSS.getGrant(raw.accountId, derived('test/buyer').address);
      const nonce = await fx.f.SSS.grantNonce(raw.accountId);
      const steps = Object.keys(raw.steps).length;
      const blocks = await head();
      let resumed: PoolCtx | undefined;
      const calls = await rpcCalls(async () => {
        resumed = await ctxOf('setup');
        await phaseSetup(resumed);
      });
      if (!resumed) throw new Error('no context');
      passes(resumed);
      // Each transaction sent is a step the journal did not hold: none for the replayed grant.
      const sent = Object.keys(rawState().steps).length - steps;
      expect(calls.filter((m) => m === 'eth_sendRawTransaction')).to.have.length(sent);
      expect((await head()) - blocks).to.equal(sent);
      expect(rawState().steps['setup.add-buyer'].hash).to.equal(raw.steps['setup.add-buyer'].hash);
      const after = await fx.f.SSS.getGrant(raw.accountId, derived('test/buyer').address);
      expect([after.nonce, after.grantedAt, after.revokedAt]).to.deep.equal([before.nonce, before.grantedAt, before.revokedAt]);
      expect(await fx.f.SSS.grantNonce(raw.accountId)).to.equal(nonce);
    });

    it('at each later step that moves money: every check passes, and nothing is sent twice', async () => {
      for (const stopAt of ['setup.create-account', 'setup.fund-account-subscription', 'setup.fund-wallet-subscription']) {
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

    it('after a stake that filled the node\'s room, mined or only sent, with its position not recorded: the resume counts it once', async () => {
      for (const stopAt of ['setup.stake', 'setup.stake:sent']) {
        use(await loadFixture(deployFixture));
        await fundExactly();
        await stops(phaseSetup(await ctxOf('setup', { stopAt })));
        expect(rawState().tokenId, stopAt).to.equal(undefined);
        await fx.f.Params.setMaximumStake(await fx.f.Vault.getNodeStakeV10(fx.seller.identityId));
        const resumed = await ctxOf('setup');
        await phaseSetup(resumed);
        passes(resumed);
        expect(checkOf(resumed, 'under the maximum stake').ok, stopAt).to.equal(true);
        expect(resumed.file.done('setup'), stopAt).to.equal(true);
      }
    });

    it('with no room for a stake still to send: it refuses, sending nothing', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      await fx.f.Params.setMaximumStake((await fx.f.Vault.getNodeStakeV10(fx.seller.identityId)) + a.stake - 1n);
      const blocks = await head();
      const ctx = await ctxOf('setup');
      expect(await errorOf(phaseSetup(ctx))).to.equal('the seller does not qualify: see the checks above');
      expect(checkOf(ctx, 'under the maximum stake').ok).to.equal(false);
      expect(await head()).to.equal(blocks);
      expect(fs.existsSync(stateFile)).to.equal(false);
    });

    it('after any step but the claim of the withdrawn epoch reverted: it stops on that transaction, every time', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      expect(await errorOf(phaseSetup(await ctxOf('setup', { owner: ownerShortOfGas() })))).to.match(/reverted on chain/);
      const [key] = Object.keys(rawState().steps);
      const { hash } = rawState().steps[key];
      const blocks = await head();
      for (let i = 0; i < 2; i++) {
        expect(await errorOf(phaseSetup(await ctxOf('setup')))).to.contain(`transaction ${hash} of an earlier run reverted`);
      }
      expect(await head()).to.equal(blocks);
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

    it('a stranger\'s wallet subscription funded beside ours moves the vault and the epoch\'s money more, and fails nothing', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      const value = 5n * TRAC;
      await fx.f.Token.mint(stranger().address, value);
      await fx.f.Token.connect(stranger()).approve(await fx.f.SSW.getAddress(), value);
      const epoch = await fx.f.Chronos.getCurrentEpoch();
      let funding: { hash: string } = { hash: '' };
      const owner = ownerBeside(fx.f.SSW.interface.getFunction('fundFromWallet').selector, async () => {
        funding = await fx.f.SSW.connect(stranger()).fundFromWallet(walletRequestOf(epoch, { budgets: [budget(0, CLASS_INFERENCE, value, 10n ** 15n)], sessionKey: hardhatWallet(61).address }));
      });
      await stops(phaseSetup(await ctxOf('setup', { owner, stopAt: 'setup.fund-wallet-subscription' })));
      await inTheBlockOf('setup.fund-wallet-subscription', funding);
      expect((await fx.f.QIS.fundingIn(epoch)).wallet).to.equal(a.walletValue + value);

      const resumed = await ctxOf('setup');
      await phaseSetup(resumed);
      passes(resumed);
      expect(checkOf(resumed, 'moved into the vault and is booked').detail).to.contain(`${fmt(a.walletValue)} TRAC by its own Transfer logs; booked ${fmt(a.walletValue + value)} TRAC`);
    });

    it('TRAC sent to the owner beside its withdrawal fails neither the phase nor its resume', async () => {
      use(await loadFixture(afterClaim));
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

    /** The context's receipts with no TRAC Transfer in them: each transaction's own events are there, and what it moved is not. */
    const showingNoTransfer = (ctx: PoolCtx): PoolCtx => {
      const { tx } = ctx;
      const receipt = tx.receipt.bind(tx);
      const token = String(fx.f.Token.target).toLowerCase();
      tx.receipt = async (hash: string) =>
        new Proxy(await receipt(hash), { get: (t, k) => (k === 'logs' ? t.logs.filter((l: { address: string }) => l.address.toLowerCase() !== token) : Reflect.get(t, k)) });
      return ctx;
    };
    /** A position withdrawn in the middle of the epoch after claim, with something to claim of that epoch, and the clock in the next. */
    const withdrawnWithClaim = async () => {
      use(await loadFixture(afterClaim));
      const e = (await fx.f.Chronos.getCurrentEpoch()) + 1n;
      await toEpoch(e, (await fx.f.Chronos.epochLength()) / 2n);
      await fx.helpers.publishingPool(e, 10n * TRAC);
      await scoreIn(e);
      await phaseWithdraw(await ctxOf('withdraw'));
      await toEpoch(e + 1n);
    };

    it('fails setup, which is not done, when the receipt of a step that moves TRAC shows no Transfer', async () => {
      for (const [stopAt, label] of [
        ['setup.stake', 'the stake moved into the vault'],
        ['setup.create-account', 'the commitment moved into the vault'],
        ['setup.fund-wallet-subscription', 'moved into the vault and is booked'],
      ]) {
        use(await loadFixture(deployFixture));
        await fundExactly();
        await stops(phaseSetup(await ctxOf('setup', { stopAt })));
        const ctx = showingNoTransfer(await ctxOf('setup'));
        await phaseSetup(ctx);
        failsAndIsNotDone(ctx, 'setup', label);
      }
    });

    it('fails the withdrawal, which stays on its part, when its event is there and its receipt shows no Transfer', async () => {
      use(await loadFixture(afterClaim));
      const e = (await fx.f.Chronos.getCurrentEpoch()) + 1n;
      await toEpoch(e, (await fx.f.Chronos.epochLength()) / 2n);
      await scoreIn(e);
      await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: 'withdraw.withdraw' })));
      const ctx = showingNoTransfer(await ctxOf('withdraw'));
      await phaseWithdraw(ctx);
      failsAndIsNotDone(ctx, 'withdraw', 'the withdrawal pays the stake');
      expect(rawState().withdrawal).to.equal(undefined);
    });

    it('fails the claim of the withdrawn epoch, when its event is there and its receipt shows no Transfer', async () => {
      await withdrawnWithClaim();
      await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: 'withdraw.claim-withdrawn-epoch' })));
      const ctx = showingNoTransfer(await ctxOf('withdraw'));
      await phaseWithdraw(ctx);
      failsAndIsNotDone(ctx, 'withdraw', 'claimWithdrawnEpoch pays the owner');
    });

    it('fails on another caller\'s claim of the withdrawn epoch, when its receipt shows no Transfer', async () => {
      await withdrawnWithClaim();
      await fx.f.StakingV10.connect(fx.f.accounts[20]).claimWithdrawnEpoch(stateNow().tokenId);
      const ctx = showingNoTransfer(await ctxOf('withdraw'));
      await phaseWithdraw(ctx);
      failsAndIsNotDone(ctx, 'withdraw', 'claimed by another caller');
    });

    it('fails setup, which is not done, at the stake', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.stake' })));
      pointedElsewhere('setup.stake', 'setup.approve-staking');
      const ctx = await ctxOf('setup');
      await phaseSetup(ctx);
      failsAndIsNotDone(ctx, 'setup', 'the stake\'s Staked event is in its transaction\'s receipt');
    });

    it('fails setup, which is not done, at the account subscription, and at the wallet subscription', async () => {
      for (const [stopAt, label] of [
        ['setup.fund-account-subscription', 'the account subscription\'s SubscriptionFunded event'],
        ['setup.fund-wallet-subscription', 'the wallet subscription\'s SubscriptionFunded event'],
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
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.fund-wallet-subscription' })));
      const stranger = fx.f.accounts[22];
      const value = 5n * TRAC;
      await fx.f.Token.mint(stranger.address, value);
      await fx.f.Token.connect(stranger).approve(await fx.f.SSW.getAddress(), value);
      const funding = await fx.f.SSW.connect(stranger).fundFromWallet(walletRequestOf(await fx.f.Chronos.getCurrentEpoch(), { budgets: [budget(0, CLASS_INFERENCE, value, 10n ** 15n)], sessionKey: hardhatWallet(61).address }));
      editState((raw) => {
        raw.steps['setup.fund-wallet-subscription'].hash = funding.hash;
      });
      const ctx = await ctxOf('setup');
      await phaseSetup(ctx);
      failsAndIsNotDone(ctx, 'setup', 'moved into the vault and is booked');
    });

    it('nets what a receipt moved in and out of an account, and reads none from a receipt with no Transfer in it', async () => {
      use(await loadFixture(deployFixture));
      const { a } = await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.fund-wallet-subscription' })));
      const vault = await fx.f.Vault.getAddress();
      const receipt = await hre.ethers.provider.getTransactionReceipt(rawState().steps['setup.fund-wallet-subscription'].hash);
      if (!receipt) throw new Error('no receipt');
      const c = await (await Stack.at(hre, await fx.f.Hub.getAddress())).base();
      expect(tracMoved(receipt, c.token, vault)).to.equal(a.walletValue);
      expect(tracMoved(receipt, c.token, ownerWallet().address)).to.equal(-a.walletValue);
      const noTransfer = new Proxy(receipt, { get: (t, k) => (k === 'logs' ? t.logs.filter((l: { address: string }) => l.address.toLowerCase() !== String(c.token.target).toLowerCase()) : Reflect.get(t, k)) });
      expect(tracMoved(noTransfer, c.token, vault)).to.equal(0n);
    });

    it('fails serve, which is not done, at the top-up', async () => {
      use(await loadFixture(afterProof));
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.top-up' })));
      pointedElsewhere('serve.top-up', 'setup.opt-in');
      const ctx = await ctxOf('serve');
      await phaseServe(ctx);
      failsAndIsNotDone(ctx, 'serve', 'the top-up\'s SubscriptionToppedUp event');
    });

    it('fails the withdrawal, which stays on its part', async () => {
      use(await loadFixture(afterClaim));
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
      use(await loadFixture(afterProof));
      const s = stateNow();
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.top-up' })));
      const record = rawState().steps['serve.top-up'];
      const subscription = await fx.f.SSS.getSubscription(s.subscriptions.ca);
      const booked = await fx.f.QIS.fundingIn(s.E);

      const resumed = await ctxOf('serve');
      await phaseServe(resumed);
      passes(resumed);
      expect(resumed.file.done('serve')).to.equal(true);
      expect(checkOf(resumed, 'the top-up is accepted').ok).to.equal(true);
      expect(rawState().steps['serve.top-up'].hash).to.equal(record.hash);
      expect((await fx.f.SSS.getSubscription(s.subscriptions.ca)).value).to.equal(subscription.value);
      // The edge subscription, funded after the stop, is all that adds to the epoch's money.
      expect((await fx.f.QIS.fundingIn(s.E)).account - booked.account).to.equal(s.amounts.edgeValue);
    });

    it('at every other step: every check passes, the edge\'s refusal included, and nothing is sent twice', async () => {
      for (const stopAt of ['serve.batch-1', 'serve.batch-2', 'serve.edge-add-buyer', 'serve.edge-fund', 'serve.edge-revoke', 'serve.edge-add-again']) {
        use(await loadFixture(afterProof));
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
    /** A run stopped at serve's last step, its state then saying the wallet subscription was worth more than it was. */
    const failingServe = async () => {
      use(await loadFixture(afterProof));
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.edge-add-again' })));
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

      await toEpoch(stateNow().E + 1n);
      const later = await ctxOf('claim');
      expect(await errorOf(phaseClaim(later))).to.match(/^PHASE=serve ended with \d+ failed checks?: run it again first/);

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

  describe('serve, and what a batch needs', () => {
    it('waits while the seller has no node score in E, sending nothing, then lands after its proof', async () => {
      use(await loadFixture(afterSetup));
      const s = stateNow();
      const blocks = await head();
      const waiting = await ctxOf('serve');
      await phaseServe(waiting);
      expect(waiting.report.status).to.equal('waiting');
      expect(waiting.report.why).to.contain('NoNodeScore');
      expect(waiting.file.done('serve')).to.equal(false);
      expect(await head()).to.equal(blocks);

      await scoreIn(s.E);
      const proved = await ctxOf('serve');
      await phaseServe(proved);
      passes(proved);
      expect(proved.file.done('serve')).to.equal(true);
      expect(checkOf(proved, 'the seller has a node score in epoch').detail).to.contain(`node ${s.sellerId}`);
    });

    it('sees the next batch refused while the account budget is too low for it, and lands it after the top-up, on nonces the refusal did not spend', async () => {
      use(await loadFixture(afterProof));
      const s = stateNow();
      const ctx = await ctxOf('serve');
      await phaseServe(ctx);
      passes(ctx);
      expect(checkOf(ctx, 'the next batch is refused until the top-up').ok).to.equal(true);
      expect(checkOf(ctx, 'the first batch counts in whole').ok).to.equal(true);
      expect(await fx.f.QIS.budgetUsed(s.subscriptions.ca, 0)).to.be.greaterThan(s.amounts.caValue);
    });

    it('counts each batch as it lands, and the epoch takes λ with its first value', async () => {
      use(await loadFixture(afterProof));
      const s = stateNow();
      expect((await fx.f.QIS.getEpochTotals(s.E)).totalServed).to.equal(0n);
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.batch-1' })));
      const totals = await fx.f.QIS.getEpochTotals(s.E);
      expect(totals.totalServed).to.be.greaterThan(0n);
      expect(totals.lambdaBps).to.equal(await fx.f.QIS.lambdaBps());
      expect((await fx.f.QIS.getNodeEpoch(fx.seller.identityId, s.E)).servedValue).to.equal(totals.totalServed);
    });

    it('stops once E has ended, sending nothing: a batch lands only in its subscription\'s epoch', async () => {
      use(await loadFixture(afterProof));
      const s = stateNow();
      await toEpoch(s.E + 1n);
      const blocks = await head();
      expect(await errorOf(phaseServe(await ctxOf('serve')))).to.match(new RegExp(`^serve runs in epoch ${s.E}, the epoch of the subscriptions, and a batch lands only there`));
      expect(await head()).to.equal(blocks);
    });

    it('in a dry run, with the fork\'s switches on and no score, sends nothing and moves nothing', async () => {
      use(await loadFixture(afterSetup));
      const s = stateNow();
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      const blocks = await head();
      const clock = await time.latest();
      let ctx: PoolCtx | undefined;
      const calls = await rpcCalls(async () => {
        ctx = await ctxOf('serve', { send: false, local: true, warp: true, proofs: true });
        await phaseServe(ctx);
      });
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect(calls).to.include('eth_call');
      expect(await head()).to.equal(blocks);
      expect(await time.latest()).to.equal(clock);
      expect(await fx.f.RSS.getNodeEpochScore(s.E, fx.seller.identityId)).to.equal(0n);
      expect(ctx?.report.status).to.equal('waiting');
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
      use(await loadFixture(afterProof));
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      const before = fs.readFileSync(stateFile, 'utf8');
      const calls = await rpcCalls(async () => phaseServe(await ctxOf('serve', { send: false, local: true, warp: true, proofs: true })));
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect(fs.readFileSync(stateFile, 'utf8')).to.equal(before);
    });

    it('in claim before it opens, with FORK_WARP, defers and leaves the clock', async () => {
      use(await loadFixture(afterServe));
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      const clock = await time.latest();
      let ctx: PoolCtx | undefined;
      const calls = await rpcCalls(async () => {
        ctx = await ctxOf('claim', { send: false, local: true, warp: true, proofs: true });
        await phaseClaim(ctx);
      });
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect(await time.latest()).to.equal(clock);
      expect(ctx?.report.status).to.equal('deferred');
    });

    it('sends nothing in withdraw, simulates the withdrawal it would send, and leaves the position', async () => {
      use(await loadFixture(afterClaim));
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      const s = stateNow();
      const e = (await fx.f.Chronos.getCurrentEpoch()) + 1n;
      await toEpoch(e, (await fx.f.Chronos.epochLength()) / 2n);
      await scoreIn(e);
      let ctx: PoolCtx | undefined;
      const calls = await rpcCalls(async () => {
        ctx = await ctxOf('withdraw', { send: false, local: true, warp: true, proofs: true });
        await phaseWithdraw(ctx);
      });
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      expect(ctx?.report.txs.find((t) => t.key === 'withdraw.withdraw')?.status).to.equal('simulated');
      expect((await fx.f.Vault.getPosition(s.tokenId)).identityId).to.equal(fx.seller.identityId);
      expect(await fx.f.StakingNFT.ownerOf(s.tokenId)).to.equal(ownerWallet().address);
    });

    it("fails serve when a batch's stake factor isn't what the stake gave before it was sent, and serve stays not done", async () => {
      use(await loadFixture(afterProof));
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.batch-1' })));
      editState((raw) => {
        raw.steps['serve.batch-1'].stakeFactor18 = String(BigInt(raw.steps['serve.batch-1'].stakeFactor18) + 1n);
      });
      const resumed = await ctxOf('serve');
      await phaseServe(resumed);
      expect(failedLabels(resumed).join(' | ')).to.contain('the first batch captured the stake factor its node\'s stake gives');
      expect(resumed.file.done('serve')).to.equal(false);
    });

    it('resumed after the first batch, plans the second, which needs the top-up, rather than failing to simulate it', async () => {
      use(await loadFixture(afterProof));
      await stops(phaseServe(await ctxOf('serve', { stopAt: 'serve.batch-1' })));
      editState((raw) => {
        raw.network = 'fork';
        raw.forkBlock = '1';
      });
      let ctx: PoolCtx | undefined;
      const calls = await rpcCalls(async () => {
        ctx = await ctxOf('serve', { send: false, local: true, warp: true, proofs: true });
        await phaseServe(ctx);
      });
      expect(calls.filter((m) => MUTATING.test(m))).to.deep.equal([]);
      const status = (key: string) => ctx?.report.txs.find((t) => t.key === key)?.status;
      expect(status('serve.top-up')).to.equal('simulated');
      expect(status('serve.batch-2')).to.equal('planned');
      expect(ctx?.report.status).to.not.equal('failed');
    });
  });

  describe('a run label', () => {
    const withRun = (run: string) => {
      const before = process.env.RFC27_SMOKE_RUN;
      process.env.RFC27_SMOKE_RUN = run;
      try {
        return readEnv().run;
      } finally {
        if (before === undefined) delete process.env.RFC27_SMOKE_RUN;
        else process.env.RFC27_SMOKE_RUN = before;
      }
    };

    it('takes letters, digits, dashes and underscores', () => {
      expect(withRun('smoke-1_a')).to.equal('smoke-1_a');
    });

    it("refuses a dot, so a report can't take the name of another run's state", () => {
      expect(() => withRun('smoke.check')).to.throw('RFC27_SMOKE_RUN must be');
    });
  });

  describe('two runs of one owner in the same epoch, whose wallet subscription can only be one of theirs', () => {
    const fundOwner = async () => {
      const { needed } = await fundExactly();
      return needed;
    };

    it('defers the second run before it spends anything, and the first goes on', async () => {
      use(await loadFixture(afterProof));
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

      // The first run's resume is untouched: its subscription is its own.
      const first = await ctxOf('serve');
      await phaseServe(first);
      passes(first);
      expect(first.file.done('serve')).to.equal(true);
    });

    it('lets the second run through in the next epoch, with a wallet subscription of its own that it can serve', async () => {
      use(await loadFixture(afterSetup));
      await fundOwner();
      const E = stateNow().E;
      await toEpoch(E + 1n);
      const second = await ctxOf('setup', { run: 'b' });
      await phaseSetup(second);
      passes(second);
      await scoreIn(E + 1n);
      const serve = await ctxOf('serve', { run: 'b' });
      await phaseServe(serve);
      passes(serve);
      const held = decodeState(JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8')));
      expect(held.E).to.equal(E + 1n);
      expect((await fx.f.SSS.getSubscription(held.subscriptions.wallet ?? '')).sessionKey).to.equal(derived('b/wallet-session').address);
    });

    it('stops a run whose account subscription is funded in that epoch when another run took the wallet subscription, sending nothing', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { run: 'b', stopAt: 'setup.fund-account-subscription' })));
      const first = await ctxOf('setup');
      await phaseSetup(first);
      passes(first);
      const blocks = await head();
      expect(await errorOf(phaseSetup(await ctxOf('setup', { run: 'b' })))).to.match(/is another run's: .*and this run funded its account subscription in that epoch: start a new run$/);
      expect(await head()).to.equal(blocks);
    });

    it('keeps a resume of the same run working, whose subscription is its own', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.fund-wallet-subscription:sent' })));
      const resumed = await ctxOf('setup');
      await phaseSetup(resumed);
      passes(resumed);
      expect(resumed.file.done('setup')).to.equal(true);
    });

    it('takes a subscription of the run\'s own key on other terms for a clash too: PHASE=check says so, and a resume stops, sending nothing', async () => {
      use(await loadFixture(deployFixture));
      await fundExactly();
      await stops(phaseSetup(await ctxOf('setup', { stopAt: 'setup.fund-wallet-subscription' })));
      editState((raw) => {
        raw.amounts.walletValue = String(BigInt(raw.amounts.walletValue) + TRAC);
      });
      const check = await ctxOf('check', { send: false });
      await phaseCheck(check);
      expect(checkOf(check, 'if it has one, is this run\'s').ok).to.equal(false);
      const blocks = await head();
      expect(await errorOf(phaseSetup(await ctxOf('setup')))).to.match(/and this run funded its account subscription in that epoch: start a new run$/);
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

  describe('claim, against what the chain holds', () => {
    const served = async () => {
      use(await loadFixture(afterServe));
      return stateNow();
    };
    /** Fails on what the chain holds, sends nothing, and the run goes no further. */
    const failsAndGoesNoFurther = async (ctx: PoolCtx, label: string) => {
      const blocks = await head();
      await phaseClaim(ctx);
      expect(ctx.report.status).to.equal('failed');
      expect(checkOf(ctx, label).ok, label).to.equal(false);
      expect(ctx.file.done('claim')).to.equal(false);
      expect(await head()).to.equal(blocks);
      expect(await errorOf(phaseWithdraw(await ctxOf('withdraw')))).to.equal('run PHASE=claim SEND=1 first');
    };
    /** A writer of the storage's narrow setters, as a later logic version would be. */
    const writer = async () => {
      const account = fx.f.accounts[46];
      await fx.f.Hub.setContractAddress('PoolWriter', account.address);
      return fx.f.QIS.connect(account);
    };

    it('pays right after E ends, with no upkeep call of any kind before it', async () => {
      const s = await served();
      await toEpoch(s.E + 1n);
      expect((await fx.f.Vault.getPosition(s.tokenId)).lastClaimedEpoch).to.be.lessThan(s.E);
      const ctx = await ctxOf('claim');
      await phaseClaim(ctx);
      passes(ctx);
      expect(ctx.file.done('claim')).to.equal(true);
      expect(checkOf(ctx, 'claimFor pays what the epochs\' nets give').ok).to.equal(true);
      expect(checkOf(ctx, 'the position is paid a share of epoch').ok).to.equal(true);
      expect(Object.keys(rawState().steps).filter((k) => k.startsWith('claim.'))).to.deep.equal(['claim.claim']);
    });

    it('defers before E has ended, failing nothing', async () => {
      await served();
      const ctx = await ctxOf('claim');
      await phaseClaim(ctx);
      expect(ctx.report.status).to.equal('deferred');
      expect(ctx.report.failed).to.equal(0);
    });

    it('fails a budget that counted other than the run landed, by its events', async () => {
      const s = await served();
      await toEpoch(s.E + 1n);
      editState((raw) => {
        raw.amounts.walletValue = String(BigInt(raw.amounts.walletValue) + TRAC);
      });
      await failsAndGoesNoFurther(await ctxOf('claim'), 'the wallet budget counted all the seller claimed');
    });

    it('fails a fill the batches do not show', async () => {
      const s = await served();
      const qis = await writer();
      await qis.setBudgetUsed(s.subscriptions.wallet, 0, (await fx.f.QIS.budgetUsed(s.subscriptions.wallet, 0)) - 1n);
      await toEpoch(s.E + 1n);
      await failsAndGoesNoFurther(await ctxOf('claim'), 'the wallet budget counted all the seller claimed');
    });

    describe('with other value in the seller\'s R and in the epoch\'s', () => {
      /** The seller and another land on another buyer's subscription of E. */
      const otherValue = async () => {
        const s = await served();
        const subscription = await fx.helpers.walletFund(fx.f.accounts[21], s.E, 50n * TRAC);
        const other = await fx.helpers.createSeller(100_000n * TRAC, 0n);
        await fx.helpers.scoreEpoch(s.E, other, 10n ** 18n);
        await fx.helpers.claimReceipts(fx.seller, subscription, 10n * TRAC);
        await fx.helpers.claimReceipts(other, subscription, 5n * TRAC);
        return { s, other };
      };

      it('takes what they counted: each budget, R and ΣR hold', async () => {
        const { s } = await otherValue();
        await toEpoch(s.E + 1n);
        const ctx = await ctxOf('claim');
        await phaseClaim(ctx);
        passes(ctx);
        expect(ctx.file.done('claim')).to.equal(true);
        expect(checkOf(ctx, 'R and score in epoch').detail).to.contain('4 groups');
        expect(checkOf(ctx, 'ΣR and ΣQueryInferenceScore').detail).to.contain('5 groups');
      });

      it('fails an R that holds what no batch shows, though the epoch\'s sum holds', async () => {
        const { s } = await otherValue();
        const qis = await writer();
        const node = await fx.f.QIS.getNodeEpoch(fx.seller.identityId, s.E);
        await qis.setNodeEpoch(fx.seller.identityId, s.E, { servedValue: node.servedValue + 1n, weightedValue: node.weightedValue });
        await toEpoch(s.E + 1n);
        const ctx = await ctxOf('claim');
        await failsAndGoesNoFurther(ctx, 'R and score in epoch');
        expect(checkOf(ctx, 'ΣR and ΣQueryInferenceScore').ok).to.equal(true);
      });

      it('fails a score that holds what no batch shows, at the R it was due', async () => {
        const { s } = await otherValue();
        const qis = await writer();
        const node = await fx.f.QIS.getNodeEpoch(fx.seller.identityId, s.E);
        await qis.setNodeEpoch(fx.seller.identityId, s.E, { servedValue: node.servedValue, weightedValue: node.weightedValue + 1n });
        await toEpoch(s.E + 1n);
        await failsAndGoesNoFurther(await ctxOf('claim'), 'R and score in epoch');
      });

      it('fails a ΣR that holds what no batch shows, though the seller\'s R holds', async () => {
        const { s } = await otherValue();
        const qis = await writer();
        const totals = await fx.f.QIS.getEpochTotals(s.E);
        await qis.setEpochTotals(s.E, { totalServed: totals.totalServed + 1n, totalWeighted: totals.totalWeighted, lambdaBps: totals.lambdaBps });
        await toEpoch(s.E + 1n);
        const ctx = await ctxOf('claim');
        await failsAndGoesNoFurther(ctx, 'ΣR and ΣQueryInferenceScore');
        expect(checkOf(ctx, 'R and score in epoch').ok).to.equal(true);
      });

      it('fails a group of ours counted at too little, though the other value lifts R past all ours were due', async () => {
        const { s } = await otherValue();
        await toEpoch(s.E + 1n);
        // What the run planned for the budget is more than its events show.
        editState((raw) => {
          raw.amounts.caValue = String(BigInt(raw.amounts.caValue) + 2n * TRAC);
        });
        const ctx = await ctxOf('claim');
        await failsAndGoesNoFurther(ctx, 'the account budget counted all the seller claimed');
        expect(checkOf(ctx, 'R and score in epoch').ok).to.equal(true);
      });
    });

    describe('with what is booked in E against what the subscriptions of E were funded with', () => {
      /** The wallet money booked in `epoch`, `less` short of what was funded, as a booking that fell short leaves it. */
      const bookedShort = async (epoch: bigint, less: bigint) => {
        const qis = await fx.f.QIS.getAddress();
        const { wallet } = await fx.f.QIS.fundingIn(epoch);
        for (let at = 0; at < 200; at++) {
          const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [epoch, at]));
          if (BigInt(await getStorageAt(qis, slot)) === wallet) {
            await setStorageAt(qis, slot, wallet - less);
            return;
          }
        }
        throw new Error('no slot holds the wallet money booked');
      };
      /** A run past its serve, with another buyer's funding of E beside its own. */
      const servedBesideAnother = async () => {
        const s = await served();
        await fx.helpers.walletFund(fx.f.accounts[21], s.E, 5n * TRAC);
        return s;
      };

      it('refuses a booking of ours that fell short, though another buyer\'s funding lifts the money past ours: it sends nothing', async () => {
        const s = await servedBesideAnother();
        await toEpoch(s.E + 1n);
        await bookedShort(s.E, TRAC);
        expect((await fx.f.QIS.fundingIn(s.E)).wallet).to.be.greaterThan(s.amounts.walletValue); // what a lower bound would have taken
        await failsAndGoesNoFurther(await ctxOf('claim'), 'what is booked in epoch');
      });

      it('refuses a booking that holds what no funding shows', async () => {
        const s = await servedBesideAnother();
        const qis = await writer();
        await qis.addWalletFunding(s.E, 1n);
        await toEpoch(s.E + 1n);
        await failsAndGoesNoFurther(await ctxOf('claim'), 'what is booked in epoch');
      });

      it('takes another buyer\'s subscription of E funded in the epoch before, and top-ups, to the wei, and leaves out subscriptions of other epochs', async () => {
        use(await loadFixture(deployFixture));
        const before = await fx.f.Chronos.getCurrentEpoch();
        await fx.helpers.walletFund(fx.f.accounts[21], before + 1n, 5n * TRAC);
        await fx.helpers.walletFund(fx.f.accounts[22], before, 3n * TRAC);
        await toEpoch(before + 1n);
        await fundExactly();
        await phaseSetup(await ctxOf('setup'));
        await scoreIn(before + 1n);
        await phaseServe(await ctxOf('serve'));
        const s = stateNow();
        await fx.helpers.walletFund(fx.f.accounts[23], s.E + 1n, 4n * TRAC);
        await toEpoch(s.E + 1n);
        const ctx = await ctxOf('claim');
        await phaseClaim(ctx);
        passes(ctx);
        const raw = rawState();
        expect(BigInt(raw.amounts.walletValue) + 5n * TRAC).to.equal((await fx.f.QIS.fundingIn(s.E)).wallet);
        expect(checkOf(ctx, 'what is booked in epoch').detail).to.contain(`wallet ${fmt(BigInt(raw.amounts.walletValue) + 5n * TRAC)} of`);
      });
    });
  });

  describe('claim', () => {
    /** A claim of the position outside the phase, as the upkeep cron's would be. */
    const upkeepClaims = async (tokenId: bigint) => (await fx.f.StakingV10.connect(fx.f.accounts[20]).claimFor(tokenId)).wait();

    it('resumed after its claim: nothing is sent again, also an epoch later', async () => {
      use(await loadFixture(afterServe));
      const s = stateNow();
      await toEpoch(s.E + 1n);
      await stops(phaseClaim(await ctxOf('claim', { stopAt: 'claim.claim' })));
      const before = await fx.f.Vault.getPosition(s.tokenId);
      await toEpoch(s.E + 2n);
      const resumed = await ctxOf('claim');
      await phaseClaim(resumed);
      passes(resumed);
      expect(resumed.file.done('claim')).to.equal(true);
      const after = await fx.f.Vault.getPosition(s.tokenId);
      expect(after.raw).to.equal(before.raw);
      expect(after.lastClaimedEpoch).to.equal(before.lastClaimedEpoch);
      expect(checkOf(resumed, 'the position was claimed for epochs').label).to.contain('by this phase before it was interrupted');
    });

    /** The position's raw stake a wei short of what its claims paid: their receipts and the cumulative rewards stay as they are. */
    const uncredited = async (tokenId: bigint) => {
      const contract = fx.f.accounts[48];
      await fx.f.Hub.setContractAddress('UncreditingContract', contract.address);
      await fx.f.Vault.connect(contract).decreaseRaw(tokenId, 1n);
    };
    const failsOnTheRawStake = async (s: SetupState) => {
      await uncredited(s.tokenId);
      const blocks = await head();
      const ctx = await ctxOf('claim');
      await phaseClaim(ctx);
      expect(checkOf(ctx, 'the position was claimed for epochs').ok).to.equal(true);
      expect(checkOf(ctx, 'compounded into the position\'s raw stake').ok).to.equal(false);
      expect(ctx.file.done('claim')).to.equal(false);
      expect(await head()).to.equal(blocks);
    };

    it('fails a replayed claim that did not reach the raw stake, though its receipts and the cumulative rewards are right', async () => {
      use(await loadFixture(afterServe));
      const s = stateNow();
      await toEpoch(s.E + 1n);
      await stops(phaseClaim(await ctxOf('claim', { stopAt: 'claim.claim' })));
      await failsOnTheRawStake(s);
    });

    it('fails the upkeep cron\'s claim that did not reach the raw stake, the same way', async () => {
      use(await loadFixture(afterServe));
      const s = stateNow();
      await toEpoch(s.E + 1n);
      await upkeepClaims(s.tokenId);
      await failsOnTheRawStake(s);
    });

    describe('with a claim whose stored net and payment are consistently too small', () => {
      /** Fails on the nets alone: what the claim stored and paid agree with each other, and with the position. */
      const failsOnTheNets = async (ctx: PoolCtx, label: string) => {
        expect(checkOf(ctx, label).ok, label).to.equal(false);
        expect(checkOf(ctx, 'StakingKPI gives each epoch the net').ok).to.equal(false);
        expect(checkOf(ctx, 'compounded into the position\'s raw stake').ok).to.equal(true);
        expect(ctx.file.done('claim')).to.equal(false);
      };

      it('fails the upkeep cron\'s, sending nothing', async () => {
        use(await loadFixture(afterServe));
        const s = stateNow();
        await toEpoch(s.E + 1n);
        await tooSmall(() => upkeepClaims(s.tokenId));
        const blocks = await head();
        const ctx = await ctxOf('claim');
        await phaseClaim(ctx);
        await failsOnTheNets(ctx, 'the position was claimed for epochs');
        expect(await head()).to.equal(blocks);
      });

      it('fails this run\'s, interrupted, sending nothing', async () => {
        use(await loadFixture(afterServe));
        const s = stateNow();
        await toEpoch(s.E + 1n);
        await tooSmall(async () => stops(phaseClaim(await ctxOf('claim', { stopAt: 'claim.claim' }))));
        const blocks = await head();
        const ctx = await ctxOf('claim');
        await phaseClaim(ctx);
        await failsOnTheNets(ctx, 'the position was claimed for epochs');
        expect(await head()).to.equal(blocks);
      });

      it('fails this run\'s own, on a net another position\'s claim stored too small', async () => {
        use(await loadFixture(afterServe));
        const s = stateNow();
        await toEpoch(s.E + 1n);
        await tooSmall(() => upkeepClaims(fx.seller.tokenId));
        const ctx = await ctxOf('claim');
        await phaseClaim(ctx);
        expect(checkOf(ctx, 'claimFor pays what the epochs\' nets give').ok).to.equal(false);
        expect(checkOf(ctx, 'StakingKPI gives each epoch the net').ok).to.equal(false);
        expect(ctx.file.done('claim')).to.equal(false);
      });
    });

    it('passes a correct claim to the wei, with a fee and a pool that floor, on the upkeep cron\'s and on one resumed', async () => {
      for (const resumed of [false, true]) {
        use(await loadFixture(afterServe));
        const s = stateNow();
        await feeIs(1_237n);
        await fx.helpers.publishingPool(s.E, 7n * TRAC + 1n);
        await toEpoch(s.E + 1n);
        if (resumed) await stops(phaseClaim(await ctxOf('claim', { stopAt: 'claim.claim' })));
        else await upkeepClaims(s.tokenId);
        const ctx = await ctxOf('claim');
        await phaseClaim(ctx);
        passes(ctx);
        expect(ctx.file.done('claim')).to.equal(true);
        expect(checkOf(ctx, 'the position was claimed for epochs').ok).to.equal(true);
      }
    });

    it('checks what the upkeep cron claimed, from the claims the chain recorded, and claims the rest itself', async () => {
      use(await loadFixture(afterServe));
      const s = stateNow();
      await toEpoch(s.E + 1n);
      await upkeepClaims(s.tokenId);
      await toEpoch(s.E + 2n);
      const ctx = await ctxOf('claim');
      await phaseClaim(ctx);
      passes(ctx);
      const by = checkOf(ctx, 'the position was claimed for epochs');
      expect(by.label).to.contain('another caller (the upkeep cron)');
      expect(by.detail).to.contain('in 1 claim');
      expect(checkOf(ctx, 'claimFor pays what the epochs\' nets give').ok).to.equal(true);
      expect(checkOf(ctx, 'the position is paid a share of epoch').ok).to.equal(true);
    });
  });

  describe('every ended epoch\'s pool, against the rollover rule', () => {
    const MONEY = 5n * TRAC;
    /** Another buyer's subscription of this epoch, which ends with no value counted in it, and the clock in the next: the empty epoch. */
    const anEmptyEpochWithMoney = async () => {
      use(await loadFixture(deployFixture));
      const empty = await fx.f.Chronos.getCurrentEpoch();
      await fx.helpers.walletFund(fx.f.accounts[21], empty, MONEY);
      await toEpoch(empty + 1n);
      return empty;
    };
    /** A whole run from here, and the clock in E+1. */
    const aRun = async () => {
      await fundExactly();
      await phaseSetup(await ctxOf('setup'));
      await scoreIn(stateNow().E);
      await phaseServe(await ctxOf('serve'));
      const s = stateNow();
      await toEpoch(s.E + 1n);
      return s;
    };

    it('takes real money rolled across an empty epoch to the wei', async () => {
      const empty = await anEmptyEpochWithMoney();
      const s = await aRun();
      const ctx = await ctxOf('claim');
      await phaseClaim(ctx);
      passes(ctx);
      expect(ctx.file.done('claim')).to.equal(true);
      const booked = await fx.f.QIS.fundingIn(s.E);
      expect(await fx.f.QS.epochPool(empty)).to.equal(0n);
      expect(await fx.f.QS.epochPool(s.E)).to.equal(booked.wallet + booked.account + MONEY);
      expect(checkOf(ctx, 'every ended epoch from').detail).to.equal('0.0 TRAC waiting for the next epoch with value');
    });

    it('fails a pool the rule does not give, naming the epoch: the phase sends nothing and stays incomplete', async () => {
      const empty = await anEmptyEpochWithMoney();
      await aRun();
      const blocks = await head();
      const ctx = await ctxOf('claim');
      ctx.c = {
        ...ctx.c,
        qs: new Proxy(ctx.c.qs, {
          get: (t, k) => (k === 'epochPool' ? async (e: bigint) => (e === empty ? MONEY : t.epochPool(e)) : Reflect.get(t, k)),
        }),
      };
      await phaseClaim(ctx);
      expect(ctx.report.status).to.equal('failed');
      expect(checkOf(ctx, 'every ended epoch from').ok).to.equal(false);
      expect(checkOf(ctx, 'every ended epoch from').detail).to.equal(`epoch ${empty} pools ${fmt(MONEY)} TRAC, and the rule gives 0.0 TRAC`);
      expect(ctx.report.why).to.contain(`epoch ${empty} pools`);
      expect(ctx.file.done('claim')).to.equal(false);
      expect(await head()).to.equal(blocks);
      expect(await errorOf(phaseWithdraw(await ctxOf('withdraw')))).to.equal('run PHASE=claim SEND=1 first');
    });
  });

  describe('the first block at a time', () => {
    /** Blocks 2 s apart, from 1,000,000 at time 0, and an endpoint that has pruned all before block 1,000,000. */
    const chain = { getBlock: async (n: number) => {
      if (n < 1_000_000) throw new Error(`pruned history unavailable: requested ${n}`);
      return { timestamp: (n - 1_000_000) * 2 };
    } } as unknown as Parameters<typeof firstBlockAt>[0];

    it('is found stepping back from a later block, reading none of what is long past', async () => {
      expect(await firstBlockAt(chain, 200_000n, 1_200_000)).to.equal(1_100_000);
      expect(await firstBlockAt(chain, 200_001n, 1_200_000)).to.equal(1_100_001);
      expect(await firstBlockAt(chain, 400_000n, 1_200_000)).to.equal(1_200_000);
      expect(await firstBlockAt(chain, 399_990n, 1_200_000)).to.equal(1_199_995);
    });

    it('is block 0 when every block is at or after it', async () => {
      const from0 = { getBlock: async (n: number) => ({ timestamp: 100 + n }) } as unknown as Parameters<typeof firstBlockAt>[0];
      expect(await firstBlockAt(from0, 50n, 1_000)).to.equal(0);
      expect(await firstBlockAt(from0, 100n, 1_000)).to.equal(0);
      expect(await firstBlockAt(from0, 101n, 1_000)).to.equal(1);
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
    /** The middle of the epoch after the run's claim, before any proof in it, with something for it to pay. */
    const toMiddle = async () => {
      const e = await fx.f.Chronos.getCurrentEpoch();
      await toEpoch(e + 1n, (await fx.f.Chronos.epochLength()) / 2n);
      await fx.helpers.publishingPool(e + 1n, 10n * TRAC);
      return e + 1n;
    };

    it('waits, burning nothing, until the position holds score in the epoch, then goes through', async () => {
      use(await loadFixture(afterClaim));
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
      use(await loadFixture(afterClaim));
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
      use(await loadFixture(afterClaim));
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

    it('fails the claim of a withdrawn epoch whose stored net and payment are consistently too small, by the run or by another caller', async () => {
      for (const byAnother of [false, true]) {
        use(await loadFixture(afterClaim));
        const { tokenId } = stateNow();
        const e = await toMiddle();
        await scoreIn(e);
        await phaseWithdraw(await ctxOf('withdraw'));
        await toEpoch(e + 1n);
        await tooSmall(async () => {
          if (byAnother) await fx.f.StakingV10.connect(fx.f.accounts[20]).claimWithdrawnEpoch(tokenId);
          else await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: 'withdraw.claim-withdrawn-epoch' })));
        });
        const ctx = await ctxOf('withdraw');
        await phaseWithdraw(ctx);
        expect(checkOf(ctx, byAnother ? 'claimed by another caller' : 'claimWithdrawnEpoch pays the owner').ok).to.equal(false);
        expect(checkOf(ctx, 'stored net is what its publishing share').ok).to.equal(false);
        expect(ctx.file.done('withdraw')).to.equal(false);
      }
    });

    it('fails a withdrawal whose automatic claim reads a net another position\'s claim stored too small', async () => {
      use(await loadFixture(afterClaim));
      const e = await toMiddle();
      await scoreIn(e);
      await toEpoch(e + 1n, (await fx.f.Chronos.epochLength()) / 2n);
      await tooSmall(() => fx.f.StakingV10.connect(fx.f.accounts[20]).claimFor(fx.seller.tokenId));
      await scoreIn(e + 1n);
      const ctx = await ctxOf('withdraw');
      await phaseWithdraw(ctx);
      expect(checkOf(ctx, 'the withdrawal pays the stake').ok).to.equal(false);
      expect(rawState().withdrawal).to.equal(undefined);
    });

    describe('with a withdrawn epoch that earned nothing', () => {
      const CLAIM = 'withdraw.claim-withdrawn-epoch';
      /** The position withdrawn in an epoch with a score and no reward, and the clock in the next. */
      const withdrawn = async () => {
        use(await loadFixture(afterClaim));
        const e = (await fx.f.Chronos.getCurrentEpoch()) + 1n;
        await toEpoch(e, (await fx.f.Chronos.epochLength()) / 2n);
        await scoreIn(e);
        const first = await ctxOf('withdraw');
        await phaseWithdraw(first);
        passes(first);
        await toEpoch(e + 1n);
        return { tokenId: stateNow().tokenId };
      };

      it('takes the exact zero its claim pays, and the run completes', async () => {
        await withdrawn();
        const owner = ownerWallet().address;
        const before = await fx.f.Token.balanceOf(owner);
        const ctx = await ctxOf('withdraw');
        await phaseWithdraw(ctx);
        passes(ctx);
        expect(ctx.file.done('withdraw')).to.equal(true);
        expect(checkOf(ctx, 'claimWithdrawnEpoch pays the owner').detail).to.contain('0.0 TRAC, expected 0.0');
        expect(await fx.f.Token.balanceOf(owner)).to.equal(before);
      });

      it('takes the exact zero another caller\'s claim paid, and the run completes', async () => {
        const { tokenId } = await withdrawn();
        await fx.f.StakingV10.connect(fx.f.accounts[20]).claimWithdrawnEpoch(tokenId);
        const ctx = await ctxOf('withdraw');
        await phaseWithdraw(ctx);
        passes(ctx);
        expect(ctx.file.done('withdraw')).to.equal(true);
        expect(checkOf(ctx, 'claimed by another caller').detail).to.contain('0.0 TRAC, expected 0.0');
      });

      it('fails a claim that paid nothing while a share was due, by the run or by another caller', async () => {
        for (const byAnother of [false, true]) {
          const { tokenId } = await withdrawn();
          if (byAnother) await fx.f.StakingV10.connect(fx.f.accounts[20]).claimWithdrawnEpoch(tokenId);
          else await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: CLAIM })));
          const ctx = await ctxOf('withdraw');
          // The views give the position a share, which the claim did not pay.
          ctx.c = { ...ctx.c, qs: new Proxy(ctx.c.qs, { get: (t, k) => (k === 'queryInferenceGross' ? async () => 10n * TRAC : Reflect.get(t, k)) }) };
          await phaseWithdraw(ctx);
          expect(failedLabels(ctx).join(' | ')).to.contain(byAnother ? 'claimed by another caller' : 'claimWithdrawnEpoch pays the owner');
          expect(ctx.file.done('withdraw')).to.equal(false);
        }
      });

      it('fails an expected zero that comes from a score other than the one recorded', async () => {
        await withdrawn();
        editState((raw) => {
          raw.withdrawal.recordedScore = String(BigInt(raw.withdrawal.recordedScore) + 1n);
        });
        const ctx = await ctxOf('withdraw');
        await phaseWithdraw(ctx);
        expect(failedLabels(ctx).join(' | ')).to.contain('is the one its withdrawal recorded');
        expect(ctx.file.done('withdraw')).to.equal(false);
      });
    });

    describe('with this run\'s claim of the withdrawn epoch reverting', () => {
      const CLAIM = 'withdraw.claim-withdrawn-epoch';
      /** The position withdrawn, with something to claim of that epoch, and the clock in the next: the claim is what is left. */
      const withdrawn = async () => {
        use(await loadFixture(afterClaim));
        const e = await toMiddle();
        await scoreIn(e);
        await phaseWithdraw(await ctxOf('withdraw'));
        await toEpoch(e + 1n);
        return stateNow().tokenId;
      };
      const statusOf = async (hash: string) => (await hre.ethers.provider.getTransactionReceipt(hash))?.status;

      for (const [when, stopAt] of [
        ['it waits for its receipt', undefined],
        ['it crashes once its attempt is sent', `${CLAIM}:sent`],
      ]) {
        it(`on a claim by the upkeep cron between its estimate and its mining, as ${when}: a resume takes the cron's, sending nothing`, async () => {
          const tokenId = await withdrawn();
          let cron: { hash: string } = { hash: '' };
          const owner = ownerBeside(fx.f.StakingV10.interface.getFunction('claimWithdrawnEpoch').selector, async () => {
            cron = await fx.f.StakingV10.connect(fx.f.accounts[20]).claimWithdrawnEpoch(tokenId, { gasLimit: 5_000_000n, maxPriorityFeePerGas: 10n ** 11n, maxFeePerGas: 10n ** 12n });
          });
          const first = phaseWithdraw(await ctxOf('withdraw', { owner, stopAt }));
          if (stopAt) await stops(first);
          else expect(await errorOf(first)).to.match(/reverted on chain/);
          expect(await statusOf(rawState().steps[CLAIM].hash)).to.equal(0);
          expect(await statusOf(cron.hash)).to.equal(1);
          await inTheBlockOf(CLAIM, cron);

          const blocks = await head();
          const resumed = await ctxOf('withdraw');
          await phaseWithdraw(resumed);
          passes(resumed);
          expect(resumed.file.done('withdraw')).to.equal(true);
          expect(await head()).to.equal(blocks);
          expect(checkOf(resumed, 'claimed by another caller').detail).to.contain(cron.hash);
        });
      }

      it('with the withdrawn epoch still to claim: the attempt is made again, and pays', async () => {
        const tokenId = await withdrawn();
        expect(await errorOf(phaseWithdraw(await ctxOf('withdraw', { owner: ownerShortOfGas() })))).to.match(/reverted on chain/);
        const reverted = rawState().steps[CLAIM].hash;
        expect(await statusOf(reverted)).to.equal(0);
        const c = await (await Stack.at(hre, await fx.f.Hub.getAddress())).pool();
        expect((await c.cws.getWithdrawal(tokenId))[0].epoch).to.not.equal(0n);

        const resumed = await ctxOf('withdraw');
        await phaseWithdraw(resumed);
        passes(resumed);
        expect(resumed.file.done('withdraw')).to.equal(true);
        expect(rawState().steps[CLAIM].hash).to.not.equal(reverted);
        expect(checkOf(resumed, 'claimWithdrawnEpoch pays the owner').ok).to.equal(true);
      });
    });

    it('refuses a journaled withdrawal that does not hold all it is expected to do, and reads one that does as it was written', async () => {
      use(await loadFixture(afterClaim));
      await scoreIn(await toMiddle());
      await stops(phaseWithdraw(await ctxOf('withdraw', { stopAt: 'withdraw.withdraw' })));
      const { expected } = rawState().steps['withdraw.withdraw'];
      expect(Object.keys(expected).sort()).to.deep.equal(['auto', 'epoch', 'raw', 'score']);
      expect(decodeState(rawState()).steps['withdraw.withdraw'].expected?.raw).to.equal(BigInt(expected.raw));
      editState((raw) => {
        raw.steps['withdraw.withdraw'].expected = { epoch: expected.epoch, raw: expected.raw, auto: expected.auto, scor: expected.score };
      });
      expect(() => decodeState(rawState())).to.throw('expected.score is not an integer');
    });

    it('stays on its part while a check fails, and runs again sending nothing', async () => {
      use(await loadFixture(afterClaim));
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
      use(await loadFixture(afterClaim));
      const raw = rawState();
      expect(raw.refs).to.equal(undefined);
      for (const p of ['setup', 'serve', 'claim']) expect(raw.phases[p], p).to.deep.equal({ status: 'done', failedChecks: 0 });
      const check = await ctxOf('check', { send: false });
      await phaseCheck(check);
      expect(failedLabels(check)).to.deep.equal([]);
      expect(check.report.data.needs).to.include({ ownerTrac: '0' });
    });
  });
});
