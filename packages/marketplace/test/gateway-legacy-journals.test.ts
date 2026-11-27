// SPDX-License-Identifier: Apache-2.0
/**
 * Buyer journals as the gateway and the access keys wrote them at
 * testnet-canary 369cbfc032 (fixtures/legacy-buyer-journals: its README says
 * what they hold), read by a node that starts on them: its keys and what each
 * spent, its calls and what they hold, the epoch it made final, and the next
 * epoch made final from them, a landed open call charged once and only once.
 * The chain is a stub that answers what these reads ask.
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { requestDomain, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { AccessKeys, BuyerStore, Gateway, serviceIdOf, type ReconciledRow } from '../src/index.js';

const FIXTURE = join(__dirname, 'fixtures', 'legacy-buyer-journals');
/** The buyer wallet the fixture was written with, its subscriptions of epochs 1 and 3, and its two keys. */
const BUYER = new ethers.Wallet(`0x${'44'.repeat(32)}`).address;
const SUB1 = '0x22405635b844317d29188a0125198aae9fd2b94a2695aa61fedff952278194bd';
const SUB3 = '0x90bce2dfb937aa3522f61d7260c286bdf54514237c905ed2bbb09999be9cf38c';
const MAIN = 'dkgmk_a37cad0b';
const REVOKED = 'dkgmk_03953501';
/** What each call of the fixture may cost, and what its served one cost. */
const MOST = 620n;
const COST = 120n;
const ISSUED_AT = 1_799_432_137;

let dir: string;
/** The chain the stub answers for: its epoch, and the nonces of subscription 3 it shows used (a bit each). */
let at: { epoch: number; used: bigint };

const chain = {
  getEpochTimes: async () => ({ epoch: at.epoch, startsAt: ISSUED_AT - 1_000, endsAt: ISSUED_AT + 10 ** 7, now: ISSUED_AT + 10 }),
  nonceWord: async (subscriptionId: string) => (subscriptionId === SUB3 ? at.used : 0n),
  subscriptionExists: async () => true,
  getBudgets: async () => [{ serviceId: serviceIdOf('urn:test:model:legacy-journals'), serviceClass: 1, value: 10n ** 6n, maxPricePerUnit: 100n }],
  listReceiptsLanded: async () => ({ groups: [], toBlock: 0 }),
  getMarketplaceContracts: async () => ({ requestDomain: requestDomain(31337, ethers.ZeroAddress) }),
} as unknown as MarketplaceChainAdapter;

/** A node starting on the journals in `dir`: its keys and its gateway, read back. */
async function start(): Promise<{ keys: AccessKeys; gateway: Gateway }> {
  const keys = new AccessKeys(dir);
  const gateway = new Gateway({
    chain, buyerWallet: BUYER, store: new BuyerStore(dir), router: {} as never, keys,
    send: async () => { throw new Error('no seller in this test'); },
  });
  await gateway.load();
  return { keys, gateway };
}

const finalRowsOf = async (epoch: number): Promise<ReconciledRow[]> =>
  (await readFile(join(FIXTURE, 'buyer-receipts.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    .find((e) => e.type === 'final' && e.epoch === epoch).rows;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-legacy-journals-'));
  await cp(FIXTURE, dir, { recursive: true });
  at = { epoch: 3, used: 0n };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buyer journals written before the ledger', () => {
  it('are read back: each key and what it spent, each call and what it holds, the epoch made final', async () => {
    const { keys, gateway } = await start();
    expect(await keys.list()).toEqual([
      {
        keyId: MAIN, label: 'test-agent', budget: (10n ** 30n).toString(), spent: '860', reserved: String(4n * MOST), services: null, rps: 1_000, expiresAt: null,
        revoked: false, lastUsedAt: ISSUED_AT,
      },
      { keyId: REVOKED, label: 'revoked', budget: '50', spent: '7', reserved: '0', services: null, rps: 1, expiresAt: null, revoked: true, lastUsedAt: 4 },
    ]);
    // The four calls whose cost is not known hold their most value, against the key and the budget.
    expect(keys.reservedOf(MAIN)).toBe(4n * MOST);
    expect(keys.reservedOf(REVOKED)).toBe(0n);
    expect(gateway.heldValue(SUB3, 0)).toBe(COST + 4n * MOST);
    expect(gateway.heldValue(SUB1, 0)).toBe(0n);
    const { calls } = await gateway.activity(3);
    expect(calls.map((c) => ({ state: c.state, value: c.value, problem: c.problem }))).toEqual([
      { state: 'held', value: '120', problem: undefined },
      { state: 'held', value: '620', problem: 'BudgetExhausted' },
      { state: 'held', value: '620', problem: 'unanswered' },
      { state: 'held', value: '620', problem: 'bad_signature' },
      { state: 'held', value: '620', problem: 'sent' },
    ]);
    expect(await gateway.reconciliation(1)).toEqual({ epoch: 1, final: true, rows: await finalRowsOf(1) });
  });

  it('make the next epoch final from them: the landed open call is charged its most value once, the rest released', async () => {
    const { keys, gateway } = await start();
    // Nonces 0 (the served call) and 1 (the one refused for good) landed; epoch 5 makes epoch 3 final.
    at = { epoch: 5, used: 3n };
    await gateway.tick();
    expect((await keys.list())[0]).toMatchObject({ keyId: MAIN, spent: String(860n + MOST), lastUsedAt: ISSUED_AT });
    expect(keys.reservedOf(MAIN)).toBe(0n);
    expect(gateway.heldValue(SUB3, 0)).toBe(0n);
    expect((await gateway.activity(3)).calls).toEqual([]);
    const final = await gateway.reconciliation(3);
    expect(final.final).toBe(true);
    await gateway.tick();
    expect((await keys.list())[0]).toMatchObject({ spent: String(860n + MOST) });

    const restarted = await start();
    expect(await restarted.keys.list()).toEqual(await keys.list());
    expect(await restarted.gateway.reconciliation(3)).toEqual(final);
    expect(await restarted.gateway.reconciliation(1)).toEqual({ epoch: 1, final: true, rows: await finalRowsOf(1) });
    await restarted.gateway.tick();
    expect((await restarted.keys.list())[0]).toMatchObject({ spent: String(860n + MOST) });
    // The journals the ledger replaced are left as they were, through its compaction and the restart.
    for (const file of ['buyer-receipts.jsonl', 'buyer-nonces.jsonl', 'access-keys.jsonl']) {
      expect(await readFile(join(dir, file), 'utf8'), file).toBe(await readFile(join(FIXTURE, file), 'utf8'));
    }
  });
});
