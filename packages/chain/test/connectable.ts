// SPDX-License-Identifier: Apache-2.0
/**
 * Shared test helper (NOT a test file — no `.test.` suffix, so vitest skips it).
 *
 * The round-2 review split `withRunner` into `rebindContract` (contract.connect(p))
 * and `rebindSigner` (signer.connect(provider)) and removed the no-`.connect`
 * test-double fallback, so production handles MUST be `.connect`-able (they are —
 * real ethers `Contract`s). Unit tests, however, mock `this.contracts.*` as plain
 * method objects. `connectable` makes such a mock satisfy that boundary with a
 * single-provider NO-OP self-rebind (`connect` returns the mock itself), so the
 * REAL `rebindContract`/`rebindSigner` runs against it — a genuine rebind
 * regression is still caught. Idempotent: a mock that already carries a MEANINGFUL
 * `.connect` (e.g. `token.connect(signer) → tokenWithSigner`) is left untouched.
 */
export function connectable<T>(mock: T): T {
  const m = mock as { connect?: unknown };
  if (m && typeof m.connect !== 'function') m.connect = () => mock;
  return mock;
}
