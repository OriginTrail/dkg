module.exports = {
  mocha: {
    timeout: 600_000,
  },
  providerOptions: {
    allowUnlimitedContractSize: true,
  },
  configureYulOptimizer: true,
  // Coverage instrumentation skip list. Two distinct reasons today:
  //
  // 1. `Identity.sol` — cannot be instrumented under the production solc
  //    settings (Solidity 0.8.20 + viaIR + optimizer runs=200):
  //    solidity-coverage's instrumentation adds extra locals to
  //    `addOperationalWallets`, which already sits at the edge of the EVM
  //    stack budget under viaIR, causing `YulException: Variable _3 is 1
  //    too deep in the stack` in CI's push safety net.
  //
  //    Skipped from coverage *instrumentation only*. Production compile
  //    (`hardhat compile` / `hardhat test` / Tornado: Solidity [N/4])
  //    and the contract's bytecode are untouched. The full Hardhat test
  //    suite still exercises every code path in this file at its real
  //    bytecode in the PR sharded Solidity job — the skip removes only
  //    line/branch reporting for this file in the HTML/lcov output.
  //
  // 2. `archive/` — V8/V9 legacy contracts moved out of the active
  //    *test* surface in commit 929e29fe (PR #500, "refactor: archive
  //    non-V10 contracts and downstream V8/V9 backward-compat code").
  //    Their unit + integration suites were moved to `test/archive/`,
  //    and `hardhat.node.config.ts` was patched to exclude that
  //    directory from `TASK_TEST_GET_TEST_FILES`. No active test
  //    invokes any function on an archived contract.
  //
  //    Important nuance — the archived contracts are NOT fully
  //    name-isolated from active code:
  //
  //      * Their sources still live under `contracts/archive/` and
  //        Hardhat compiles them.
  //      * A few `deploy/active/*.ts` scripts still list them as
  //        fixture dependencies for deployment-slot parity (e.g.
  //        `054_deploy_dkg_staking_conviction_nft.ts:28` keeps
  //        `'Staking'` "only because slot during tests — the NFT
  //        wrapper itself does not call into V8 Staking", per the
  //        inline comment there).
  //      * A few active test files
  //        (`test/integration/RandomSampling.test.ts`,
  //        `test/helpers/setup-helpers.ts`,
  //        `test/helpers/kc-helpers.ts`) import V8 typechain types
  //        and hold contract handles to them for fixture parity.
  //
  //    So the safety argument for this skip is NOT "no active code
  //    references archived contracts" — that's empirically false.
  //    The safety argument is "no active test invokes archived
  //    contract bytecode", which the lcov data itself proves:
  //    instrumenting `archive/` only adds rows whose hit counts are
  //    all zero. Removing them shrinks the LF/BRF/FNF denominators
  //    but leaves LH/BRH/FNH unchanged.
  //
  //    Measured on `fix/solidity-coverage-skip-archive`:
  //
  //                          LF    LH | BRF  BRH | FNF FNH
  //      with `archive`:   4061  2279 | 2222 1030 | 926 529
  //      no  `archive`:    3173  2279 | 1776 1030 | 777 529
  //      delta:            -888    0  | -446    0 | -149   0
  //
  //    Every hit count is identical → the skip removes only dead
  //    rows. The same equality is the maintenance contract for this
  //    skip: if a future PR makes any archived contract's bytecode
  //    reachable from an active test, the with-archive LH / BRH /
  //    FNH would tick UP and diverge from the without-archive
  //    numbers — that's the moment to either restore tests for the
  //    contract (un-archive it) or strip the active invocation.
  //
  //    To re-verify safety when archive contents or active fixtures
  //    change, temporarily drop `'archive'` from `skipFiles` below,
  //    run `pnpm test:coverage` in `packages/evm-module/`, record the
  //    resulting LH / BRH / FNH, restore the skip, re-run, and
  //    confirm equality of the three hit counts.
  skipFiles: ['Identity.sol', 'archive'],
};
