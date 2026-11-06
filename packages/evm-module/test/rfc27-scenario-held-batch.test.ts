// The held batch of the OT-RFC-27 marketplace scenario (scripts/rfc27/scenario): the
// one send that is not simulated, so that the chain records its failure. It runs
// against stubs of the chain, with the real plan, signing and encoding. The run is
// `npx hardhat test test/rfc27-scenario-held-batch.test.ts --no-compile --network hardhat --config hardhat.node.config.ts`.

import { expect } from 'chai';
import { ethers } from 'ethers';

import QueryInferenceSettlement from '../abi/QueryInferenceSettlement.json';
import { Fault } from './helpers/query-inference';
import { BUYERS, EPOCH_SECONDS, FIRST_EPOCH } from '../scripts/rfc27/scenario/config';
import type { SellerName } from '../scripts/rfc27/scenario/config';
import { buyerWallet, seedFromHex, sessionWallet } from '../scripts/rfc27/scenario/keys';
import { epochStart, planEpoch, subscriptionIdFor } from '../scripts/rfc27/scenario/plan';
import { publicFile } from '../scripts/rfc27/scenario/public';
import { send } from '../scripts/rfc27/scenario/chain';
import { HELD_BATCH_GAS_LIMIT, heldBatch } from '../scripts/rfc27/scenario/tick';
import type { TickDeps, TickState, Times } from '../scripts/rfc27/scenario/tick';

const SEED = seedFromHex(ethers.id('held batch test seed'));
const HELD_EPOCH = FIRST_EPOCH + 2;
const NEXT_EPOCH = HELD_EPOCH + 1;
const SELLER_ID = 1;
const QS = '0x00000000000000000000000000000000000000a1';
const QIS = '0x00000000000000000000000000000000000000a2';
const HASH = `0x${'ab'.repeat(32)}`;
const qsInterface = new ethers.Interface(QueryInferenceSettlement);

class State implements TickState {
  held = new Set<number>();
  retryLanding = (): boolean => false;
  setRetryLanding = (): void => undefined;
  heldDone = (e: number): boolean => this.held.has(e);
  markHeldDone = (e: number): void => void this.held.add(e);
  unmarkHeldDone = (e: number): void => void this.held.delete(e);
}

const timesOf = (epoch: number): Times => {
  const start = epochStart(epoch);
  return { now: start + 600, epoch, offset: epoch - FIRST_EPOCH, start, secondsIn: 600, secondsLeft: EPOCH_SECONDS - 600 };
};

function world(opts: { score?: bigint; baseFee?: bigint; receiptStatus?: string; sendThrows?: boolean; reason?: string } = {}) {
  const sent: ethers.TransactionRequest[] = [];
  const calls: unknown[] = [];
  const events: { kind: string; fields: Record<string, unknown> }[] = [];
  const counters = { simulations: 0 };
  const state = new State();
  const score = { value: opts.score ?? 1n };
  const baseFee = { value: opts.baseFee ?? 5_000_000n };

  const buyerOf = new Map(BUYERS.map((b) => [subscriptionIdFor(buyerWallet(SEED, b.name).address, HELD_EPOCH), b.name]));
  const plan = planEpoch(SEED, HELD_EPOCH);
  const provider = {
    estimateGas: async () => {
      counters.simulations++;
      return 100_000n;
    },
    getNetwork: async () => ({ chainId: 84532n }),
    getBlock: async () => ({ baseFeePerGas: baseFee.value }),
    getTransactionCount: async () => 5,
    send: async (method: string) =>
      method === 'eth_getTransactionReceipt' ? { status: opts.receiptStatus ?? '0x0', gasUsed: '0x25000', effectiveGasPrice: '0x5b8d80', blockNumber: '0x10', logs: [] } : null,
    call: async (tx: unknown) => {
      calls.push(tx);
      throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: opts.reason ?? qsInterface.encodeErrorResult('GroupFault', [0, Fault.OutsideEpoch]) });
    },
  };
  const seller = {
    getAddress: async () => '0x8891Ad8396d5FE34c9A3c778bCbb99F20fbD4954',
    sendTransaction: async (tx: ethers.TransactionRequest) => {
      if (opts.sendThrows) throw new Error('the connection dropped');
      sent.push(tx);
      return { hash: HASH };
    },
  };
  const c = {
    qs: { getAddress: async () => QS, interface: qsInterface, target: QS },
    qis: { getAddress: async () => QIS },
    rss: { getNodeEpochScore: async () => score.value },
    sss: {
      getSubscription: async (id: string) => {
        const buyer = buyerOf.get(id);
        if (!buyer) throw new Error(`no subscription ${id}`);
        return { startsAt: BigInt(plan.start), sessionKey: sessionWallet(SEED, buyer, HELD_EPOCH).address, accountId: 0n, buyer: buyerWallet(SEED, buyer).address, grantNonce: 0n };
      },
      getBudgets: async (id: string) => plan.subscriptions.find((s) => s.buyer === buyerOf.get(id))?.budgets,
    },
  };
  const log = { event: (kind: string, fields: Record<string, unknown> = {}) => void events.push({ kind, fields }) };
  const deps = {
    provider,
    c,
    seed: SEED,
    pub: publicFile(SEED),
    beacon: 'beacon-03',
    seller,
    signerOf: (w: ethers.Wallet) => w,
    log,
    state,
    sender: { provider, log, waitMs: 1_000 },
  } as unknown as TickDeps;
  const tick = (who: SellerName = 'beacon-03', epoch = NEXT_EPOCH) => heldBatch(deps, who, SELLER_ID, timesOf(epoch));
  return { sent, calls, events, counters, state, score, baseFee, tick, kinds: () => events.map((e) => e.kind) };
}

describe('@unit OT-RFC-27 scenario held batch', function () {
  this.timeout(60_000);

  it('goes out once the epoch has ended, unsimulated, with the fixed gas limit', async () => {
    const w = world();
    await w.tick();
    expect(w.sent.length).to.equal(1);
    expect(w.counters.simulations).to.equal(0);
    expect(w.sent[0].gasLimit).to.equal(HELD_BATCH_GAS_LIMIT);
    expect(w.sent[0].to).to.equal(QS);
    const decoded = qsInterface.decodeFunctionData('submitReceiptBatch', w.sent[0].data as string);
    const items = (decoded[0] as { items: unknown[] }[]).reduce((a, g) => a + g.items.length, 0);
    expect(items).to.equal(planEpoch(SEED, HELD_EPOCH).calls.filter((x) => x.held).length);
  });

  it('logs the refusal read back from the chain as expected, with its transaction', async () => {
    const w = world();
    await w.tick();
    const missed = w.events.find((e) => e.kind === 'held-batch-missed');
    expect(missed?.fields.expected).to.equal(true);
    expect(missed?.fields.why).to.equal('GroupFault(0, OutsideEpoch)');
    expect(missed?.fields.hash).to.equal(HASH);
    expect((w.calls[0] as { blockTag: number }).blockTag).to.equal(0x10);
  });

  it('goes out once only: a rerun and later ticks send nothing', async () => {
    const w = world();
    await w.tick();
    await w.tick();
    await w.tick();
    expect(w.sent.length).to.equal(1);
    expect(w.state.heldDone(HELD_EPOCH)).to.equal(true);
  });

  it('is marked before it goes out, so a crash during the send does not repeat it', async () => {
    const w = world({ sendThrows: true });
    await w.tick();
    expect(w.state.heldDone(HELD_EPOCH)).to.equal(true);
    expect(w.kinds()).to.include('held-batch-unknown');
    await w.tick();
    expect(w.kinds().filter((k) => k === 'send-error').length).to.equal(1);
  });

  it('waits for the node\'s score in the new epoch, as NoNodeScore would come first, and then goes out', async () => {
    const w = world({ score: 0n });
    await w.tick();
    expect(w.sent.length).to.equal(0);
    expect(w.state.heldDone(HELD_EPOCH)).to.equal(false);
    expect(w.kinds()).to.include('held-batch-waits');
    w.score.value = 1n;
    await w.tick();
    expect(w.sent.length).to.equal(1);
  });

  it('waits out a base fee above the limit, as nothing has gone out, and then goes out', async () => {
    const w = world({ baseFee: 10n ** 12n });
    await w.tick();
    expect(w.sent.length).to.equal(0);
    expect(w.state.heldDone(HELD_EPOCH)).to.equal(false);
    w.baseFee.value = 5_000_000n;
    await w.tick();
    expect(w.sent.length).to.equal(1);
    expect(w.state.heldDone(HELD_EPOCH)).to.equal(true);
  });

  it('says so if the refusal is not the one expected', async () => {
    const w = world({ reason: qsInterface.encodeErrorResult('NoNodeScore', [SELLER_ID, NEXT_EPOCH]) });
    await w.tick();
    const missed = w.events.find((e) => e.kind === 'held-batch-missed');
    expect(missed?.fields.expected).to.equal(false);
    expect(String(missed?.fields.why)).to.contain('NoNodeScore');
  });

  it('says so if it lands', async () => {
    const w = world({ receiptStatus: '0x1' });
    await w.tick();
    expect(w.kinds()).to.include('held-batch-unexpected');
  });

  it('leaves every other send simulated first, with its gas limit set from the estimate', async () => {
    const sent: ethers.TransactionRequest[] = [];
    let simulations = 0;
    const provider = {
      estimateGas: async () => {
        simulations++;
        return 100_000n;
      },
      getBlock: async () => ({ baseFeePerGas: 5_000_000n }),
      getTransactionCount: async () => 9,
      send: async () => ({ status: '0x1', gasUsed: '0x25000', effectiveGasPrice: '0x5b8d80', blockNumber: '0x10', logs: [] }),
    } as unknown as ethers.JsonRpcProvider;
    const signer = {
      getAddress: async () => '0x00000000000000000000000000000000000000b1',
      sendTransaction: async (tx: ethers.TransactionRequest) => {
        sent.push(tx);
        return { hash: HASH };
      },
    } as unknown as ethers.Signer;
    const out = await send({ provider, log: { event: () => undefined } }, { label: 'a send', signer, to: QS, data: '0x' });
    expect(out.sent).to.equal(true);
    expect(simulations).to.equal(1);
    expect(sent[0].gasLimit).to.equal(175_000n);
  });

  it('sends nothing when a simulated send would revert', async () => {
    const sent: unknown[] = [];
    const provider = {
      estimateGas: async () => {
        throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: qsInterface.encodeErrorResult('NoNodeScore', [SELLER_ID, NEXT_EPOCH]) });
      },
    } as unknown as ethers.JsonRpcProvider;
    const signer = {
      getAddress: async () => '0x00000000000000000000000000000000000000b2',
      sendTransaction: async (tx: unknown) => void sent.push(tx),
    } as unknown as ethers.Signer;
    const out = await send({ provider, log: { event: () => undefined } }, { label: 'a send', signer, to: QS, data: '0x' });
    expect(out.sent).to.equal(false);
    expect(out.sent === false && out.why).to.equal('reverted');
    expect(sent.length).to.equal(0);
  });

  it('is only the scripted seller\'s, only after the scripted epoch', async () => {
    const w = world();
    await w.tick('beacon-01');
    await w.tick('beacon-03', HELD_EPOCH);
    await w.tick('beacon-03', NEXT_EPOCH + 1);
    expect(w.sent.length).to.equal(0);
    expect(w.state.held.size).to.equal(0);
  });
});
