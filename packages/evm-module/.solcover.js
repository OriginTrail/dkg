module.exports = {
  mocha: {
    timeout: 600_000,
  },
  providerOptions: {
    allowUnlimitedContractSize: true,
  },
  configureYulOptimizer: true,
  // Identity.sol cannot be instrumented under the production solc settings
  // (Solidity 0.8.20 + viaIR + optimizer runs=200): solidity-coverage's
  // instrumentation adds extra locals to `addOperationalWallets`, which
  // already sits at the edge of the EVM stack budget under viaIR, causing
  // `YulException: Variable _3 is 1 too deep in the stack` in CI's push
  // safety net.
  //
  // We exclude it from coverage *instrumentation only*. Production compile
  // (hardhat compile / hardhat test / Tornado: Solidity [N/4]) and the
  // contract's bytecode are untouched. The full Hardhat test suite still
  // exercises every code path in this file at its real bytecode in the PR
  // sharded Solidity job — the only thing the skip removes is line/branch
  // *reporting* for this file in the coverage HTML/lcov.
  skipFiles: ['Identity.sol'],
};
