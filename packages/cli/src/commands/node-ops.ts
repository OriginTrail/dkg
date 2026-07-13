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
  loadConfig, saveConfig, configExists, configPath,
  readPid, readApiPort, isProcessRunning, dkgDir, logPath, ensureDkgDir, removeApiPort,
  apiPortPath,
  loadNetworkConfig, loadResolvedNetworkConfig, loadProjectConfig, resolveAutoUpdateConfig, resolveAutoUpdateSource, resolveChainConfig, resolveReadyChainConfig,
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

export function registerNodeOpsCommands(program: Command): void {
// ─── dkg logs ────────────────────────────────────────────────────────

program
  .command('logs')
  .description('Tail the daemon log')
  .option('-n, --lines <n>', 'Number of trailing lines', '30')
  .action(async (opts: ActionOpts) => {
    const { readFile } = await import('node:fs/promises');
    try {
      const content = await readFile(logPath(), 'utf-8');
      const lines = content.trim().split('\n');
      const n = parseInt(opts.lines, 10);
      const tail = lines.slice(-n);
      for (const line of tail) console.log(line);
    } catch {
      console.error(`No log file at ${logPath()}`);
      process.exit(1);
    }
  });

// ─── dkg wallet ──────────────────────────────────────────────────────

program
  .command('wallet')
  .description('Show admin and operational wallet addresses and balances')
  .action(async () => {
    try {
      const config = await loadConfig();
      const { network } = await loadResolvedNetworkConfig(config, loadNetworkConfig);
      const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
      const opWallets = await loadOpWallets(dkgDir());

      if (!opWallets.wallets.length) {
        console.error('No operational wallets found. Run "dkg start" to auto-generate them.');
        process.exit(1);
      }

      const chainResolved = resolveChainConfig(config, network);
      const rpcUrl = chainResolved?.rpcUrl;
      const hubAddress = chainResolved?.hubAddress;
      const tokenAddress = chainResolved?.tokenAddress;
      const chainId = chainResolved?.chainId ?? '(unknown)';

      let provider: ethers.JsonRpcProvider | ethers.FallbackProvider | null = null;
      let token: ethers.Contract | null = null;
      let tokenSymbol = 'TRAC';

      if (rpcUrl) {
        try {
          provider = createCliEvmProviders(rpcUrl, chainResolved?.rpcUrls).readProvider;
          if (tokenAddress && tokenAddress !== ethers.ZeroAddress) {
            token = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'], provider);
            tokenSymbol = await token.symbol().catch(() => 'TRAC');
          } else if (hubAddress) {
            const hub = new ethers.Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
            const tokenAddr = await hub.getContractAddress('Token');
            if (tokenAddr !== ethers.ZeroAddress) {
              token = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'], provider);
              tokenSymbol = await token.symbol().catch(() => 'TRAC');
            }
          }
        } catch {
          provider = null;
        }
      }

      console.log(`\nAdmin wallet:\n`);
      if (opWallets.adminWallet) {
        console.log(`  ${opWallets.adminWallet.address}`);
        if (provider) {
          try {
            const ethBal = await provider.getBalance(opWallets.adminWallet.address);
            const tracBal = token ? await token.balanceOf(opWallets.adminWallet.address) : 0n;
            console.log(`  ETH: ${ethers.formatEther(ethBal)}  ${tokenSymbol}: ${ethers.formatEther(tracBal)}`);
          } catch {
            console.log('  (unable to query balances)');
          }
        }
      } else {
        console.log('  (missing from legacy wallets.json; add the profile admin key to enable key management)');
      }

      console.log(`\nOperational wallets (${opWallets.wallets.length}):\n`);
      for (let i = 0; i < opWallets.wallets.length; i++) {
        const addr = opWallets.wallets[i].address;
        const label = i === 0 ? '(primary)' : `(pool #${i + 1})`;
        console.log(`  ${label} ${addr}`);
        if (provider) {
          try {
            const ethBal = await provider.getBalance(addr);
            const tracBal = token ? await token.balanceOf(addr) : 0n;
            console.log(`           ETH: ${ethers.formatEther(ethBal)}  ${tokenSymbol}: ${ethers.formatEther(tracBal)}`);
          } catch {
            console.log('           (unable to query balances)');
          }
        }
      }

      console.log(`\n  Chain: ${chainId}`);
      if (rpcUrl) console.log(`  RPC:   ${rpcUrl}`);
      if (chainResolved?.rpcUrls?.length) console.log(`  RPC backups: ${chainResolved.rpcUrls.join(', ')}`);
      console.log(`  File:  ~/.dkg/wallets.json`);
      console.log('\nFund these addresses with ETH (gas) and TRAC (staking/publishing).');
      if (opWallets.adminWallet) {
        console.log('The admin wallet is used for profile key management. The primary operational wallet is used for staking; all operational wallets are used for publishing.\n');
      } else {
        console.log('Add the real profile admin key to wallets.json to enable profile key management and operational-wallet repair.\n');
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg set-ask <amount> ────────────────────────────────────────────

program
  .command('set-ask <amount>')
  .description('Set the node\'s on-chain ask (TRAC per KB·epoch)')
  .option('--identity <id>', 'Override identity ID (auto-detected from primary wallet by default)')
  .action(async (amount: string, opts: ActionOpts) => {
    try {
      const config = await loadConfig();
      const { network } = await loadResolvedNetworkConfig(config, loadNetworkConfig);
      const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
      const opWallets = await loadOpWallets(dkgDir());

      if (!opWallets.wallets.length) {
        console.error('No operational wallets found. Run "dkg start" to auto-generate them.');
        process.exit(1);
      }

      const chainResolved = resolveReadyChainConfig(config, network);
      const rpcUrl = chainResolved?.rpcUrl;
      const hubAddress = chainResolved?.hubAddress;
      if (!rpcUrl || !hubAddress) {
        console.error('Chain not configured. Run "dkg init" and set RPC URL + Hub address.');
        process.exit(1);
      }

      const askWei = ethers.parseEther(amount);
      if (askWei === 0n) {
        console.error('Ask must be > 0.');
        process.exit(1);
      }

      const rpcContext = createCliEvmProviders(
        rpcUrl,
        chainResolved?.rpcUrls,
        chainResolved.receiptTimeoutMs,
      );
      const { readProvider } = rpcContext;
      const wallet = new ethers.Wallet(opWallets.wallets[0].privateKey, readProvider);

      const hub = new ethers.Contract(hubAddress, [
        'function getContractAddress(string) view returns (address)',
      ], readProvider);

      const identityStorageAddr = await hub.getContractAddress('IdentityStorage');
      const identityStorage = new ethers.Contract(identityStorageAddr, [
        'function getIdentityId(address) view returns (uint72)',
      ], readProvider);

      let identityId: bigint;
      if (opts.identity) {
        identityId = BigInt(opts.identity);
      } else {
        identityId = await identityStorage.getIdentityId(wallet.address);
        if (identityId === 0n) {
          console.error(
            `No on-chain identity found for primary wallet ${wallet.address}.\n` +
            'Start the node first ("dkg start") so it creates an on-chain profile, or use --identity <id>.',
          );
          process.exit(1);
        }
      }

      const profileStorageAddr = await hub.getContractAddress('ProfileStorage');
      const profileStorage = new ethers.Contract(profileStorageAddr, [
        'function getAsk(uint72) view returns (uint96)',
      ], readProvider);
      const currentAsk = await profileStorage.getAsk(identityId);

      console.log(`  Identity:    ${identityId}`);
      console.log(`  Wallet:      ${wallet.address}`);
      console.log(`  Current ask: ${ethers.formatEther(currentAsk)} TRAC`);

      if (currentAsk === askWei) {
        console.log(`  Already set to ${amount} TRAC. Nothing to do.`);
        return;
      }

      const profileAddr = await hub.getContractAddress('Profile');
      const profile = new ethers.Contract(profileAddr, [
        'function updateAsk(uint72 identityId, uint96 ask)',
      ], wallet);

      console.log(`  Setting ask to ${amount} TRAC...`);
      const populated = await profile.updateAsk.populateTransaction(identityId, askWei);
      const filled = await wallet.populateTransaction(populated);
      const signedTx = await wallet.signTransaction(filled);
      const txHash = ethers.Transaction.from(signedTx).hash ?? '0x';
      console.log(`  TX: ${txHash}`);
      const receipt = await sendCliRawTransactionWithFailover(
        rpcContext,
        signedTx,
        txHash,
      );
      console.log(`  Confirmed in block ${receipt.blockNumber}`);
      console.log(`  New ask: ${amount} TRAC`);
    } catch (err) {
      if (hasErrorCode(err, 'CALL_EXCEPTION')) {
        console.error(
          `Transaction reverted. The primary wallet may not be the admin/operational key for this identity.\n` +
          `Use --identity <id> if auto-detection picked the wrong identity.`,
        );
      }
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── Helpers ─────────────────────────────────────────────────────────

}
