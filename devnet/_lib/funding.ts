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
 * Set `recipient`'s ERC-20 balance to `amount` (NOT add — overwrites)
 * by directly writing the OZ-layout `_balances` slot.
 *
 * **Caveats every caller MUST be aware of**:
 *
 *   1. **Assignment, not addition.** This OVERWRITES the recipient's
 *      current balance. Calling `fundTrac(addr, 1000)` twice leaves
 *      `addr` with 1000, not 2000. For incremental top-ups, read the
 *      current balance first.
 *
 *   2. **`_totalSupply` is NOT updated.** The token's `totalSupply()`
 *      view will diverge from `sum(_balances)` after this cheat.
 *      Tests that read `totalSupply()` (or compare it to
 *      `sum(balances)` as a sanity check) will see inconsistent
 *      values; that's a known limitation of cheat-code funding.
 *
 *   3. **Recipient must NOT be the deployer or another address whose
 *      balance Phase-0 setup relies on.** Calling this on the
 *      deployer would zero out their float; tests that subsequently
 *      transfer from the deployer would revert.
 *
 *   4. **OZ storage layout assumption.** The TRAC token uses the
 *      vanilla OZ ERC-20 layout where `_balances` is the second
 *      mapping slot (index 1, since `_owner` from `Ownable` takes
 *      slot 0). If the contract is recompiled with extra inherited
 *      state, the layout shifts and this helper will silently fund
 *      the wrong slot — the read-after-write check below catches
 *      that and throws so the harness fails fast instead of letting
 *      downstream tests assert against stale balances.
 *
 * @param provider - Hardhat-compatible JSON-RPC provider (must accept
 *                   the `hardhat_setStorageAt` cheat).
 * @param tokenAddress - The ERC-20 contract address.
 * @param recipient - The address whose balance is being set.
 * @param amount - The new balance (in wei units of the token).
 *
 * @throws if the read-back balance does not equal `amount` after the
 *         cheat is applied — see caveat (4).
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
