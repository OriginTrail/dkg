/**
 * enrichEvmError — RPC format robustness matrix.
 *
 * Audit findings covered:
 *
 *   CH-10 (HIGH) — `enrichEvmError` is only tested against the hardhat-style
 *                  `data="0x..."` substring today. Real-world ethers error
 *                  messages vary a lot by RPC provider:
 *
 *                    • Hardhat (HardhatEthersProvider):
 *                      `execution reverted (unknown custom error) (action="call",
 *                       data="0xabcdef...", reason=null, transaction={...})`
 *
 *                    • Geth / op-geth (stock JSON-RPC):
 *                      `execution reverted` + `error.data = "0x..."` as a
 *                      structured field — ethers wraps this as
 *                      `data: "0x..."` (no equals, no quotes around the key).
 *
 *                    • Infura / Alchemy (paid hosted RPC):
 *                      `execution reverted: <reason>` with payload under
 *                      `error.data = { originalError: { data: "0x..." } }`;
 *                      ethers surfaces the inner `data="0x..."` but often
 *                      also emits `errorData="0x..."` in the summary.
 *
 *                  Today's regex `/data="(0x[0-9a-fA-F]+)"/` will only
 *                  match the hardhat-shaped path. The geth-style (no quotes)
 *                  path and the `errorData=` path go through unmodified.
 *                  Downstream callers log the raw message and can leak
 *                  `0x0000...` selectors to users (#159 class).
 *
 *                  The Hardhat-shape test is already green (exists in
 *                  `evm-adapter.unit.test.ts`); the non-hardhat shapes below
 *                  are expected to STAY RED until `enrichEvmError` is
 *                  generalized.
 *
 * Per QA policy: the red tests ARE the finding — see BUGS_FOUND.md CH-10.
 */
import { describe, it, expect } from 'vitest';
import { Interface } from 'ethers';
import { enrichEvmError, decodeEvmError } from '../src/evm-adapter.js';

const iface = new Interface([
  'error BatchNotFound(uint256 batchId)',
  'error InvalidKARange(uint64 startKAId, uint64 endKAId)',
  'error NotBatchPublisher(uint256 batchId, address caller)',
]);

const BATCH_NOT_FOUND_HEX = iface.encodeErrorResult('BatchNotFound', [42n]);

describe('enrichEvmError — decoder works on raw custom error hex [CH-10]', () => {
  it('decodeEvmError returns the error name for a known selector', () => {
    const out = decodeEvmError(BATCH_NOT_FOUND_HEX);
    expect(out?.name).toBe('BatchNotFound');
  });
});

describe('enrichEvmError — Hardhat-shape error message [CH-10]', () => {
  it('rewrites `unknown custom error data="0x..."` into the decoded name', () => {
    const err = new Error(
      `execution reverted (unknown custom error) (action="call", data="${BATCH_NOT_FOUND_HEX}", reason=null)`,
    );
    const name = enrichEvmError(err);
    expect(name).toBe('BatchNotFound');
    expect(err.message).toContain('BatchNotFound');
    expect(err.message).not.toContain('unknown custom error');
  });
});

describe('enrichEvmError — Geth-shape error message [CH-10]', () => {
  // PROD-BUG candidate: ethers relays geth revert data as `data: "0x..."`
  // (key: value style, space after colon, no `="` sequence). Today's regex
  // /data="(0x[0-9a-fA-F]+)"/ does NOT match. Expected behaviour: the
  // error should still be decoded and the message enriched.
  it('decodes revert data when ethers surfaces it in `data: "0x..."` form', () => {
    const err = new Error(
      `execution reverted (unknown custom error, data: "${BATCH_NOT_FOUND_HEX}")`,
    );
    const name = enrichEvmError(err);
    // PROD-BUG: returns null today — regex requires `="`. See CH-10.
    expect(name).toBe('BatchNotFound');
    expect(err.message).toContain('BatchNotFound');
  });

  it('decodes revert data when ethers surfaces it in `error.data=0x..` form (no quotes)', () => {
    const err = new Error(
      `execution reverted: missing revert data (data=${BATCH_NOT_FOUND_HEX})`,
    );
    const name = enrichEvmError(err);
    // PROD-BUG: the unquoted case is not handled either.
    expect(name).toBe('BatchNotFound');
  });
});

describe('enrichEvmError — Infura/Alchemy-shape error message [CH-10]', () => {
  // ethers v6 often carries the selector under `errorData=` in the
  // normalized error. Regex today matches only `data=`.
  it('decodes revert data when error carries it under `errorData="0x..."`', () => {
    const err = new Error(
      `execution reverted (unknown custom error) (errorData="${BATCH_NOT_FOUND_HEX}", errorArgs=null)`,
    );
    const name = enrichEvmError(err);
    // PROD-BUG: `errorData=` path is not handled.
    expect(name).toBe('BatchNotFound');
  });

  it('decodes revert data inside nested originalError envelope (typical of hosted RPC)', () => {
    // Infura / Alchemy wrap the provider's original error as a JSON
    // blob that gets stringified into ethers' error message. A naive
    // substring search still finds `data="0x..."` only if the outer wrap
    // emits that shape; many providers emit `"data":"0x..."` (JSON).
    const err = new Error(
      `processing response error (body='{"error":{"code":3,"data":"${BATCH_NOT_FOUND_HEX}"}}')`,
    );
    const name = enrichEvmError(err);
    // PROD-BUG: JSON-embedded `"data":"0x..."` is not handled.
    expect(name).toBe('BatchNotFound');
  });
});

describe('enrichEvmError — regression guards [CH-10]', () => {
  it('returns null on a plain network error with no revert data', () => {
    expect(enrichEvmError(new Error('connect ECONNREFUSED 127.0.0.1:8545'))).toBeNull();
  });

  it('returns null when data is present but does not match any known selector', () => {
    const err = new Error('execution reverted (unknown custom error) (data="0xdeadbeef")');
    const name = enrichEvmError(err);
    expect(name).toBeNull();
    // And must NOT rewrite the message in that case (logging invariant).
    expect(err.message).toContain('unknown custom error');
  });

  it('returns null when passed a non-Error value (defensive)', () => {
    expect(enrichEvmError(null as any)).toBeNull();
    expect(enrichEvmError('string reason' as any)).toBeNull();
    expect(enrichEvmError({ message: 'plain object' } as any)).toBeNull();
  });

  it('embeds the decoded argument list when the error has parameters (operator-friendly log)', () => {
    const data = iface.encodeErrorResult('NotBatchPublisher', [
      7n,
      '0x00000000000000000000000000000000000000aa',
    ]);
    const err = new Error(`execution reverted (unknown custom error, data="${data}")`);
    enrichEvmError(err);
    // The exact format is `Name(arg0, arg1, ...)` — pin it so operators'
    // grep tooling does not silently break on a reformat.
    expect(err.message).toMatch(/NotBatchPublisher\(7, 0x[0-9a-fA-F]{40}\)/);
  });
});
