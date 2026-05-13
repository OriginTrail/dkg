/**
 * Devnet funding helpers — Hardhat cheat-code wrappers shared across the
 * devnet test suites.
 *
 * The Hardhat node exposes two RPC primitives we use to bootstrap a fresh
 * staker without going through the deployer wallet:
 *
 *   1. `hardhat_setBalance` — credits native ETH for gas. No proof needed,
 *      Hardhat just writes the account state.
 *
 *   2. `hardhat_setStorageAt` — directly writes the OpenZeppelin ERC-20
 *      `_balances[recipient]` slot. The TRAC token uses the OZ layout
 *      (mapping in slot 1), so the storage key is
 *      `keccak256(abi.encode(recipient, 1))`.
 *
 * Both functions are read-after-write verified — if Hardhat silently
 * ignores the cheat (e.g. the test was pointed at a non-Hardhat node),
 * the helper throws a vitest-formatted error before the test proceeds.
 *
 * IMPORTANT: this module talks to a real Hardhat node. There is NO mocking
 * — the helpers will refuse to run against any RPC that doesn't accept
 * the `hardhat_*` namespace.
 */
import { expect } from 'vitest';
import { ethers } from 'ethers';

/**
 * Fund `recipient` with `amountWei` of native gas token via
 * `hardhat_setBalance`. Verifies via `eth_getBalance` that the cheat
 * actually applied.
 */
export async function fundNative(
  provider: ethers.JsonRpcProvider,
  recipient: string,
  amountWei: bigint,
): Promise<void> {
  await provider.send('hardhat_setBalance', [
    recipient,
    '0x' + amountWei.toString(16),
  ]);
  const observed = await provider.getBalance(recipient);
  expect(
    observed,
    `fundNative: hardhat_setBalance did not stick (recipient=${recipient}, want=${amountWei}, got=${observed}). ` +
      `Are you running against a real Hardhat node? Other RPCs reject the hardhat_* namespace.`,
  ).toBe(amountWei);
}

/**
 * Fund `recipient` with `amount` of an OZ-layout ERC-20 token (TRAC) by
 * directly writing the `_balances` slot.
 *
 * The OZ ERC-20 layout puts `_balances` in storage slot 1. The mapping
 * key is the canonically-encoded `(address recipient, uint256 slot)` so
 * the value lives at `keccak256(abi.encode(recipient, 1))`.
 *
 * @param provider - Hardhat-compatible JSON-RPC provider (must accept
 *                   the `hardhat_setStorageAt` cheat).
 * @param tokenAddress - The ERC-20 contract address.
 * @param recipient - The address whose balance is being set.
 * @param amount - The new balance (in wei units of the token).
 *
 * @throws if the read-back balance does not equal `amount` after the
 *         cheat is applied, which is the only signal we have that the
 *         token's storage layout deviated from OZ defaults (a relayout
 *         would invalidate this helper). Surfacing that loudly is much
 *         better than letting downstream tests silently observe stale
 *         balances and assert against them.
 */
export async function fundTrac(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  recipient: string,
  amount: bigint,
): Promise<void> {
  const slotKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [recipient, 1n],
    ),
  );
  await provider.send('hardhat_setStorageAt', [
    tokenAddress,
    slotKey,
    ethers.zeroPadValue(ethers.toBeHex(amount), 32),
  ]);
  const tokenAbi = ['function balanceOf(address) view returns (uint256)'];
  const tk = new ethers.Contract(tokenAddress, tokenAbi, provider);
  const observed: bigint = await tk.balanceOf(recipient);
  expect(
    observed,
    `fundTrac: hardhat_setStorageAt slot 1 did not stick (token=${tokenAddress}, recipient=${recipient}, want=${amount}, got=${observed}). ` +
      `Either the token's _balances slot moved off slot 1 (storage relayout) ` +
      `or the RPC endpoint isn't a Hardhat node.`,
  ).toBe(amount);
}

/**
 * Composite "create a fresh staker" — generates a random wallet, funds
 * it with native gas + TRAC, and connects it to `provider`.
 *
 * Parameters are intentionally explicit (no defaults) so each call site
 * documents the exact resource budget; tests should not be surprised by
 * a helper that silently rounds up.
 */
export async function provisionFreshWallet(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  options: { nativeWei: bigint; tracWei: bigint },
): Promise<ethers.HDNodeWallet> {
  const w = ethers.Wallet.createRandom().connect(provider) as ethers.HDNodeWallet;
  await fundNative(provider, w.address, options.nativeWei);
  await fundTrac(provider, tokenAddress, w.address, options.tracWei);
  return w;
}
