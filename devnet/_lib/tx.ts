/**
 * Transaction-level helpers that the devnet test suites use to keep tx
 * assertions tight.
 *
 * Devnet tests run against a real Hardhat chain in interval-mining /
 * automine mode, talk to real daemons, and submit real transactions. The
 * default ethers v6 pattern is `await (await contract.fn(...)).wait()`,
 * which RESOLVES the promise even when the on-chain status is `0`
 * (reverted-but-mined) — so a silent revert that *should* fail a test
 * passes instead. Every devnet test that submits a tx must run the
 * receipt through {@link expectTxSuccess} before asserting the side
 * effects, otherwise a real protocol bug can hide.
 */
import { expect } from 'vitest';
import { Interface as EthersInterface } from 'ethers';
import type { ContractTransactionReceipt, Interface, Log, LogDescription } from 'ethers';

/**
 * Asserts that a transaction receipt has `status === 1` (success). Throws
 * a vitest-formatted error otherwise so the diff/CI log shows the tx hash
 * + block number, which is enough to find the offending revert in the
 * Hardhat node's stdout.
 *
 * @param receipt The ethers v6 ContractTransactionReceipt (or null).
 * @param label Short human-readable label that's prepended to the error.
 *               Use the operation name, e.g. `'NFT.withdraw'` or
 *               `'StakingV10.requestOperatorFeeWithdrawal'`.
 */
export function expectTxSuccess(
  receipt: ContractTransactionReceipt | null | undefined,
  label: string,
): asserts receipt is ContractTransactionReceipt {
  expect(receipt, `${label}: receipt was null/undefined`).toBeTruthy();
  expect(
    receipt!.status,
    `${label}: tx ${receipt!.hash} mined in block ${receipt!.blockNumber} but reverted (status=${receipt!.status}). ` +
      `Inspect the Hardhat node log around this block for the revert reason.`,
  ).toBe(1);
}

/**
 * Parse a single occurrence of a named event from a transaction receipt's
 * logs and return its decoded args. Throws if the event is not present
 * (vs. silently returning an undefined `tokenId` and letting downstream
 * `.toBe(0n)` mask the bug).
 *
 * @param iface The ethers Interface that knows the event signature.
 * @param logs The transaction receipt's `.logs` array.
 * @param name The event name (e.g. `'PositionWithdrawn'`).
 * @param predicate Optional extra filter — useful when the same event
 *                  fires multiple times in one tx and you want the one
 *                  matching a specific argument.
 */
export function parseEventOrThrow<T = LogDescription>(
  iface: Interface,
  logs: readonly Log[],
  name: string,
  predicate?: (parsed: LogDescription) => boolean,
): T {
  const matches: LogDescription[] = [];
  for (const log of logs) {
    let parsed: LogDescription | null = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== name) continue;
    if (predicate && !predicate(parsed)) continue;
    matches.push(parsed);
  }
  expect(
    matches.length,
    `expected exactly one ${name} event, got ${matches.length} (checked ${logs.length} logs)`,
  ).toBe(1);
  return matches[0]! as unknown as T;
}

/**
 * Same as {@link parseEventOrThrow} but tolerates 0 occurrences. Returns
 * `undefined` if the event is not present, throws if more than one
 * matching event exists. Useful when an event is conditionally emitted
 * (e.g. `RewardsClaimed` only fires when `accruedRewards > 0`).
 */
export function parseEventIfPresent<T = LogDescription>(
  iface: Interface,
  logs: readonly Log[],
  name: string,
  predicate?: (parsed: LogDescription) => boolean,
): T | undefined {
  const matches: LogDescription[] = [];
  for (const log of logs) {
    let parsed: LogDescription | null = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== name) continue;
    if (predicate && !predicate(parsed)) continue;
    matches.push(parsed);
  }
  expect(
    matches.length,
    `expected at most one ${name} event, got ${matches.length}`,
  ).toBeLessThanOrEqual(1);
  return matches[0] as T | undefined;
}

/**
 * Asserts that a `Transfer(address,address,uint256)` event with `from ==
 * address(0)` (a mint) is present in `logs` and returns the `tokenId`.
 * Used by every staking / publishing flow that mints an NFT to a fresh
 * recipient — the alternative (a manual loop with try/catch around
 * `iface.parseLog`) was historically prone to forgetting the
 * `from == 0x0` check and accepting any later Transfer.
 */
export function expectMintedTokenId(
  logs: readonly Log[],
  recipient: string,
  context: string,
): bigint {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const iface = new EthersInterface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  ]);
  const minted: bigint[] = [];
  for (const log of logs) {
    let parsed: LogDescription | null = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (
      parsed?.name === 'Transfer' &&
      (parsed.args.from as string).toLowerCase() === ZERO &&
      (parsed.args.to as string).toLowerCase() === recipient.toLowerCase()
    ) {
      minted.push(parsed.args.tokenId as bigint);
    }
  }
  expect(
    minted.length,
    `${context}: expected exactly 1 ERC-721 mint to ${recipient}, got ${minted.length}`,
  ).toBe(1);
  return minted[0]!;
}

/**
 * Asserts a contract call reverts. Wraps ethers' rejection in a friendlier
 * error that surfaces both the expected and the actual error string —
 * the default behaviour swallows the inner revert reason.
 *
 * Pass `withReason` to additionally pin a substring of the revert message
 * (e.g. `'NotOwner'`, `'LockNotExpired'`).
 */
export async function expectRevert(
  thunk: () => Promise<unknown>,
  context: string,
  withReason?: string,
): Promise<void> {
  let threw: Error | null = null;
  try {
    await thunk();
  } catch (err) {
    threw = err as Error;
  }
  expect(threw, `${context}: expected to revert but the call resolved`).toBeTruthy();
  if (withReason) {
    expect(
      threw!.message,
      `${context}: revert message does not contain "${withReason}". Got: ${threw!.message.slice(0, 400)}`,
    ).toContain(withReason);
  }
}
