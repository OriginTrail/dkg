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

export function registerCclCommand(program: Command): void {
const cclCmd = program
  .command('ccl')
  .description('Manage contextGraph-scoped CCL policies');

const cclPolicyCmd = cclCmd
  .command('policy')
  .description('Publish, approve, revoke, list, and resolve CCL policies');

cclPolicyCmd
  .command('publish <contextGraphId>')
  .description('Publish a CCL policy proposal into the ontology graph')
  .requiredOption('--name <name>', 'Policy name')
  .requiredOption('--version <version>', 'Policy version')
  .requiredOption('--file <path>', 'Path to canonical policy file')
  .option('--description <desc>', 'Description of the policy')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .option('--language <language>', 'Policy language identifier', 'ccl/v0.1')
  .option('--format <format>', 'Canonical policy format', 'canonical-yaml')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const content = readFileSync(opts.file, 'utf8');
      const result = await client.publishCclPolicy({
        contextGraphId,
        name: opts.name,
        version: opts.version,
        content,
        description: opts.description,
        contextType: opts.contextType,
        language: opts.language,
        format: opts.format,
      });
      console.log(`Policy published:`);
      console.log(`  URI:    ${result.policyUri}`);
      console.log(`  Hash:   ${result.hash}`);
      console.log(`  Status: ${result.status}`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

cclPolicyCmd
  .command('approve <contextGraphId> <policyUri>')
  .description('Approve a published CCL policy for a context graph')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .action(async (contextGraphId: string, policyUri: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.approveCclPolicy({ contextGraphId, policyUri, contextType: opts.contextType });
      console.log(`Policy approved:`);
      console.log(`  Policy:   ${result.policyUri}`);
      console.log(`  Binding:  ${result.bindingUri}`);
      if (result.contextType) console.log(`  Context:  ${result.contextType}`);
      console.log(`  Approved: ${result.approvedAt}`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

cclPolicyCmd
  .command('revoke <contextGraphId> <policyUri>')
  .description('Revoke the currently active CCL policy binding for a context graph')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .action(async (contextGraphId: string, policyUri: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.revokeCclPolicy({ contextGraphId, policyUri, contextType: opts.contextType });
      console.log(`Policy revoked:`);
      console.log(`  Policy:   ${result.policyUri}`);
      console.log(`  Binding:  ${result.bindingUri}`);
      if (result.contextType) console.log(`  Context:  ${result.contextType}`);
      console.log(`  Revoked:  ${result.revokedAt}`);
      console.log(`  Status:   ${result.status}`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

cclPolicyCmd
  .command('list')
  .description('List known CCL policies')
  .option('--context-graph <id>', 'Filter by contextGraph id')
  .option('--name <name>', 'Filter by policy name')
  .option('--context-type <contextType>', 'Filter by context type')
  .option('--status <status>', 'Filter by status')
  .option('--include-body', 'Include policy body in output')
  .action(async (opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const { policies } = await client.listCclPolicies({
        contextGraphId: opts.contextGraph,
        name: opts.name,
        contextType: opts.contextType,
        status: opts.status,
        includeBody: !!opts.includeBody,
      });
      if (policies.length === 0) {
        console.log('No CCL policies found.');
        return;
      }
      for (const policy of policies) {
        console.log(`${policy.name}@${policy.version}  ${policy.policyUri}`);
      console.log(`  Context Graph: ${policy.contextGraphId}`);
      console.log(`  Status:        ${policy.status}${policy.isActiveDefault ? ' (active default)' : ''}`);
      if (policy.contextType) console.log(`  Context:       ${policy.contextType}`);
        if (policy.activeContexts?.length) console.log(`  Active in contexts: ${policy.activeContexts.join(', ')}`);
        console.log(`  Hash:    ${policy.hash}`);
        if (policy.description) console.log(`  Desc:    ${policy.description}`);
        if (opts.includeBody && policy.body) console.log(`  Body:\n${policy.body}`);
      }
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

cclPolicyCmd
  .command('resolve <contextGraphId>')
  .description('Resolve the active approved policy for a context graph and policy name')
  .requiredOption('--name <name>', 'Policy name')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .option('--include-body', 'Include policy body in output')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const { policy } = await client.resolveCclPolicy({
        contextGraphId,
        name: opts.name,
        contextType: opts.contextType,
        includeBody: !!opts.includeBody,
      });
      if (!policy) {
        console.log('No approved policy found for that scope.');
        return;
      }
      console.log(`Resolved policy:`);
      console.log(`  URI:     ${policy.policyUri}`);
      console.log(`  Name:    ${policy.name}@${policy.version}`);
      console.log(`  Context Graph: ${policy.contextGraphId}`);
      console.log(`  Hash:    ${policy.hash}`);
      if (policy.contextType) console.log(`  Context: ${policy.contextType}`);
      if (policy.body) console.log(`  Body:\n${policy.body}`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

cclCmd
  .command('eval <contextGraphId>')
  .description('Resolve the approved CCL policy for a context graph and evaluate it against facts')
  .requiredOption('--name <name>', 'Policy name')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .option('--case <path>', 'YAML/JSON file with { facts, context? }')
  .option('--facts-file <path>', 'YAML/JSON file containing facts array')
  .option('--publish-result', 'Publish the evaluation output back into the contextGraph as typed records')
  .option('--view <view>', 'Declared view, for example accepted')
  .option('--snapshot-id <snapshotId>', 'Snapshot identifier')
  .option('--scope-ual <scopeUal>', 'Scope UAL for evaluation')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      let payload: { facts: Array<[string, ...unknown[]]>; view?: string; snapshotId?: string; scopeUal?: string } | null = null;

      if (opts.case) {
        const parsed = loadStructuredFile(opts.case) as any;
        payload = {
          facts: parsed?.facts ?? [],
          view: opts.view ?? parsed?.context?.view,
          snapshotId: opts.snapshotId ?? parsed?.context?.snapshot_id,
          scopeUal: opts.scopeUal ?? parsed?.context?.scope_ual,
        };
      } else if (opts.factsFile) {
        const parsed = loadStructuredFile(opts.factsFile) as any;
        payload = {
          facts: Array.isArray(parsed) ? parsed : parsed?.facts ?? [],
          view: opts.view,
          snapshotId: opts.snapshotId,
          scopeUal: opts.scopeUal,
        };
      }

      // Allow snapshot-resolved mode: if no facts provided but scope options
      // are given, the agent resolves facts from the graph snapshot.
      const isSnapshotMode = !payload && (opts.snapshotId || opts.view || opts.scopeUal);
      if (!payload && !isSnapshotMode) {
        throw new Error('Provide --case, --facts-file, or --snapshot-id/--view/--scope-ual for snapshot-resolved evaluation');
      }

      const result = await client.evaluateCclPolicy({
        contextGraphId,
        name: opts.name,
        contextType: opts.contextType,
        facts: payload?.facts,
        view: payload?.view ?? opts.view,
        snapshotId: payload?.snapshotId ?? opts.snapshotId,
        scopeUal: payload?.scopeUal ?? opts.scopeUal,
        publishResult: !!opts.publishResult,
      });

      console.log(JSON.stringify(result, null, 2));
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

cclCmd
  .command('results <contextGraphId>')
  .description('List published CCL evaluation results for a context graph')
  .option('--policy-uri <policyUri>', 'Filter by evaluated policy URI')
  .option('--snapshot-id <snapshotId>', 'Filter by snapshot id')
  .option('--view <view>', 'Filter by view')
  .option('--context-type <contextType>', 'Filter by context type')
  .option('--result-kind <kind>', 'Filter by result kind: derived or decision')
  .option('--result-name <name>', 'Filter by result predicate/decision name')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const { evaluations } = await client.listCclEvaluations({
        contextGraphId,
        policyUri: opts.policyUri,
        snapshotId: opts.snapshotId,
        view: opts.view,
        contextType: opts.contextType,
        resultKind: opts.resultKind,
        resultName: opts.resultName,
      });
      console.log(JSON.stringify({ evaluations }, null, 2));
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

}
