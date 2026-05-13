/**
 * Shared devnet test utilities — re-export hub.
 *
 * The four devnet test suites (`agent-provenance`, `v10-core-flows`,
 * `v10-end-to-end`, `v10-stress`) historically duplicated ~500 lines of
 * helpers (CLI subprocess, contract loading, PCA setup, token funding,
 * nonce management, …). This module is the convergence point — every
 * suite imports from here so a single fix lands everywhere.
 *
 * Conventions:
 *   - All helpers are pure where possible (no module state).
 *   - Every helper either succeeds or throws a vitest-formatted error
 *     with enough context to debug from CI logs alone.
 *   - No mocks, no test doubles, no `vi.mock` — every helper talks to a
 *     real running devnet (Hardhat + N daemons + N×{oxigraph} + blazegraph).
 */
export {
  assertDevnetReady,
  PreflightError,
  REPO_ROOT,
  RPC,
  DEVNET_DIR,
  CONTRACTS_PATH,
  type PreflightOptions,
} from './preflight';
export {
  expectTxSuccess,
  expectMintedTokenId,
  parseEventOrThrow,
  parseEventIfPresent,
  expectRevert,
} from './tx';
export {
  runDkgCli,
  publishViaCli,
  type CliResult,
  type DevnetNodeForCli,
  type PublishCliResult,
} from './cli';
