// SPDX-License-Identifier: Apache-2.0
/**
 * The buyer's ledger (buyer-ledger.ts) on its own: the journals it replaces,
 * read once and left as they are; its one compaction; the keys it hands out,
 * each a copy; and what it does with a key it does not hold. The gateway's and
 * the keys' behaviour over it is in gateway-durability, gateway-legacy-journals
 * and gateway-keys.
 */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessKeys, BUYER_LEDGER_FILE, BuyerLedger, Journal, type HeldReceipt, type KeptKey, type KeptReceipt, type KeyRecord } from '../src/index.js';

const FIXTURE = join(__dirname, 'fixtures', 'legacy-buyer-journals');
const SUB = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const KEY: KeyRecord = { keyId: 'dkgmk_00000001', hash: '00'.repeat(32), label: 'k', budget: '1000', services: null, rps: 1, expiresAt: null, at: 0 };

let dir: string;
const jsonl = (entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
const ledgerLines = async () => (await readFile(join(dir, BUYER_LEDGER_FILE), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** A call of `epoch` on subscription `sub`, nonce `nonce`: accepted with a receipt worth `value`, or open. */
function callOf(epoch: number, sub: string, nonce: number, value?: bigint, keyId = KEY.keyId): HeldReceipt {
  return {
    callId: `0x${(epoch * 1_000 + nonce).toString(16).padStart(64, '0')}`, epoch, subscriptionId: sub, budgetIndex: 0, seller: '1', keyId,
    request: { subscriptionId: sub, serviceId: sub, seller: '1', nonce: String(nonce), pricePerUnit: '1', maxUnits: '100', maxValueWei: '100', issuedAt: 5, expiry: 9 },
    signature: '0x',
    ...(value === undefined
      ? { state: 'open' as const, problem: 'sent' }
      : { state: 'held' as const, receipt: { requestDigest: sub, resultCommitment: sub, units: String(value), valueWei: String(value), completedAt: 6 }, receiptSignature: '0x' }),
  };
}
/** The same call accepted with its receipt, worth `value`. */
const keptOf = (epoch: number, sub: string, nonce: number, value: bigint, keyId = KEY.keyId) => callOf(epoch, sub, nonce, value, keyId) as KeptReceipt;

/** The journals the ledger replaces, the fixture's subscription of epoch 3, and its two keys. */
const LEGACY = ['buyer-receipts.jsonl', 'buyer-nonces.jsonl', 'access-keys.jsonl'];
const legacyFiles = () => Promise.all(LEGACY.map((f) => readFile(join(dir, f), 'utf8')));
const SUB3 = '0x90bce2dfb937aa3522f61d7260c286bdf54514237c905ed2bbb09999be9cf38c';
const MAIN = 'dkgmk_a37cad0b';
const REVOKED = 'dkgmk_03953501';
/** What a ledger holds: its keys, what each reserves, and how many calls of epoch 3 it keeps. */
async function stateOf(ledger: BuyerLedger) {
  const keys = await ledger.keyList();
  return { keys, reserved: Object.fromEntries(keys.map((k) => [k.keyId, ledger.reservedOf(k.keyId)])), calls: ledger.calls.callsOf(3).length };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-buyer-ledger-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the journals the ledger replaces', () => {
  it('are read once, into a journal of its own that alone is read from then on, and left as they were', async () => {
    await cp(FIXTURE, dir, { recursive: true });
    const before = await Promise.all(['buyer-receipts.jsonl', 'buyer-nonces.jsonl', 'access-keys.jsonl'].map((f) => readFile(join(dir, f), 'utf8')));
    const ledger = new BuyerLedger(dir);
    await ledger.load();
    // The fixture's nonce counter for epoch 3 reached 4: the next request takes 5.
    expect(await ledger.takeNonce(3, '0x90bce2dfb937aa3522f61d7260c286bdf54514237c905ed2bbb09999be9cf38c', 1n)).toBe(5n);
    expect((await ledgerLines()).map((l) => l.type)).toEqual(['key', 'key', 'revoke', 'final', 'nonce', 'call', 'call', 'call', 'call', 'call', 'nonce']);
    const after = await Promise.all(['buyer-receipts.jsonl', 'buyer-nonces.jsonl', 'access-keys.jsonl'].map((f) => readFile(join(dir, f), 'utf8')));
    expect(after).toEqual(before);
    // What the old journals say once the ledger has its own is not read.
    await writeFile(join(dir, 'buyer-nonces.jsonl'), jsonl([{ epoch: 3, subscriptionId: SUB(9), seller: '1', nonce: '50' }]));
    const restarted = new BuyerLedger(dir);
    expect(await restarted.takeNonce(3, SUB(9), 1n)).toBe(0n);
  });

  it('keep the highest nonce of each counter and the last record of each call, and drop what names no key', async () => {
    await writeFile(join(dir, 'access-keys.jsonl'), jsonl([
      { type: 'revoke', keyId: 'dkgmk_ffffffff', at: 1 },
      { type: 'use', keyId: 'dkgmk_ffffffff', value: '9', at: 1 },
      { type: 'make', ...KEY },
      { type: 'use', keyId: KEY.keyId, value: '4', at: 3 },
    ]));
    await writeFile(join(dir, 'buyer-nonces.jsonl'), jsonl([
      { epoch: 2, subscriptionId: SUB(2), seller: '1', nonce: '3' },
      { epoch: 2, subscriptionId: SUB(2), seller: '1', nonce: '1' },
    ]));
    await writeFile(join(dir, 'buyer-receipts.jsonl'), jsonl([callOf(2, SUB(2), 0), callOf(2, SUB(2), 0, 4n), { type: 'final', epoch: 1, rows: [] }]));
    const ledger = new BuyerLedger(dir);
    expect(await ledger.keyList()).toEqual([expect.objectContaining({ keyId: KEY.keyId, spent: '4', lastUsedAt: 3, revoked: false })]);
    expect(await ledger.takeNonce(2, SUB(2), 1n)).toBe(4n);
    // The call's last record is its receipt, whose cost the key's total holds already.
    expect(ledger.calls.callsOf(2)).toEqual([callOf(2, SUB(2), 0, 4n)]);
    expect(ledger.calls.heldValue(`${SUB(2)}:0`)).toBe(4n);
    expect(ledger.final(1)).toEqual([]);
    expect((await ledgerLines()).filter((l) => l.type === 'revoke')).toEqual([]);
  });

  it('leave no journal of the ledger when there is nothing in them', async () => {
    const ledger = new BuyerLedger(dir);
    await ledger.load();
    expect(await ledger.keyList()).toEqual([]);
    await expect(readFile(join(dir, BUYER_LEDGER_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stop a node whose ledger journal cannot even be looked for', async () => {
    const file = join(dir, 'not-a-directory');
    await writeFile(file, '');
    await expect(new BuyerLedger(file).load()).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('are read again in full when the ledger cannot be written from them, taking no change meanwhile, and imported once', async () => {
    await cp(FIXTURE, dir, { recursive: true });
    const before = await legacyFiles();
    // A full disk: the ledger's journal cannot be written until there is room again.
    const full = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const replace = vi.spyOn(Journal.prototype, 'replace').mockRejectedValue(full);
    const ledger = new BuyerLedger(dir);
    await expect(ledger.load()).rejects.toBe(full);
    // While it cannot load, every change is refused: none is applied, and none is written down.
    await expect(ledger.makeKey({ ...KEY, keyId: 'dkgmk_0000000000000009' })).rejects.toBe(full);
    await expect(ledger.revokeKey(MAIN, 6)).rejects.toBe(full);
    await expect(ledger.reserve(MAIN, 1n)).rejects.toBe(full);
    await expect(ledger.takeNonce(3, SUB3, 1n)).rejects.toBe(full);
    await expect(ledger.recordSent(callOf(3, SUB3, 9, undefined, MAIN))).rejects.toBe(full);
    await expect(ledger.recordAccepted(keptOf(3, SUB3, 9, 5n, MAIN), 7)).rejects.toBe(full);
    await expect(ledger.recordUnresolved({ ...callOf(3, SUB3, 9, undefined, MAIN), problem: 'unanswered' })).rejects.toBe(full);
    await expect(ledger.finalize(3, SUB3, [], [])).rejects.toBe(full);
    expect(ledger.calls.callsOf(3)).toEqual([]);
    expect(ledger.reservedOf(MAIN)).toBe(0n);
    // No ledger journal, nothing set aside, and the old journals as they were.
    expect((await readdir(dir)).sort()).toEqual((await readdir(FIXTURE)).sort());
    expect(await legacyFiles()).toEqual(before);

    // Room again: the next use reads them and writes the ledger, once.
    replace.mockRestore();
    await ledger.load();
    const imported = await stateOf(ledger);
    expect(imported).toEqual({
      keys: [
        expect.objectContaining({ keyId: MAIN, spent: '860', revoked: false, lastUsedAt: 1_799_432_137 }),
        expect.objectContaining({ keyId: REVOKED, spent: '7', revoked: true, lastUsedAt: 4 }),
      ],
      // The four calls of epoch 3 whose cost is not known hold their most value.
      reserved: { [MAIN]: 4n * 620n, [REVOKED]: 0n },
      calls: 5,
    });
    expect(await ledger.takeNonce(3, SUB3, 1n)).toBe(5n);
    const restarted = new BuyerLedger(dir);
    await restarted.load();
    expect(await stateOf(restarted)).toEqual(imported);
    expect(await restarted.takeNonce(3, SUB3, 1n)).toBe(6n);
    expect((await ledgerLines()).map((l) => l.type)).toEqual(['key', 'key', 'revoke', 'final', 'nonce', 'call', 'call', 'call', 'call', 'call', 'nonce', 'nonce']);
    expect(await legacyFiles()).toEqual(before);
  });
});

describe("the ledger's compaction", () => {
  it("drops the epoch's calls and nonce counters, folds what they charged into each key, and keeps every other epoch's", async () => {
    const ledger = new BuyerLedger(dir);
    await ledger.makeKey(KEY);
    await ledger.makeKey({ ...KEY, keyId: 'dkgmk_00000002' });
    for (const epoch of [1, 2]) {
      await ledger.takeNonce(epoch, SUB(epoch), 1n);
      await ledger.recordSent(callOf(epoch, SUB(epoch), 0));
      await ledger.recordAccepted(keptOf(epoch, SUB(epoch), 0, 7n), 10 + epoch);
    }
    await ledger.finalize(1, SUB(1), [], [{ keyId: KEY.keyId, value: 3n, at: 20 }]);
    expect(await ledgerLines()).toEqual([
      { type: 'key', ...KEY, spent: '10', lastUsedAt: 20 },
      { type: 'key', ...KEY, keyId: 'dkgmk_00000002', spent: '0', lastUsedAt: null },
      { type: 'final', epoch: 1, rows: [] },
      { type: 'nonce', epoch: 2, subscriptionId: SUB(2), seller: '1', nonce: '0' },
      { type: 'call', ...callOf(2, SUB(2), 0, 7n), charge: { value: '7', at: 12 } },
    ]);
    expect((await ledger.keyList())[0]).toMatchObject({ spent: '17', lastUsedAt: 20 });
    // Made final again, its reconciliation takes the place of the first.
    await ledger.finalize(1, SUB(1), [{ subscriptionId: SUB(1) } as never], []);
    expect((await ledgerLines()).filter((l) => l.type === 'final')).toEqual([{ type: 'final', epoch: 1, rows: [{ subscriptionId: SUB(1) }] }]);
    const restarted = new BuyerLedger(dir);
    expect(await restarted.keyList()).toEqual(await ledger.keyList());
    expect(restarted.calls.callsOf(2)).toEqual([callOf(2, SUB(2), 0, 7n)]);
  });

  it('keeps what another ledger over the same journal wrote', async () => {
    const one = new BuyerLedger(dir);
    await one.makeKey(KEY);
    await one.takeNonce(1, SUB(1), 1n);
    const two = new BuyerLedger(dir);
    await two.load();
    await two.takeNonce(2, SUB(2), 1n);
    await two.recordSent(callOf(2, SUB(2), 0));
    await one.finalize(1, SUB(1), [], []);
    const third = new BuyerLedger(dir);
    expect(await third.takeNonce(2, SUB(2), 1n)).toBe(1n);
    expect(third.calls.callsOf(2)).toHaveLength(1);
  });

  it('keeps every write made on the same ledger while it runs: the call, its charge, the nonce counter and the revocation', async () => {
    const ledger = new BuyerLedger(dir);
    await ledger.makeKey(KEY);
    await ledger.takeNonce(1, SUB(1), 1n);
    await ledger.recordSent(callOf(1, SUB(1), 0));
    await ledger.recordAccepted(keptOf(1, SUB(1), 0, 7n), 11);
    await ledger.takeNonce(2, SUB(2), 1n);
    await ledger.recordSent(callOf(2, SUB(2), 0));
    // The compaction stops once it has read the journal, before it writes it again.
    const replace = Journal.prototype.replace;
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(Journal.prototype, 'replace').mockImplementationOnce(async function (this: Journal<unknown>, entries: readonly unknown[]) {
      reached();
      await resumed;
      return replace.call(this, entries);
    });
    const appends = vi.spyOn(Journal.prototype, 'append');
    const finalizing = ledger.finalize(1, SUB(1), [], []);
    await paused;
    // Meanwhile: the current epoch's call accepted, the key revoked, and that epoch's next nonce taken.
    const writes = [ledger.recordAccepted(keptOf(2, SUB(2), 0, 5n), 12), ledger.revokeKey(KEY.keyId, 13), ledger.takeNonce(2, SUB(2), 1n)];
    await new Promise((resolve) => setImmediate(resolve));
    // Each waits for the compaction: nothing is appended while it holds the journal.
    expect(appends).not.toHaveBeenCalled();
    resume();
    await finalizing;
    await Promise.all(writes);
    expect(appends).toHaveBeenCalledTimes(3);

    const reopened = new BuyerLedger(dir);
    await reopened.load();
    expect(reopened.final(1)).toEqual([]);
    expect(reopened.calls.callsOf(1)).toEqual([]);
    expect(reopened.calls.callsOf(2)).toEqual([keptOf(2, SUB(2), 0, 5n)]);
    // Epoch 1's charge folded in by the compaction, the current epoch's charge from its record, and the revocation.
    expect(await reopened.keyList()).toEqual([expect.objectContaining({ keyId: KEY.keyId, spent: '12', lastUsedAt: 12, revoked: true })]);
    expect(await reopened.keyList()).toEqual(await ledger.keyList());
    // Epoch 2's counter goes on after the nonce taken meanwhile; epoch 1's went with its compaction.
    expect(await reopened.takeNonce(2, SUB(2), 1n)).toBe(2n);
    expect(await reopened.takeNonce(1, SUB(1), 1n)).toBe(0n);
  });
});

describe('an accepted call', () => {
  it("is kept with its receipt's charge, then gives back the reservation it held; a write that fails gives back nothing", async () => {
    const ledger = new BuyerLedger(dir);
    await ledger.makeKey(KEY);
    const send = async (nonce: number) => {
      expect(await ledger.reserve(KEY.keyId, 100n)).toBe(true);
      await ledger.recordSent(callOf(1, SUB(1), nonce));
    };
    // Its record cannot be written: counted at its receipt's value, the key not charged, the reservation still held.
    await send(0);
    vi.spyOn(Journal.prototype, 'append').mockRejectedValueOnce(new Error('disk full'));
    await expect(ledger.recordAccepted(keptOf(1, SUB(1), 0, 7n), 3)).rejects.toThrow('disk full');
    expect(ledger.calls.heldValue(`${SUB(1)}:0`)).toBe(7n);
    expect((await ledger.keyList())[0]).toMatchObject({ spent: '0', lastUsedAt: null });
    expect(ledger.reservedOf(KEY.keyId)).toBe(100n);
    // Written: charged the receipt's value at the time given, and its own reservation given back.
    await send(1);
    await ledger.recordAccepted(keptOf(1, SUB(1), 1, 9n), 4);
    expect((await ledger.keyList())[0]).toMatchObject({ spent: '9', lastUsedAt: 4 });
    expect(ledger.reservedOf(KEY.keyId)).toBe(100n);
    expect((await ledgerLines()).at(-1)).toEqual({ type: 'call', ...keptOf(1, SUB(1), 1, 9n), charge: { value: '9', at: 4 } });
    // A call whose reservation the gateway's job gave back already gives back nothing more.
    await send(2);
    ledger.calls.release(callOf(1, SUB(1), 2));
    await ledger.recordAccepted(keptOf(1, SUB(1), 2, 5n), 5);
    expect((await ledger.keyList())[0]).toMatchObject({ spent: '14', lastUsedAt: 5 });
    expect(ledger.reservedOf(KEY.keyId)).toBe(100n);
  });
});

describe('the keys the ledger hands out', () => {
  it('are copies: what is done to them, or to the services a key was made with, changes neither its keys nor the check of a secret', async () => {
    const ledger = new BuyerLedger(dir);
    const keys = new AccessKeys(ledger);
    const services = [SUB(1)];
    const { secret, key } = await keys.make({ label: 'k', budget: 1_000n, services, rps: 1_000, expiresAt: null }, 1);
    await ledger.recordAccepted(keptOf(1, SUB(1), 0, 7n, key.keyId), 2);
    const kept = { keyId: key.keyId, spent: '7', services: [SUB(1)], revoked: false };
    // The list the key was made with stays its caller's.
    services.push(SUB(2));
    // The keys as listed.
    const listed = await ledger.keyList();
    listed[0].spent = '0';
    listed[0].services!.push(SUB(3));
    // The keys with their secrets' hashes, as a secret is checked against them.
    for (const held of await ledger.heldKeys()) {
      const copy = held.key as KeptKey;
      copy.spent = '0';
      copy.revoked = true;
      copy.services!.push(SUB(4));
      held.hash.fill(0);
    }
    expect(await ledger.keyList()).toEqual([expect.objectContaining(kept)]);
    expect(await keys.check(secret, 3)).toMatchObject({ ok: true, key: kept });
  });

  it('are copies when a key is made or revoked too', async () => {
    const ledger = new BuyerLedger(dir);
    const made = (await ledger.makeKey({ ...KEY, services: [SUB(1)] }))!;
    made.spent = '9';
    made.services!.push(SUB(2));
    const revoked = (await ledger.revokeKey(KEY.keyId, 2))!;
    revoked.revoked = false;
    revoked.services!.push(SUB(3));
    expect(await ledger.keyList()).toEqual([expect.objectContaining({ keyId: KEY.keyId, spent: '0', services: [SUB(1)], revoked: true })]);
  });
});

describe('a key the ledger does not hold', () => {
  it('cannot be revoked, reserves nothing, and is charged nothing', async () => {
    const ledger = new BuyerLedger(dir);
    expect(await ledger.revokeKey('dkgmk_none', 1)).toBeNull();
    expect(await ledger.reserve('dkgmk_none', 1n)).toBe(false);
    await ledger.recordAccepted(keptOf(1, SUB(1), 0, 5n, 'dkgmk_none'), 2);
    await ledger.finalize(1, SUB(1), [], [{ keyId: 'dkgmk_none', value: 5n, at: 3 }]);
    expect(await ledger.keyList()).toEqual([]);
    expect(await ledgerLines()).toEqual([{ type: 'final', epoch: 1, rows: [] }]);
  });
});
