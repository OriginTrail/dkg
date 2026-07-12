import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, unlink, appendFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { resolveRpcUrls } from '@origintrail-official/dkg-chain';
import {
  dkgAuthTokenPath,
  resolveDkgConfigHome,
  toErrorMessage,
  hasErrorCode,
} from '@origintrail-official/dkg-core';
import yaml from 'js-yaml';
import {
  loadConfig, saveConfig, configExists, configPath,
  readPid, readApiPort, isProcessRunning, dkgDir, logPath, ensureDkgDir, removeApiPort,
  apiPortPath,
  loadNetworkConfig, loadProjectConfig, resolveAutoUpdateConfig, resolveAutoUpdateSource, resolveChainConfig,
  releasesDir, activeSlot, swapSlot,
  slotEntryPoint, isStandaloneInstall, repoDir, isDkgMonorepo,
  resolveContextGraphs, resolveNetworkDefaultContextGraphs,
  readNodeRoleFromConfigSync,
  type AutoUpdateConfig,
} from '../config.js';
import { ApiClient } from '../api-client.js';
import { parsePositiveIntegerOption, parsePositiveMsOption } from '../cli-option-parsers.js';
import { promptStoreBackend, applyStoreFlagsToConfig } from '../store-wizard.js';
import { supportedBackendList } from '../store-backends.js';
import { runConfiguredSourceWorker } from '../source-worker-runner.js';
import { batchEntityQuads } from '../batching.js';
import {
  runDaemon,
  checkForNpmVersionUpdate,
  performNpmUpdate,
  performNpmUpdateEdge,
  getCurrentCliVersion,
  DAEMON_EXIT_CODE_RESTART,
  resolveStandaloneInstall,
  decodeForcedExitCode,
} from '../daemon.js';
import {
  isLivenessProbeEnabled,
  startLivenessWatcher,
  LIVENESS_CONSECUTIVE_FAILURES_TO_KILL,
} from '../daemon/supervisor-liveness.js';
import { migrateToBlueGreen, noteEdgeLegacyReleases } from '../migration.js';
import { ensureRollbackNodeUiBundle } from '../rollback-node-ui.js';
import {
  isDaemonUnreachable,
  cliSleep,
  cliErrorMessage,
  STARTUP_BANNER,
  normalizeVersionTagRef,
  getCliVersion,
  parseOptionalVerifyTimeoutOption,
  loadStructuredFile,
  loadQuadsFromInput,
  resolveDaemonEntryPoint,
  probeHostForApiHost,
  selectedDkgHomeForEnv,
  withSelectedDkgHome,
  VERIFY_COLLECTION_TIMEOUT_MIN_MS,
  VERIFY_COLLECTION_TIMEOUT_MAX_MS,
  printCatchupStatus,
  runCatchupStatusCommand,
  printMessage,
  shortId,
  formatUptime,
  publishEntityBatches,
  formatPublisherJobOutput,
  formatPublisherJobValue,
  stripQuotes,
  formatQuadObject,
  sleep,
  stopDaemonIfRunning,
} from '../cli-helpers.js';
import type { ActionOpts, CatchupStatusCommandOptions } from '../cli-helpers.js';
import {
  cliWithTimeout,
  isCliKnownTransactionError,
  isCliRetryableRpcError,
  createCliEvmProviders,
  getCliReceiptWithFailover,
  assertCliSuccessfulReceipt,
  sendCliRawTransactionWithFailover,
  CLI_RPC_READ_STALL_TIMEOUT_MS,
  CLI_RPC_BROADCAST_TIMEOUT_MS,
  CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  CLI_RPC_RECEIPT_POLL_INTERVAL_MS,
  CLI_RPC_RECEIPT_TIMEOUT_MS,
} from '../cli-rpc.js';
import {
  appendSupervisorLog,
  supervisorWarn,
  maybeStartSupervisorLivenessWatcher,
  runDaemonSupervisor,
  runForegroundSupervisor,
} from '../cli-supervisor.js';

export function registerMcpCommand(program: Command): void {
// ─── dkg mcp ────────────────────────────────────────────────────────

const mcpCmd = program
  .command('mcp')
  .description('DKG MCP server for AI coding assistants (Cursor, Claude Code, …)');

mcpCmd
  .command('serve')
  .description('Run the DKG MCP server over stdio (invoked by the MCP-aware client)')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (_opts, command) => {
    // Pass any positional/extra args from the umbrella CLI through to the
    // MCP server's `main()` so its internal CLI subcommand dispatcher
    // (`join`, `status`, `help`) keeps working from the umbrella wrapper.
    const passthrough = command.args ?? [];
    let main: typeof import('@origintrail-official/dkg-mcp').main;
    try {
      ({ main } = await import('@origintrail-official/dkg-mcp'));
    } catch (err: any) {
      console.error('\n[dkg mcp serve] MCP server is not available.');
      console.error(`  Reason: ${err?.message ?? err}`);
      console.error('  • In a monorepo dev checkout: run `pnpm build` at the repo root to build all workspaces.');
      console.error('  • With a global install: reinstall with `npm install -g @origintrail-official/dkg`.\n');
      process.exit(1);
    }
    try {
      // Synthesise an argv whose `[2]` slot aligns with the MCP server's
      // own subcommand dispatcher. Without this, `dkg mcp serve join …`
      // would land `argv[2] === 'mcp'` inside the MCP server and the
      // `join` would never be seen.
      await main(['node', 'dkg-mcp', ...passthrough]);
    } catch (err: any) {
      console.error(`\n[dkg mcp serve] ERROR: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  });

mcpCmd
  .command('setup')
  .description('Bundled init + daemon-start + MCP-client registration (idempotent, safe to re-run)')
  .option('--port <port>', 'Override daemon API port (default: 9200)')
  .option('--name <name>', 'Override agent name (used only on first init)')
  .option('--no-start', 'Skip daemon start (configure only)')
  .option('--no-fund', 'Skip wallet funding via testnet faucet')
  .option(
    '--network <name>',
    'Network to set up on (mainnet-gnosis | mainnet-base | testnet). Default for a fresh node: mainnet-gnosis.',
  )
  .option('--no-verify', 'Skip post-setup verification probe')
  .option('--dry-run', 'Preview steps without writing or starting anything')
  .option('--force', 'Refresh every detected client regardless of current registration state')
  .option('--print-only', 'Print the canonical JSON to stdout; skip every other step')
  .option('--yes', 'Auto-confirm per-client registrations (default false: prompt interactively in TTY mode; non-TTY auto-confirms — pass `--yes` in scripts for the safer scripted-environment posture)')
  .option(
    '--store <backend>',
    `Triple-store backend (${supportedBackendList(' | ')}). Validates the URL and persists the store block after setup.`,
  )
  .option(
    '--store-url <url>',
    'SPARQL endpoint URL — required when --store is blazegraph or sparql-http.',
  )
  .option('--installed', 'Force installed-mode setup. Bootstrap home: `~/.dkg`. Registered binary: the running CLI (whichever invoked this command — typically the global `dkg`). Use this from a monorepo cwd when you want the global install instead of the local dist. Mutually exclusive with --monorepo.')
  .option('--monorepo', 'Force monorepo-mode setup. Bootstrap home: `~/.dkg-dev`. Registered binary: the local `<repo>/packages/cli/dist/cli.js` script (located via cwd-first walk; falls back to the running CLI dir). Errors if no DKG monorepo root is detected. Switches BOTH bootstrap home AND the registered binary, unlike --installed which only switches the home. Mutually exclusive with --installed.')
  .action(async (opts) => {
    // Dynamic-import the openclaw-setup primitives for the bundled
    // init + daemon-start. Same import surface (and same package
    // resolution failure mode) as `dkg openclaw setup` so a missing
    // adapter build emits a parallel error message.
    let openclawSetupExports: typeof import('@origintrail-official/dkg-adapter-openclaw');
    try {
      openclawSetupExports = await import('@origintrail-official/dkg-adapter-openclaw');
    } catch (err: any) {
      console.error('\n[dkg mcp setup] Setup primitives are not available.');
      console.error(`  Reason: ${err?.message ?? err}`);
      console.error('  • In a monorepo dev checkout: run `pnpm build` at the repo root to build all workspaces.');
      console.error('  • With a global install: reinstall with `npm install -g @origintrail-official/dkg`.\n');
      process.exit(1);
    }
    let coreExports: typeof import('@origintrail-official/dkg-core');
    try {
      coreExports = await import('@origintrail-official/dkg-core');
    } catch (err: any) {
      console.error('\n[dkg mcp setup] Core faucet primitive is not available.');
      console.error(`  Reason: ${err?.message ?? err}`);
      process.exit(1);
    }
    const { mcpSetupAction } = await import('../mcp-setup.js');
    try {
      await mcpSetupAction(opts, {
        loadNetworkConfig: openclawSetupExports.loadNetworkConfig,
        ensureDkgNodeConfig: coreExports.ensureDkgNodeConfig,
        startDaemon: openclawSetupExports.startDaemon,
        // Lazy + best-effort (parity with openclaw/hermes): dkg-agent is
        // imported only inside the non-dry-run wallet step, so `--print-only`
        // / `--dry-run` never require it, and an import failure degrades to a
        // warning (mcpSetupAction wraps the call in try/catch) instead of
        // aborting setup.
        loadOpWallets: async (dir: string) => {
          const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
          return loadOpWallets(dir);
        },
        // Shared faucet orchestrator — the SAME one openclaw/hermes use.
        // Replaces the old bespoke `/api/status` reachability probe +
        // `requestFaucetFunding` path that silently skipped funding on a slow
        // testnet node.
        fundWalletsBestEffort: coreExports.fundWalletsBestEffort,
        findDkgMonorepoRoot: coreExports.findDkgMonorepoRoot,
        resolveDkgConfigHome: coreExports.resolveDkgConfigHome,
      });
      await applyStoreFlagsToConfig({
        storeFlag: opts.store,
        storeUrlFlag: opts.storeUrl,
      });
    } catch (err: any) {
      console.error(`\n[dkg mcp setup] ERROR: ${err?.message ?? err}\n`);
      process.exit(1);
    }
  });

}
