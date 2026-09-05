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
  FAUCET_WALLETS_PER_REQUEST,
  getFundableWalletAddresses,
  requestFaucetFunding,
  resolveDkgConfigHome,
  toErrorMessage,
  hasErrorCode,
} from '@origintrail-official/dkg-core';
import yaml from 'js-yaml';
import {
  loadConfig, saveConfig, configExists, configPath, exitOnStoreConfigErrors,
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
  sendCliRawTransactionWithFailover,
  CLI_RPC_READ_STALL_TIMEOUT_MS,
  CLI_RPC_BROADCAST_TIMEOUT_MS,
} from '../cli-rpc.js';
import {
  appendSupervisorLog,
  supervisorWarn,
  maybeStartSupervisorLivenessWatcher,
  runDaemonSupervisor,
  runForegroundSupervisor,
} from '../cli-supervisor.js';
import { resolveDaemonNodeCommand } from '../daemon-entrypoint.js';

export function registerLifecycleCommands(program: Command): void {
// ─── dkg start ───────────────────────────────────────────────────────

program
  .command('daemon-worker', { hidden: true })
  .description('Internal: run daemon worker process')
  .action(async () => {
    await runDaemon(false);
  });

program
  .command('daemon-foreground-worker', { hidden: true })
  .description('Internal: run foreground daemon worker process')
  .action(async () => {
    await runDaemon(true);
  });

program
  .command('daemon-supervisor', { hidden: true })
  .description('Internal: supervise daemon worker restarts')
  .action(async () => {
    await runDaemonSupervisor();
  });

program
  .command('start')
  .description('Start the DKG daemon')
  .option('-f, --foreground', 'Run in the foreground (don\'t daemonize)')
  .option(
    '--relay-preferred <multiaddr>',
    'Operator-preferred relay multiaddr to prioritise over the network relay set (repeatable; rc.9 PR-7). Multiple uses prepend in CLI-declaration order. See docs/messenger-operator.md for the relay-setup playbook.',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .action(async (opts: ActionOpts) => {
    if (!configExists()) {
      console.error('No config found. Run "dkg init" first.');
      process.exit(1);
    }

    exitOnStoreConfigErrors(await loadConfig(), (message) => console.error(message));

    const pid = await readPid();
    if (pid && isProcessRunning(pid)) {
      console.error(`Daemon already running (PID ${pid}). Use "dkg stop" first.`);
      process.exit(1);
    }

    // OT-RFC-41 §4.1 / Bundle B1a: blue-green slot initialization is
    // a Core-only concern under rc.12+. Edge nodes run directly from
    // the npm-global install. Pre-rc.12 Edge users may still have
    // legacy ~/.dkg/releases/ on disk; noteEdgeLegacyReleases() records
    // the slot version as a rollback target without auto-deleting the
    // directory (operator owns cleanup per RFC).
    if (!process.env.DKG_NO_BLUE_GREEN) {
      const startConfig = await loadConfig().catch(() => null);
      const startNodeRole = startConfig?.nodeRole ?? 'edge';
      if (startNodeRole === 'core') {
        await migrateToBlueGreen((msg) => console.log(msg), {
          allowRemoteBootstrap: false,
          repairLiveNodeUi: true,
        });
      } else {
        await noteEdgeLegacyReleases((msg) => console.log(msg));
      }
    }

    // rc.9 PR-7: forward --relay-preferred to the spawned daemon via
    // env var. Comma-separated so the receiver can split + filter
    // empty/duplicate entries in `lifecycle.ts`. Build an explicit
    // child env so an ambient DKG_RELAY_PREFERRED in the user's shell
    // does not silently affect `dkg start` when the flag is omitted.
    // Persistent config (`config.preferredRelays`) is a separate
    // source — the daemon merges both lists with the env taking
    // declaration order first.
    const relayPreferredOpt = Array.isArray(opts.relayPreferred) ? (opts.relayPreferred as string[]) : [];
    const cleanedRelayPreferred = relayPreferredOpt.map((s) => s.trim()).filter((s) => s.length > 0);
    const daemonEnv: NodeJS.ProcessEnv = withSelectedDkgHome(process.env);
    if (cleanedRelayPreferred.length > 0) {
      daemonEnv.DKG_RELAY_PREFERRED = cleanedRelayPreferred.join(',');
      console.log(
        `Preferring ${cleanedRelayPreferred.length} operator relay(s) for this run (DKG_RELAY_PREFERRED env var set; see ~/.dkg/config.json#preferredRelays for persistence).`,
      );
    } else {
      delete daemonEnv.DKG_RELAY_PREFERRED;
    }

    if (opts.foreground) {
      await runForegroundSupervisor(daemonEnv);
      return;
    }

    // Spawn the detached supervisor through the same canonical command
    // boundary used for worker restarts and update verification.
    const daemonCommand = resolveDaemonNodeCommand('daemon-supervisor');
    const child = spawn(
      daemonCommand.executable,
      daemonCommand.args,
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: daemonEnv,
      },
    );
    child.unref();

    // Wait for daemon to write its PID file and API port
    let startedPid: number | null = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const newPid = await readPid();
      if (newPid && isProcessRunning(newPid)) {
        startedPid = newPid;
        const rawPort = await readApiPort().catch(() => null);
        if (Number.isFinite(rawPort) && rawPort! > 0) break;
      }
    }
    if (startedPid && isProcessRunning(startedPid)) {
      const config = await loadConfig();
      const rawPort = await readApiPort().catch(() => null);
      const port = (Number.isFinite(rawPort) && rawPort! > 0) ? rawPort : (config.apiPort ?? 9200);
      const host = config.apiHost && config.apiHost !== '0.0.0.0' ? config.apiHost : '127.0.0.1';
      const hostDisplay = host.includes(':') ? `[${host}]` : host;
      const isTTY = process.stdout.isTTY;
      const cyan = (s: string) => isTTY ? `\x1b[4m\x1b[36m${s}\x1b[0m` : s;
      const yellow = (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
      console.log(isTTY ? STARTUP_BANNER : '');
      console.log(`  Node:       ${config.name} (PID ${startedPid})`);
      console.log(`  Node UI:    ${cyan(`http://${hostDisplay}:${port}/ui`)}`);
      console.log(`  GitHub:     ${cyan(loadProjectConfig().githubUrl)}`);
      console.log(`  Discord:    ${cyan('https://discord.com/invite/xCaY7hvNwD')}`);
      console.log(`  Logs:       ${logPath()}`);
      console.log('');
      return;
    }
    console.error('Daemon did not start within 15s. Check logs:', logPath());
    process.exit(1);
  });

// ─── dkg stop ────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop the DKG daemon')
  .action(async () => {
    try {
      const client = await ApiClient.connect();
      await client.shutdown();
      console.log('Daemon stopping...');
      // Wait for process to exit
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const pid = await readPid();
        if (!pid || !isProcessRunning(pid)) {
          console.log('Stopped.');
          return;
        }
      }
      console.log('Daemon still running after 10s — you may need to kill it manually.');
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg status ──────────────────────────────────────────────────────

program
  .command('status')
  .description('Show node status')
  .action(async () => {
    try {
      const client = await ApiClient.connect({ allowConfigFallback: true });
      const s = await client.status();
      const uptime = formatUptime(s.uptimeMs);
      console.log(`  Node:      ${s.name}`);
      console.log(`  Role:      ${s.nodeRole ?? 'edge'}`);
      if (s.networkConfig) console.log(`  Config:    ${s.networkConfig}`);
      console.log(`  Network:   ${s.networkId ?? '—'}`);
      console.log(`  PeerId:    ${s.peerId}`);
      console.log(`  Uptime:    ${uptime}`);
      console.log(`  Peers:     ${s.connectedPeers}`);
      console.log(`  Relay:     ${s.relayConnected ? 'connected' : 'not connected'}`);
      // Backend visibility: local backends print just the name (file
      // bytes are graphed via /api/dashboard); external backends print
      // backend + endpoint + quad count, falling back to a clear
      // "unreachable" signal when the daemon couldn't talk to the
      // remote store. A new daemon marks the initial background count
      // as pending so it renders as CHECKING; absent that marker, null
      // retains its legacy unreachable meaning for older daemons.
      const backend = s.storeBackend ?? 'oxigraph-worker';
      if (s.storeUrl) {
        const quads = s.storeQuadsStatus === 'pending'
          ? 'CHECKING'
          : s.storeQuads == null
            ? 'UNREACHABLE'
            : `${s.storeQuads.toLocaleString()} quads`;
        console.log(`  Store:     ${backend} (${s.storeUrl}) — ${quads}`);
      } else {
        console.log(`  Store:     ${backend}`);
      }
      if (client.controlPlaneWarning) console.warn(client.controlPlaneWarning);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
