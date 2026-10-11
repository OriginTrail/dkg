// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter } from '../dist/chain-adapter.js';

/**
 * The five one-log names `MOCK_EXEMPT_FROM_EVM` exempts from the mock↔EVM
 * parity audit (`test/mock-adapter-parity.test.ts`).
 *
 * That exemption rests on ONE factual claim: none of the five is on the
 * `ChainAdapter` interface. It is the whole reason the exemption is safe
 * against hazard CH-8 — a mock-mode user flipping `chain.type` to `evm` and
 * hitting "method not implemented" — because a name no interface promises is a
 * name no caller can reach through the adapter contract. Four of the five are
 * TS-`private`/`protected` and appear in that audit only because TS visibility
 * is erased at runtime; `attachChainEventLog` is public on the concrete EVM
 * class and absent from the interface.
 *
 * Nothing checked the claim. `ChainAdapter` is a type, so no runtime test can:
 * promoting `attachChainEventLog` (or any of the other four) onto the interface
 * would leave the audit GREEN — the name is exempt — and ship exactly the
 * failure mode the audit exists to prevent. This is that check, and it is a
 * build gate: `pnpm run build` runs `tsc --project tsconfig.type-tests.json`.
 *
 * Compiled against `dist`, like every type-test here, so it pins the PUBLISHED
 * declarations rather than a source-local view of them.
 *
 * To retire one of these names from the exemption, delete it here too; to add
 * a name to the exemption, add it here and let the compiler confirm the claim
 * still holds for it.
 */
type OneLogInternals =
  | 'chainEventLogRows'
  | 'attachChainEventLog'
  | 'startChainIndexRuntime'
  | 'chainIndexContract'
  | 'rebuildChainIndexRuntimeOnRotation';

/** Instantiating this with anything but `never` is the compile error. */
type AssertNever<T extends never> = T;

type _ExemptOnlyBecauseOffTheInterface =
  AssertNever<Extract<keyof ChainAdapter, OneLogInternals>>;

export type { _ExemptOnlyBecauseOffTheInterface };
