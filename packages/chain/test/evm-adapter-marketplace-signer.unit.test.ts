// SPDX-License-Identifier: Apache-2.0
/**
 * Which wallet sends a receipt batch (evm-adapter-marketplace.ts), the policy a
 * random-sampling proof follows too: the wallet the rotation picks, and once
 * more the primary when the picked one is no longer registered
 * (`ProfileDoesntExist`), which then leaves the rotation and its cached
 * identity id. The adapter's own send code runs with only the transaction
 * dispatch stubbed, so no chain is needed.
 */
import { describe, expect, it } from 'vitest';
import { ethers, Interface } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { receiptBatchFaultOf, type ReceiptGroup } from '../src/marketplace.js';

const PRIMARY = ethers.Wallet.createRandom();
const OTHER = ethers.Wallet.createRandom();
const SETTLEMENT = ethers.getAddress('0x00000000000000000000000000000000000000c1');
const TX_HASH = `0x${'ab'.repeat(32)}`;
const settlement = new Interface(loadAbi('QueryInferenceSettlement'));
const GROUPS: ReceiptGroup[] = [{ subscriptionId: ethers.keccak256('0x07'), budgetIndex: 0, minCounted: 0n, items: [] }];

/** A revert as a provider throws it: the custom error's data, with ethers' undecoded message. */
function revert(iface: Interface, name: string, args: unknown[]): Error {
  const err = new Error('execution reverted: unknown custom error') as Error & { data: string };
  err.data = iface.encodeErrorResult(name, args);
  return err;
}
const profileDoesntExist = () => revert(new Interface(['error ProfileDoesntExist(uint72 identityId)']), 'ProfileDoesntExist', [0n]);
/** `GroupFault(0, BadSignature)`. */
const groupFault = () => revert(settlement, 'GroupFault', [0, 6]);

/** The receipt of a batch that landed: its group and its acceptance, logged by the settlement. */
function landedReceipt() {
  const log = (name: string, args: unknown[]) => ({ address: SETTLEMENT, ...settlement.encodeEventLog(name, args) });
  return {
    hash: TX_HASH, blockNumber: 7, index: 0, status: 1, gasUsed: 21_000n, to: SETTLEMENT,
    logs: [
      log('ReceiptsLanded', [GROUPS[0]!.subscriptionId, 0, 9, 1, 300n, 300n, 10n ** 18n, ethers.keccak256('0x08')]),
      log('ReceiptBatchAccepted', [9, ethers.keccak256('0x0a'), 1, 300n, 300n, 10n ** 18n]),
    ],
  };
}

/**
 * An adapter with two operational wallets, the second registered as the
 * rotation saw it last. Its dispatch reverts for the wallets in `failures`, as
 * a simulation does before anything is broadcast, and lands for any other.
 */
function adapter(failures: Map<string, () => Error>) {
  const a: any = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    privateKey: PRIMARY.privateKey,
    additionalKeys: [OTHER.privateKey],
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    staticNetwork: false,
  });
  const primary = a.signer;
  const other = a.signerPool[1];
  a.registeredOperationalAddresses.add(other.address.toLowerCase());
  a.init = async () => undefined;
  a.resolveContract = async () => ({ getAddress: async () => SETTLEMENT });
  const sent: Array<{ wallet: string; label: string }> = [];
  a.dispatchSerializedV10Write = async (
    signer: { address: string },
    label: string,
    onBroadcast?: (signal: { txHash: string; nonce?: number }) => Promise<void> | void,
  ) => {
    sent.push({ wallet: signer.address, label });
    const failure = failures.get(signer.address);
    if (failure) throw failure();
    await onBroadcast?.({ txHash: TX_HASH, nonce: 3 });
    return landedReceipt();
  };
  const cleared: string[] = [];
  a.clearIdentityIdForAddress = (address: string) => { cleared.push(address); };
  return { a, primary, other, sent, cleared };
}

describe('the wallet a receipt batch is sent from', () => {
  it('is the primary, once the wallet the rotation picked turns out no longer registered, which leaves the rotation', async () => {
    const failures = new Map<string, () => Error>();
    const { a, primary, other, sent, cleared } = adapter(failures);
    failures.set(other.address, profileDoesntExist);
    a.nextRandomSamplingSigner = async () => other;
    const broadcasts: Array<{ wallet: string; txHash: string; nonce?: number }> = [];

    const batch = await a.submitReceiptBatch(GROUPS, {
      onBroadcast: (signal: { wallet: string; txHash: string; nonce?: number }) => { broadcasts.push(signal); },
    });

    expect(sent).toEqual([{ wallet: other.address, label: 'receipt batch' }, { wallet: primary.address, label: 'receipt batch' }]);
    // The first attempt reverted before its broadcast; the hook hears only the primary's, with its wallet.
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ txHash: TX_HASH, nonce: 3, wallet: primary.address });
    expect(a.registeredOperationalAddresses.has(other.address.toLowerCase())).toBe(false);
    expect(cleared).toEqual([other.address]);
    expect(batch).toMatchObject({
      hash: TX_HASH, blockNumber: 7, success: true, gasUsed: 21_000n, seller: 9n, itemCount: 1, value: 300n, counted: 300n,
      groups: [{ subscriptionId: GROUPS[0]!.subscriptionId, budgetIndex: 0, itemCount: 1, value: 300n }],
    });
  });

  it('is the picked one alone for any other revert, which comes back decoded', async () => {
    const failures = new Map<string, () => Error>();
    const { a, other, sent, cleared } = adapter(failures);
    failures.set(other.address, groupFault);
    a.nextRandomSamplingSigner = async () => other;

    const err = await a.submitReceiptBatch(GROUPS).catch((e: unknown) => e);

    expect(sent.map((s) => s.wallet)).toEqual([other.address]);
    expect(err.revert?.name).toBe('GroupFault');
    expect(receiptBatchFaultOf(err)).toEqual({ groupIndex: 0, itemIndex: null, fault: 'BadSignature' });
    expect(a.registeredOperationalAddresses.has(other.address.toLowerCase())).toBe(true);
    expect(cleared).toEqual([]);
  });

  it('is the primary alone when the primary itself was picked and reverts', async () => {
    const failures = new Map<string, () => Error>();
    const { a, primary, sent, cleared } = adapter(failures);
    failures.set(primary.address, profileDoesntExist);
    a.nextRandomSamplingSigner = async () => primary;

    const err = await a.submitReceiptBatch(GROUPS).catch((e: unknown) => e);

    expect(sent.map((s) => s.wallet)).toEqual([primary.address]);
    expect(err.revert?.name).toBe('ProfileDoesntExist');
    expect(cleared).toEqual([]);
  });

  it("passes on the primary's own revert, decoded, when the second send fails too", async () => {
    const failures = new Map<string, () => Error>();
    const { a, primary, other, sent, cleared } = adapter(failures);
    failures.set(other.address, profileDoesntExist);
    failures.set(primary.address, groupFault);
    a.nextRandomSamplingSigner = async () => other;

    const err = await a.submitReceiptBatch(GROUPS).catch((e: unknown) => e);

    expect(sent.map((s) => s.wallet)).toEqual([other.address, primary.address]);
    expect(receiptBatchFaultOf(err)).toEqual({ groupIndex: 0, itemIndex: null, fault: 'BadSignature' });
    expect(a.registeredOperationalAddresses.has(other.address.toLowerCase())).toBe(false);
    expect(cleared).toEqual([other.address]);
  });
});
