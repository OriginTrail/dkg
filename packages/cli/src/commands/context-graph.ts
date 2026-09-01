import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, unlink, appendFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { normalizePositiveUint256, resolveRpcUrls } from '@origintrail-official/dkg-chain';
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

export function registerContextGraphCommand(program: Command): void {
// ─── dkg context-graph ──────────────────────────────────────────────────

const contextGraphCmd = program
  .command('context-graph')
  .description('Manage context graphs (knowledge graph partitions)');

contextGraphCmd
  .command('catchup-status <context-graph>')
  .description('Show latest background catch-up status for a context graph')
  .option('--watch', 'Poll until the catch-up job reaches a terminal state')
  .option('--interval <seconds>', 'Polling interval for --watch', '2')
  .action(async (contextGraph: string, opts: CatchupStatusCommandOptions) => {
    try {
      await runCatchupStatusCommand(contextGraph, opts);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('create <id>')
  .description('Create a new context graph (free, P2P — no chain transaction). If <id> has no "/" it is auto-prefixed with your agent address.')
  .option('-n, --name <name>', 'Human-readable name (defaults to id)')
  .option('-d, --description <desc>', 'Description of the context graph')
  .option('--access-policy <n>', 'Access policy: 0 = open (default), 1 = curated/private', parseInt)
  .option(
    '--allowed-agent <address>',
    'Agent address to add to allowlist (repeatable, implies --access-policy 1)',
    (value: string, previous: string[] = []) => [...previous, value],
    [] as string[],
  )
  .option('--invite <peer...>', 'Invite peers by peer ID (deprecated — use --allowed-agent)')
  .option('--private', 'Create a private local-only context graph')
  .option('--subscribe', 'Also subscribe to the context graph after creation', true)
  .option('--save', 'Persist subscription to config')
  .action(async (id: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();

      // Auto-namespace: bare slug -> {agentAddress}/{slug}
      if (!id.includes('/')) {
        const identity = await client.getAgentIdentity();
        id = `${identity.agentAddress}/${id}`;
      }

      const allowedAgents = (opts.allowedAgent as string[] | undefined) ?? [];
      // pcaAccountId is intentionally NOT a flag on `create` —
      // `createContextGraph` no longer persists the id, so a
      // create-time flag would silently drop the PCA configuration
      // before `register <id>` is run (Codex PR #502 round-4). Users
      // who want PCA-curated registration pass `--pca-account-id` on
      // `dkg context-graph register <id>` instead.
      const accessPolicy = allowedAgents.length > 0 ? 1 : (opts.accessPolicy as number | undefined);

      const result = await client.createContextGraph(id, opts.name ?? id, opts.description, {
        private: !!opts.private,
        accessPolicy,
        allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
      }, opts.invite as string[] | undefined);
      console.log(`Context graph created:`);
      console.log(`  ID:   ${result.created}`);
      console.log(`  URI:  ${result.uri}`);
      console.log(`  ${opts.private ? 'Private local-only graph created.' : 'Auto-subscribed to GossipSub topic.'}`);
      if (allowedAgents.length > 0) {
        console.log(`  Allowed agents: ${allowedAgents.join(', ')}`);
      }
      if (opts.invite?.length) {
        console.log(`  Invited ${(opts.invite as string[]).length} peer(s) via allowlist (legacy).`);
      }
      console.log(`  Run 'dkg context-graph register ${id}' to register on-chain (unlocks Verifiable Memory).`);

      if (opts.save) {
        const config = await loadConfig();
        const cgs = new Set(resolveContextGraphs(config));
        cgs.add(id);
        config.contextGraphs = [...cgs];
        config.contextGraphs = [...cgs];
        await saveConfig(config);
        console.log('  Saved to config (will auto-subscribe on restart).');
      }
    } catch (err) {
      const message = toErrorMessage(err);
      console.error(message);
      process.exit(1);
    }
  });

contextGraphCmd
  .command('register <id>')
  .description('Register an existing context graph on-chain (unlocks Verifiable Memory; requires gas and either a TRAC deposit or eligible PCA waiver)')
  .option('--reveal', 'Deprecated: V10 ContextGraphs registration does not reveal cleartext metadata on-chain')
  .option('--access-policy <n>', 'Access policy: 0 = public/discoverable, 1 = private/curated', parseInt)
  .option('--publish-policy <n>', 'Publish policy: 0 = curated, 1 = open', parseInt)
  .option(
    '--pca-account-id <id>',
    'Publishing Conviction Account id for curated registration by its owner or an exact-account registered agent',
    (value: string) => normalizePositiveUint256(value, '--pca-account-id'),
  )
  .option(
    '--registration-pca-account-id <id>',
    'Publishing Conviction Account id used only for this registration deposit waiver attempt',
    (value: string) => normalizePositiveUint256(value, '--registration-pca-account-id'),
  )
  .action(async (id: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      if (opts.reveal) {
        console.warn('--reveal is deprecated and ignored for V10 ContextGraphs registration.');
      }
      const pcaAccountId = opts.pcaAccountId as bigint | undefined;
      const registrationPcaAccountId = opts.registrationPcaAccountId as bigint | undefined;
      const result = await client.registerContextGraph(id, {
        accessPolicy: opts.accessPolicy != null ? Number(opts.accessPolicy) : undefined,
        publishPolicy: opts.publishPolicy != null ? Number(opts.publishPolicy) : undefined,
        pcaAccountId,
        registrationPcaAccountId,
      });
      console.log(`Context graph registered on-chain:`);
      console.log(`  ID:         ${id}`);
      console.log(`  On-chain:   ${result.onChainId}`);
      if (pcaAccountId) {
        console.log(`  PCA account id: ${pcaAccountId}`);
      }
      if (registrationPcaAccountId) {
        console.log(`  Registration PCA account id: ${registrationPcaAccountId}`);
      }
      console.log(`  ${result.hint ?? 'You can now publish SWM to Verifiable Memory.'}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('invite <contextGraphId>')
  .description('[DEPRECATED] Invite a peer by peer ID — use "add-agent" instead')
  .requiredOption('--peer <peerId>', 'Peer ID to invite')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    console.error('Warning: "context-graph invite --peer" is deprecated. Use "context-graph add-agent --agent" instead.');
    try {
      const client = await ApiClient.connect();
      await client.inviteToContextGraph(contextGraphId, opts.peer);
      console.log(`Peer invited:`);
      console.log(`  Context Graph: ${contextGraphId}`);
      console.log(`  Peer:          ${opts.peer}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('add-agent <contextGraphId>')
  .description('Add an agent to a curated context graph allowlist')
  .requiredOption('--agent <address>', 'Agent Ethereum address (0x...)')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      await client.addAgent(contextGraphId, opts.agent);
      console.log(`Agent added to allowlist:`);
      console.log(`  Context Graph: ${contextGraphId}`);
      console.log(`  Agent:         ${opts.agent}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('create-sub-graph <contextGraphId> <subGraphName>')
  .description('Register a sub-graph inside a context graph (required before EPCIS captures or sub-graph-targeted publishes can enqueue).')
  .action(async (contextGraphId: string, subGraphName: string) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.createSubGraph(contextGraphId, subGraphName);
      console.log('Sub-graph registered:');
      console.log(`  Context Graph: ${result.contextGraphId}`);
      console.log(`  Sub-graph:     ${result.created}`);
    } catch (err) {
      const msg = toErrorMessage(err);
      if (/already exists/i.test(msg)) {
        console.log(`Sub-graph "${subGraphName}" already exists in context graph "${contextGraphId}" — nothing to do.`);
        return;
      }
      console.error(msg);
      process.exit(1);
    }
  });

contextGraphCmd
  .command('remove-agent <contextGraphId>')
  .description('Remove an agent from a context graph allowlist')
  .requiredOption('--agent <address>', 'Agent Ethereum address (0x...)')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      await client.removeAgent(contextGraphId, opts.agent);
      console.log(`Agent removed from allowlist:`);
      console.log(`  Context Graph: ${contextGraphId}`);
      console.log(`  Agent:         ${opts.agent}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('agents <contextGraphId>')
  .description('List agents allowed in a context graph')
  .action(async (contextGraphId: string) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.listAgents(contextGraphId);
      if (!result.allowedAgents || result.allowedAgents.length === 0) {
        console.log(`No allowlist configured for "${contextGraphId}" (open access).`);
        return;
      }
      console.log(`Allowed agents for "${contextGraphId}":`);
      for (const addr of result.allowedAgents) {
        console.log(`  ${addr}`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('request-join <contextGraphId> <curatorPeerId>')
  .description(
    'Sign a join request and forward it to the curator. The curatorPeerId ' +
    'is the libp2p peer id from the V10 invite ("<cgId>\\n<peerId>") and ' +
    'is required so the daemon can authenticate the curator\'s eventual ' +
    'approve/reject notification. To produce a signed delegation without ' +
    'forwarding (e.g. to hand off to the curator out-of-band), use ' +
    '`dkg context-graph sign-join` instead.',
  )
  .action(async (contextGraphId: string, curatorPeerId: string) => {
    try {
      const client = await ApiClient.connect();
      // Step 1: sign-only. Returns the SignedAgentDelegation. Cheap and
      // independent of P2P delivery — works on a freshly-started node
      // before any peers are connected.
      const signed = await client.signJoinRequest(contextGraphId);
      // Step 2: forward via P2P. The daemon delivers the signed
      // delegation directly to the curator. Returns delivery count so we can
      // warn on no-curator.
      const result = await client.requestJoin(contextGraphId, signed.delegation, curatorPeerId);
      if (result.delivered === 0) {
        console.error(`Could not deliver join request to curator for "${contextGraphId}". No reachable curator found.`);
        process.exit(1);
      }
      if (result.status === 'approved' || result.status === 'already-member' || result.autoApproved || result.alreadyMember) {
        console.log(`Join approved for "${contextGraphId}".`);
        console.log(`  Open it with: dkg context-graph info ${contextGraphId}`);
      } else {
        console.log(`Join request sent for "${contextGraphId}" (delivered to ${result.delivered} peer${result.delivered === 1 ? '' : 's'}).`);
        console.log('  Waiting for curator approval. Check status with:');
        console.log(`  dkg context-graph info ${contextGraphId}`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('sign-join <contextGraphId>')
  .description(
    'Sign a join-request delegation locally without forwarding it to the ' +
    'curator. Prints the SignedAgentDelegation as JSON, suitable for ' +
    'piping to another tool or sharing out-of-band. To both sign AND ' +
    'forward (the common case), use `dkg context-graph request-join`.',
  )
  .action(async (contextGraphId: string) => {
    try {
      const client = await ApiClient.connect();
      const signed = await client.signJoinRequest(contextGraphId);
      console.log(JSON.stringify(signed.delegation, null, 2));
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('approve-join <contextGraphId>')
  .description('Approve a pending join request (curator only)')
  .requiredOption('--agent <address>', 'Agent address to approve')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      await client.approveJoin(contextGraphId, opts.agent);
      console.log(`Join request approved:`);
      console.log(`  Context Graph: ${contextGraphId}`);
      console.log(`  Agent:         ${opts.agent}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('reject-join <contextGraphId>')
  .description('Reject a pending join request (curator only)')
  .requiredOption('--agent <address>', 'Agent address to reject')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      await client.rejectJoin(contextGraphId, opts.agent);
      console.log(`Join request rejected:`);
      console.log(`  Context Graph: ${contextGraphId}`);
      console.log(`  Agent:         ${opts.agent}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('join-requests <contextGraphId>')
  .description('List pending join requests for a context graph (curator only)')
  .action(async (contextGraphId: string) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.listJoinRequests(contextGraphId);
      if (!result.requests || result.requests.length === 0) {
        console.log(`No pending join requests for "${contextGraphId}".`);
        return;
      }
      console.log(`Join requests for "${contextGraphId}":`);
      for (const req of result.requests) {
        const name = req.agentName ? ` (${req.agentName})` : '';
        const ts = req.timestamp ? ` — ${req.timestamp}` : '';
        console.log(`  [${req.status}] ${req.agentAddress}${name}${ts}`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

const joinPolicyCmd = contextGraphCmd
  .command('join-policy')
  .description('Inspect or change private Context Graph open enrollment (owner only)');

joinPolicyCmd
  .command('status <contextGraphId>')
  .description('Show whether open enrollment is enabled for a private Context Graph')
  .action(async (contextGraphId: string) => {
    try {
      const client = await ApiClient.connect();
      const policy = await client.getContextGraphJoinPolicy(contextGraphId);
      console.log(`Open enrollment policy for "${policy.contextGraphId || contextGraphId}":`);
      console.log(`  Mode:                    ${policy.mode}`);
      console.log(`  Members:                 ${policy.memberCount ?? 'unknown'}`);
      console.log(`  Maximum members:         ${policy.maxMembers ?? 'not set'}`);
      console.log(`  Approvals in last hour:  ${policy.approvalsLastHour ?? 'unknown'}`);
      console.log(`  Maximum approvals/hour:  ${policy.maxApprovalsPerHour ?? 'not set'}`);
      if (policy.mode === 'open') {
        console.warn('WARNING: Anyone who knows this Context Graph ID can request private access through open enrollment and may gain publishing authority.');
      } else {
        console.log('  New join requests require manual approval. Existing members are not revoked.');
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

joinPolicyCmd
  .command('open <contextGraphId>')
  .description('Enable open enrollment for a private Context Graph (owner only; security-sensitive)')
  .requiredOption('--max-members <positive>', 'Hard cap on total approved members', (value: string) => (
    parsePositiveIntegerOption(value, '--max-members')
  ))
  .option(
    '--max-approvals-per-hour <positive>',
    'Rolling cap on automatic approvals per hour',
    (value: string) => parsePositiveIntegerOption(value, '--max-approvals-per-hour'),
    20,
  )
  .option('--yes', 'Acknowledge the open-enrollment security risk')
  .action(async (contextGraphId: string, opts: ActionOpts) => {
    try {
      console.warn('WARNING: Anyone who knows this Context Graph ID can request private access through open enrollment and may gain publishing authority.');
      if (!opts.yes) {
        throw new Error('Open enrollment was not enabled. Re-run with --yes to acknowledge this risk.');
      }

      const maxMembers = Number(opts.maxMembers);
      const maxApprovalsPerHour = Number(opts.maxApprovalsPerHour);
      const client = await ApiClient.connect();
      await client.setContextGraphJoinPolicy(contextGraphId, {
        mode: 'open',
        maxMembers,
        maxApprovalsPerHour,
        acknowledgeOpenEnrollment: true,
      });
      console.log(`Open enrollment enabled for "${contextGraphId}".`);
      console.log(`  Maximum members:         ${maxMembers}`);
      console.log(`  Maximum approvals/hour:  ${maxApprovalsPerHour}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

joinPolicyCmd
  .command('manual <contextGraphId>')
  .description('Disable open enrollment and require manual approval for future requests')
  .action(async (contextGraphId: string) => {
    try {
      const client = await ApiClient.connect();
      await client.setContextGraphJoinPolicy(contextGraphId, { mode: 'manual' });
      console.log(`Open enrollment disabled for "${contextGraphId}"; future join requests require manual approval.`);
      console.log('Existing members remain approved; disabling open enrollment does not revoke existing members.');
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('list')
  .description('List all known context graphs')
  .action(async () => {
    try {
      const client = await ApiClient.connect();
      const { contextGraphs } = await client.listContextGraphs();

      if (contextGraphs.length === 0) {
        console.log('No context graphs registered yet.');
        return;
      }

      const idW = Math.max(4, ...contextGraphs.map(p => p.id.length));
      const nameW = Math.max(4, ...contextGraphs.map(p => p.name.length));

      const header = `  ${'ID'.padEnd(idW)}   ${'Name'.padEnd(nameW)}   Type       Creator`;
      console.log(header);
      console.log('  ' + '─'.repeat(header.length - 2));

      for (const p of contextGraphs) {
        const type = p.isSystem ? 'system' : 'user';
        const creator = p.creator
          ? (p.creator.length > 24 ? p.creator.slice(0, 12) + '...' + p.creator.slice(-8) : p.creator)
          : '—';
        console.log(`  ${p.id.padEnd(idW)}   ${p.name.padEnd(nameW)}   ${type.padEnd(9)}  ${creator}`);
      }
      console.log(`\n  ${contextGraphs.length} context graph(s)`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

contextGraphCmd
  .command('info <id>')
  .description('Show details of a specific context graph')
  .action(async (id: string) => {
    try {
      const client = await ApiClient.connect();
      const { contextGraphs } = await client.listContextGraphs();
      const p = contextGraphs.find((x: any) => x.id === id);
      if (!p) {
        console.error(`Context graph "${id}" not found.`);
        process.exit(1);
      }
      console.log(`  ID:          ${p.id}`);
      console.log(`  URI:         ${p.uri}`);
      console.log(`  Name:        ${p.name}`);
      console.log(`  Description: ${p.description ?? '—'}`);
      console.log(`  Type:        ${p.isSystem ? 'system' : 'user'}`);
      console.log(`  Creator:     ${p.creator ?? '—'}`);
      console.log(`  Created:     ${p.createdAt ?? '—'}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

}
