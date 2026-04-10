#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { ethers } from 'ethers';
import { requestFaucetFunding } from './faucet.js';
import { toErrorMessage, hasErrorCode } from '@origintrail-official/dkg-core';
import yaml from 'js-yaml';
import {
  loadConfig, saveConfig, configExists, configPath,
  readPid, readApiPort, isProcessRunning, dkgDir, logPath, ensureDkgDir,
  loadNetworkConfig, releasesDir, activeSlot, swapSlot,
  slotEntryPoint, isStandaloneInstall,
  resolveContextGraphs, resolveNetworkDefaultContextGraphs,
} from './config.js';
import { ApiClient } from './api-client.js';
import { parsePositiveMsOption } from './publisher-runner.js';
import { batchEntityQuads } from './batching.js';
import {
  runDaemon,
  performUpdateWithStatus,
  checkForNewCommitWithStatus,
  checkForNpmVersionUpdate,
  performNpmUpdate,
  DAEMON_EXIT_CODE_RESTART,
} from './daemon.js';
import { migrateToBlueGreen } from './migration.js';

/** Commander action callbacks receive parsed .option() values with loose types. */
type ActionOpts = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const STARTUP_BANNER = `
\x1b[36m██████╗ ██╗  ██╗ ██████╗     ██╗   ██╗ █████╗ 
██╔══██╗██║ ██╔╝██╔════╝     ██║   ██║██╔══██╗
██║  ██║█████╔╝ ██║  ███╗    ██║   ██║╚██████║
██║  ██║██╔═██╗ ██║   ██║    ╚██╗ ██╔╝ ╚═══██║
██████╔╝██║  ██╗╚██████╔╝     ╚████╔╝  █████╔╝
╚═════╝ ╚═╝  ╚═╝ ╚═════╝       ╚═══╝   ╚════╝\x1b[0m
`;

function normalizeVersionTagRef(input: string): string {
  const cleaned = input.trim();
  if (!cleaned) throw new Error(`Invalid version/ref: empty input`);
  if (cleaned.startsWith('refs/')) {
    const afterRefs = cleaned.replace(/^refs\/tags\/v?/, '');
    if (!afterRefs) throw new Error(`Invalid version/ref: "${input}"`);
    return cleaned;
  }
  const bare = cleaned.startsWith('v') ? cleaned.slice(1) : cleaned;
  if (!bare) throw new Error(`Invalid version/ref: "${input}"`);
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(bare)) {
    return `refs/tags/v${bare}`;
  }
  return cleaned;
}

function getCliVersion(): string {
  try {
    const path = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(path, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function loadStructuredFile(filePath: string): any {
  const content = readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) return JSON.parse(content);
  return yaml.load(content);
}

async function loadQuadsFromInput(
  opts: ActionOpts,
  defaultGraph: string,
): Promise<Array<{ subject: string; predicate: string; object: string; graph: string }>> {
  const rdfParser = await import('./rdf-parser.js');

  if (opts.file) {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(opts.file, 'utf-8');
    const format = opts.format ?? rdfParser.detectFormat(opts.file);
    const quads = await rdfParser.parseRdf(raw, format, defaultGraph);
    console.log(`Parsed ${quads.length} quad(s) from ${opts.file} (${format})`);
    return quads;
  }

  if (opts.triples) {
    const parsed = JSON.parse(opts.triples);
    return parsed.map((q: Record<string, string>) => ({ ...q, graph: q.graph || defaultGraph }));
  }

  if (opts.subject && opts.predicate && opts.object) {
    return [{
      subject: opts.subject,
      predicate: opts.predicate,
      object: opts.object.startsWith('"') || opts.object.startsWith('http') || opts.object.startsWith('did:')
        ? opts.object
        : `"${opts.object}"`,
      graph: defaultGraph,
    }];
  }

  console.error(`Provide --file (${rdfParser.supportedExtensions().join(', ')}), --triples, or --subject/--predicate/--object`);
  process.exit(1);
}

function resolveDaemonEntryPoint(): string {
  if (process.env.DKG_NO_BLUE_GREEN) return fileURLToPath(import.meta.url);
  const rDir = releasesDir();
  if (existsSync(rDir)) {
    const entry = slotEntryPoint(join(rDir, 'current'));
    if (entry) return entry;
  }
  return fileURLToPath(import.meta.url);
}

async function runDaemonSupervisor(): Promise<void> {
  const maxCrashRestarts = 5;
  let crashRestartCount = 0;

  while (true) {
    const child = spawn(
      process.execPath,
      [...process.execArgv, resolveDaemonEntryPoint(), 'daemon-worker'],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: process.env,
      },
    );

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });

    if (exitCode === DAEMON_EXIT_CODE_RESTART) {
      crashRestartCount = 0;
      await sleep(250);
      continue;
    }

    if (exitCode === 0) return;

    crashRestartCount += 1;
    if (crashRestartCount >= maxCrashRestarts) return;
    await sleep(1000);
  }
}

async function runForegroundSupervisor(): Promise<void> {
  const maxCrashRestarts = 5;
  let crashRestartCount = 0;
  let currentChild: ReturnType<typeof spawn> | null = null;

  let signalled = false;
  const onSignal = (sig: NodeJS.Signals) => {
    signalled = true;
    if (currentChild) currentChild.kill(sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  while (true) {
    if (signalled) process.exit(0);

    currentChild = spawn(
      process.execPath,
      [...process.execArgv, resolveDaemonEntryPoint(), 'daemon-foreground-worker'],
      {
        stdio: 'inherit',
        env: process.env,
      },
    );

    const exitCode = await new Promise<number | null>((resolve) => {
      currentChild!.once('exit', (code) => resolve(code));
      currentChild!.once('error', () => resolve(1));
    });
    currentChild = null;

    if (signalled) process.exit(exitCode ?? 0);

    if (exitCode === DAEMON_EXIT_CODE_RESTART) {
      crashRestartCount = 0;
      await sleep(250);
      if (signalled) process.exit(0);
      continue;
    }

    if (exitCode === 0) process.exit(0);

    crashRestartCount += 1;
    if (crashRestartCount >= maxCrashRestarts) process.exit(exitCode ?? 1);
    await sleep(1000);
    if (signalled) process.exit(0);
  }
}

const program = new Command();
program
  .name('dkg')
  .description('DKG V10 testnet node CLI')
  .version(getCliVersion());

// ─── dkg init ────────────────────────────────────────────────────────

program
  .command('init')
  .description('Interactive setup — set node name and relay')
  .action(async () => {
    await ensureDkgDir();
    const existing = await loadConfig();
    const network = await loadNetworkConfig();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string, def?: string): Promise<string> =>
      new Promise(resolve => {
        const suffix = def ? ` (${def})` : '';
        rl.question(`${q}${suffix}: `, answer => resolve(answer.trim() || def || ''));
      });

    if (network) {
      console.log(`DKG Node Setup — ${network.networkName}\n`);
    } else {
      console.log('DKG Node Setup\n');
    }

    const name = await ask('Node name', existing.name !== 'dkg-node' ? existing.name : undefined);
    const defaultRole = existing.nodeRole ?? network?.defaultNodeRole ?? 'edge';
    const roleAnswer = await ask('Node role (edge / core)', defaultRole);
    const nodeRole = roleAnswer === 'core' ? 'core' as const : 'edge' as const;

    // Pre-fill relay from network config if user hasn't set one.
    // Show the first relay as the default, but only persist to config if the
    // user overrides it — otherwise the daemon will use the full relay list
    // from network/testnet.json, which stays current across updates.
    const networkDefaultRelay = network?.relays?.[0];
    const defaultRelay = existing.relay ?? networkDefaultRelay;
    const relay = nodeRole === 'edge'
      ? await ask('Relay multiaddr', defaultRelay)
      : await ask('Relay multiaddr (optional for core)', defaultRelay);

    const existingContextGraphs = resolveContextGraphs(existing);
    const defaultContextGraphs = existingContextGraphs.length
      ? existingContextGraphs.join(',')
      : resolveNetworkDefaultContextGraphs(network).length
        ? resolveNetworkDefaultContextGraphs(network).join(',')
        : undefined;
    const contextGraphsStr = await ask(
      'Context graphs to subscribe (comma-separated)',
      defaultContextGraphs,
    );
    const contextGraphs = contextGraphsStr ? contextGraphsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const apiPort = parseInt(await ask('API port', String(existing.apiPort)), 10);

    const autoUpdateDefault = existing.autoUpdate?.enabled ?? network?.autoUpdate?.enabled ?? false;
    const enableAutoUpdate = (await ask(
      'Enable git-based auto-update (y/n)',
      autoUpdateDefault ? 'y' : 'n',
    )).toLowerCase() === 'y';

    let autoUpdate = existing.autoUpdate;
    if (enableAutoUpdate) {
      const defaultRepo = existing.autoUpdate?.repo ?? network?.autoUpdate?.repo;
      const defaultBranch = existing.autoUpdate?.branch ?? network?.autoUpdate?.branch ?? 'main';
      const defaultAllowPrerelease = existing.autoUpdate?.allowPrerelease ?? network?.autoUpdate?.allowPrerelease ?? true;
      const defaultSshKeyPath = existing.autoUpdate?.sshKeyPath ?? network?.autoUpdate?.sshKeyPath ?? '';
      const defaultInterval = existing.autoUpdate?.checkIntervalMinutes ?? network?.autoUpdate?.checkIntervalMinutes ?? 5;
      const repo = await ask('Git repo/path (owner/name, URL, or git@host:org/repo.git)', defaultRepo);
      const branch = await ask('Branch', defaultBranch);
      const allowPrerelease = (await ask(
        'Allow pre-release versions? (y/n)',
        defaultAllowPrerelease ? 'y' : 'n',
      )).toLowerCase() === 'y';
      const sshKeyPath = (await ask('SSH private key path (optional; blank uses agent/default SSH config)', defaultSshKeyPath)).trim();
      const interval = parseInt(await ask('Check interval (minutes)', String(defaultInterval)), 10);
      autoUpdate = {
        enabled: true,
        repo,
        branch,
        allowPrerelease,
        sshKeyPath: sshKeyPath || undefined,
        checkIntervalMinutes: interval,
      };
    }

    // Chain configuration
    const defaultRpcUrl = existing.chain?.rpcUrl ?? network?.chain?.rpcUrl;
    const defaultHubAddress = existing.chain?.hubAddress ?? network?.chain?.hubAddress;
    const defaultChainId = existing.chain?.chainId ?? network?.chain?.chainId;

    console.log('\nBlockchain Configuration:');
    const rpcUrl = await ask('RPC URL', defaultRpcUrl);
    const hubAddress = await ask('Hub contract address', defaultHubAddress);
    const chainIdStr = await ask('Chain ID', defaultChainId);

    const chainSection = rpcUrl && hubAddress ? {
      type: 'evm' as const,
      rpcUrl,
      hubAddress,
      chainId: chainIdStr || undefined,
    } : undefined;

    // API authentication
    console.log('\nAPI Authentication:');
    const existingAuthEnabled = existing.auth?.enabled !== false;
    const enableAuth = (await ask(
      'Enable API authentication (y/n)',
      existingAuthEnabled ? 'y' : 'n',
    )).toLowerCase() === 'y';

    rl.close();

    const config = {
      ...existing,
      name: name || 'dkg-node',
      relay: (!existing.relay && relay === networkDefaultRelay) ? undefined : (relay || undefined),
      apiPort,
      nodeRole,
      contextGraphs,
      paranets: contextGraphs,
      autoUpdate: enableAutoUpdate ? autoUpdate : existing.autoUpdate,
      chain: chainSection ?? existing.chain,
      auth: { enabled: enableAuth, tokens: existing.auth?.tokens },
    };
    await saveConfig(config);

    // Generate wallets eagerly so they're available for faucet funding
    let walletAddresses: string[] = [];
    try {
      const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
      const opWallets = await loadOpWallets(dkgDir());
      walletAddresses = opWallets.wallets.map((w: { address: string }) => w.address);
    } catch (err: any) {
      console.warn(`\nWarning: could not generate wallets (${err?.message ?? String(err)}).`);
      console.warn('Wallets will be auto-generated on first "dkg start".');
    }

    console.log(`\nConfig saved to ${configPath()}`);
    console.log(`  name:       ${config.name}`);
    console.log(`  role:       ${config.nodeRole}`);
    const relayDisplay = config.relay
      ?? (network?.relays?.length ? `(network default — ${network.relays.length} relays)` : '(none)');
    console.log(`  relay:      ${relayDisplay}`);
    console.log(`  context graphs: ${contextGraphs.length ? contextGraphs.join(', ') : '(none)'}`);
    console.log(`  apiPort:    ${config.apiPort}`);
    console.log(`  auth:       ${enableAuth ? 'enabled (token in ~/.dkg/auth.token)' : 'disabled'}`);
    console.log(
      `  autoUpdate: ${
        config.autoUpdate?.enabled
          ? `${config.autoUpdate.repo}@${config.autoUpdate.branch}` +
            `${config.autoUpdate.allowPrerelease ? ' (pre-release allowed)' : ''}` +
            `${config.autoUpdate.sshKeyPath ? ` (ssh key: ${config.autoUpdate.sshKeyPath})` : ''}`
          : 'disabled'
      }`,
    );
    console.log(`  chain:      ${config.chain ? `${config.chain.rpcUrl} (hub: ${config.chain.hubAddress?.slice(0, 10)}...)` : '(not configured)'}`);
    if (network) {
      console.log(`  network:    ${network.networkName}`);
    }
    if (walletAddresses.length) {
      console.log(`  wallets:    ${walletAddresses.join(', ')}`);
    }

    // Auto-fund from testnet faucet if available
    if (network?.faucet?.url && walletAddresses.length > 0) {
      if (walletAddresses.length > 3) {
        console.log(`\nNote: faucet supports up to 3 wallets; funding the first 3.`);
      }
      console.log(`\nRequesting testnet tokens from faucet...`);
      try {
        const result = await requestFaucetFunding(
          network.faucet.url, network.faucet.mode, walletAddresses, config.name,
        );
        if (result.success) {
          console.log(`  Funded: ${result.funded.join(', ')}`);
        } else if (result.error) {
          console.log(`  Faucet request failed (${result.error}). Fund manually or retry later.`);
        } else {
          console.log('  Faucet returned no successful transactions (you may already have tokens or hit a cooldown).');
        }
      } catch (err: any) {
        console.log(`  Faucet unavailable: ${err?.message ?? String(err)}. Fund your wallet manually.`);
      }
    }

    console.log(`\nRun "dkg start" to start the node.`);
  });

// ─── dkg auth ─────────────────────────────────────────────────────────

const authCmd = program
  .command('auth')
  .description('Manage API authentication tokens');

authCmd
  .command('show')
  .description('Display the current auth token')
  .action(async () => {
    const { loadTokens } = await import('./auth.js');
    const config = await loadConfig();
    const tokens = await loadTokens(config.auth);
    if (tokens.size === 0) {
      console.log('No auth tokens configured.');
      return;
    }
    for (const t of tokens) console.log(t);
  });

authCmd
  .command('rotate')
  .description('Generate a new auth token (replaces the file-based token)')
  .action(async () => {
    const { randomBytes } = await import('node:crypto');
    const { writeFile, chmod, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const tokenPath = join(dkgDir(), 'auth.token');
    const token = randomBytes(32).toString('base64url');
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, `# DKG node API token — treat this like a password\n${token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    console.log('New token generated:');
    console.log(token);
    console.log(`\nSaved to ${tokenPath}`);
    console.log('Restart the daemon for the new token to take effect.');
  });

authCmd
  .command('status')
  .description('Show whether authentication is enabled')
  .action(async () => {
    const config = await loadConfig();
    const enabled = config.auth?.enabled !== false;
    console.log(`  Authentication: ${enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Token file:     ${join(dkgDir(), 'auth.token')}`);
    if (config.auth?.tokens?.length) {
      console.log(`  Config tokens:  ${config.auth.tokens.length}`);
    }
  });

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
  .action(async (opts: ActionOpts) => {
    if (!configExists()) {
      console.error('No config found. Run "dkg init" first.');
      process.exit(1);
    }

    const pid = await readPid();
    if (pid && isProcessRunning(pid)) {
      console.error(`Daemon already running (PID ${pid}). Use "dkg stop" first.`);
      process.exit(1);
    }

    // Keep blue-green slots initialized for both foreground and daemonized start.
    if (!process.env.DKG_NO_BLUE_GREEN) {
      await migrateToBlueGreen((msg) => console.log(msg), { allowRemoteBootstrap: false });
    }

    if (opts.foreground) {
      await runForegroundSupervisor();
      return;
    }

    // Spawn detached background supervisor via releases/current symlink
    const entryPoint = resolveDaemonEntryPoint();
    const child = spawn(
      process.execPath,
      [...process.execArgv, entryPoint, 'daemon-supervisor'],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: process.env,
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
      console.log(`  GitHub:     ${cyan('https://github.com/OriginTrail/dkg-v9')}`);
      console.log(`  Discord:    ${cyan('https://discord.com/invite/xCaY7hvNwD')}`);
      console.log(`  Logs:       ${logPath()}`);
      console.log('');
      console.log(`  ${yellow('This is an experimental testnet node. Things will break.')}`);
      console.log(`  ${yellow('Not intended for production use.')}`);
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
      const client = await ApiClient.connect();
      const s = await client.status();
      const uptime = formatUptime(s.uptimeMs);
      console.log(`  Node:      ${s.name}`);
      console.log(`  Role:      ${s.nodeRole ?? 'edge'}`);
      console.log(`  Network:   ${s.networkId ?? '—'}`);
      console.log(`  PeerId:    ${s.peerId}`);
      console.log(`  Uptime:    ${uptime}`);
      console.log(`  Peers:     ${s.connectedPeers}`);
      console.log(`  Relay:     ${s.relayConnected ? 'connected' : 'not connected'}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg peers ───────────────────────────────────────────────────────

program
  .command('peers')
  .description('List discovered agents on the network')
  .action(async () => {
    try {
      const client = await ApiClient.connect();
      const { agents } = await client.agents();
      if (agents.length === 0) {
        console.log('No agents discovered yet. Other nodes need to connect and publish profiles.');
        return;
      }

      const status = await client.status();
      console.log(`Network agents (seen by ${status.name}):\n`);

      const nameW = Math.max(6, ...agents.map(a => a.name.length));
      const header = `  ${'Name'.padEnd(nameW)}   ${'PeerId'.padEnd(16)}   ${'Role'.padEnd(5)}   Framework`;
      console.log(header);
      console.log('  ' + '─'.repeat(header.length - 2));

      for (const a of agents) {
        const short = a.peerId.length > 16
          ? a.peerId.slice(0, 8) + '...' + a.peerId.slice(-4)
          : a.peerId;
        const self = a.peerId === status.peerId ? ' (you)' : '';
        const role = a.nodeRole ?? 'edge';
        console.log(`  ${a.name.padEnd(nameW)}   ${short.padEnd(16)}   ${role.padEnd(5)}   ${a.framework ?? '—'}${self}`);
      }
      console.log(`\n  ${agents.length} agent(s) total`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg send <name> <message> ───────────────────────────────────────

program
  .command('send <name> <message>')
  .description('Send an encrypted chat message to a named agent')
  .action(async (name: string, message: string) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.sendChat(name, message);
      if (result.delivered) {
        console.log(`Message delivered to ${name}.`);
      } else {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg chat <name> ─────────────────────────────────────────────────

program
  .command('chat <name>')
  .description('Interactive chat with a named agent')
  .action(async (name: string) => {
    try {
      const client = await ApiClient.connect();
      const status = await client.status();

      // Build a name lookup from discovered agents
      const { agents } = await client.agents();
      const nameMap = new Map<string, string>();
      for (const a of agents) nameMap.set(a.peerId, a.name);

      console.log(`Chat with "${name}" (you are ${status.name}). Ctrl+C to exit.\n`);

      // Show recent history
      const { messages: history } = await client.messages({ peer: name, limit: 20 });
      for (const m of history) {
        printMessage(m, status.name, nameMap);
      }

      // Poll for new messages
      let lastTs = history.length > 0 ? history[history.length - 1].ts : Date.now();
      const pollTimer = setInterval(async () => {
        try {
          const { messages: newMsgs } = await client.messages({ peer: name, since: lastTs });
          for (const m of newMsgs) {
            // Only show incoming (we already see our own sends via the prompt)
            if (m.direction === 'in') printMessage(m, status.name, nameMap);
            lastTs = Math.max(lastTs, m.ts);
          }
        } catch (err) {
          console.warn('Chat poll error:', err instanceof Error ? err.message : err);
        }
      }, 1000);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.setPrompt(`${status.name}> `);
      rl.prompt();

      rl.on('line', async (line) => {
        const text = line.trim();
        if (!text) { rl.prompt(); return; }
        if (text === '/quit') { rl.close(); return; }

        const result = await client.sendChat(name, text);
        if (!result.delivered) {
          console.log(`  [!] ${result.error}`);
        }
        lastTs = Date.now();
        rl.prompt();
      });

      rl.on('close', () => {
        clearInterval(pollTimer);
        console.log('\nChat ended.');
        process.exit(0);
      });
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg publish <context-graph> ─────────────────────────────────────

program
  .command('publish <context-graph>')
  .description('Publish triples to a context graph from an RDF file or inline')
  .option('-f, --file <path>', 'RDF file (.nq, .nt, .ttl, .trig, .jsonld, .json)')
  .option('--private-file <path>', 'RDF file with private triples (encrypted, access-controlled)')
  .option('--format <fmt>', 'Explicit RDF format (nquads|ntriples|turtle|trig|json|jsonld)')
  .option('-t, --triples <json>', 'Inline JSON array of {subject, predicate, object} triples')
  .option('-s, --subject <uri>', 'Subject URI for simple publish')
  .option('-p, --predicate <uri>', 'Predicate URI for simple publish')
  .option('-o, --object <value>', 'Object value for simple publish')
  .option('--access-policy <policy>', 'Access policy for private triples (public|ownerOnly|allowList)')
  .option('--allowed-peer <peerId>', 'Peer ID allowed when using allowList policy', (v, prev: string[] = []) => [...prev, v], [])
  .action(async (contextGraph: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const defaultGraph = `did:dkg:context-graph:${contextGraph}`;
      const quads = await loadQuadsFromInput(opts, defaultGraph);

      let privateQuads: Array<{ subject: string; predicate: string; object: string; graph: string }> | undefined;
      if (opts.privateFile) {
        const rdfParser = await import('./rdf-parser.js');
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(opts.privateFile, 'utf-8');
        const format = opts.format ?? rdfParser.detectFormat(opts.privateFile);
        const parsedPrivateQuads = await rdfParser.parseRdf(raw, format, defaultGraph);
        privateQuads = parsedPrivateQuads;
        console.log(`Parsed ${parsedPrivateQuads.length} private quad(s) from ${opts.privateFile} (${format})`);
      }

      const accessPolicy = opts.accessPolicy as ('public' | 'ownerOnly' | 'allowList' | undefined);
      const allowedPeers = (opts.allowedPeer as string[] | undefined)?.map((p) => p.trim()).filter(Boolean) ?? [];
      if (accessPolicy && !['public', 'ownerOnly', 'allowList'].includes(accessPolicy)) {
        console.error('Invalid --access-policy. Use one of: public, ownerOnly, allowList');
        process.exit(1);
      }
      if (accessPolicy === 'allowList' && allowedPeers.length === 0) {
        console.error('When --access-policy allowList is used, provide at least one --allowed-peer');
        process.exit(1);
      }
      if (accessPolicy !== 'allowList' && allowedPeers.length > 0) {
        console.error('--allowed-peer can only be used with --access-policy allowList');
        process.exit(1);
      }

      const result = await client.publish(contextGraph, quads, privateQuads, {
        accessPolicy,
        allowedPeers,
      });
      console.log(`Published to context graph "${contextGraph}":`);
      console.log(`  Status:    ${result.status}`);
      console.log(`  KC ID:     ${result.kcId}`);
      if (result.txHash) {
        console.log(`  TX hash:   ${result.txHash}`);
        console.log(`  Block:     ${result.blockNumber}`);
        console.log(`  Batch ID:  ${result.batchId}`);
        console.log(`  Publisher: ${result.publisherAddress}`);
      }
      for (const ka of result.kas) {
        console.log(`  KA: ${ka.rootEntity} (token ${ka.tokenId})`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg verify <batchId> ──────────────────────────────────────────

program
  .command('verify <batchId>')
  .description('Propose M-of-N verification for a published batch')
  .requiredOption('--context-graph <id>', 'Context Graph ID')
  .requiredOption('--verified-graph <id>', 'Verified Graph ID')
  .option('--timeout <ms>', 'Timeout in milliseconds (default: 30 min)')
  .option('--required-signatures <n>', 'M-of-N quorum threshold (default: on-chain config, or 1 if adapter lacks getContextGraphConfig)')
  .action(async (batchId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.verify({
        contextGraphId: opts.contextGraph,
        verifiedMemoryId: opts.verifiedGraph,
        batchId,
        timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
        requiredSignatures: opts.requiredSignatures ? Number(opts.requiredSignatures) : undefined,
      });
      console.log(`Verified batch ${batchId} → _verified_memory/${result.verifiedMemoryId}`);
      console.log(`  TX: ${result.txHash}`);
      console.log(`  Block: ${result.blockNumber}`);
      console.log(`  Signers: ${result.signers.join(', ')}`);
    } catch (err) {
      console.error(`Verify failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── dkg endorse <ual> ─────────────────────────────────────────────

program
  .command('endorse <ual>')
  .description('Endorse a published Knowledge Asset')
  .requiredOption('--context-graph <id>', 'Context Graph ID')
  .requiredOption('--agent <address>', 'Agent address (endorser)')
  .action(async (ual: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.endorse({
        contextGraphId: opts.contextGraph,
        ual,
        agentAddress: opts.agent,
      });
      console.log(`Endorsed ${ual} by ${result.endorserAddress}`);
    } catch (err) {
      console.error(`Endorse failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── dkg query <context-graph> <sparql> ─────────────────────────────

program
  .command('query [context-graph]')
  .description('Run a SPARQL query against a context graph (or all)')
  .option('-q, --sparql <query>', 'SPARQL query string')
  .option('-f, --file <path>', 'File containing SPARQL query')
  .action(async (contextGraph: string | undefined, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();

      let sparql = opts.sparql;
      if (!sparql && opts.file) {
        const { readFile } = await import('node:fs/promises');
        sparql = await readFile(opts.file, 'utf-8');
      }
      if (!sparql) {
        console.error('Provide --sparql or --file');
        process.exit(1);
      }

      const { result } = await client.query(sparql, contextGraph);

      if (result?.type === 'bindings' && result.bindings) {
        const { bindings } = result;
        if (bindings.length === 0) {
          console.log('No results.');
          return;
        }
        const keys = Object.keys(bindings[0]);
        const widths = keys.map(k => Math.max(k.length, ...bindings.map(
          (row) => stripQuotes(String(row[k] ?? '')).length,
        )));

        const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
        console.log(header);
        console.log(widths.map((w: number) => '─'.repeat(w)).join('  '));
        for (const row of bindings) {
          const line = keys.map((k, i) => stripQuotes(String(row[k] ?? '')).padEnd(widths[i])).join('  ');
          console.log(line);
        }
        console.log(`\n${bindings.length} row(s)`);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg query-remote <peer> ───────────────────────────────────────

program
  .command('query-remote <peer>')
  .description('Query a remote peer\'s knowledge store')
  .option('-q, --sparql <query>', 'SPARQL query (requires --context-graph)')
  .option('--ual <ual>', 'Look up a knowledge asset by UAL')
  .option('--entity <uri>', 'Get all triples for an entity URI (requires --context-graph)')
  .option('--type <rdfType>', 'Find entities by RDF type (requires --context-graph)')
  .option('-p, --context-graph <id>', 'Target context graph')
  .option('--paranet <id>', 'Target context graph (legacy alias)')
  .option('-l, --limit <n>', 'Max results', '100')
  .option('--timeout <ms>', 'Query timeout in ms', '5000')
  .action(async (peer: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const contextGraphId = opts.contextGraph ?? opts.paranet;

      let lookupType: string;
      const request: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
        paranetId: contextGraphId,
        limit: parseInt(opts.limit, 10),
        timeout: parseInt(opts.timeout, 10),
      };

      if (opts.ual) {
        lookupType = 'ENTITY_BY_UAL';
        request.ual = opts.ual;
      } else if (opts.type) {
        lookupType = 'ENTITIES_BY_TYPE';
        request.rdfType = opts.type;
        if (!contextGraphId) {
          console.error('--context-graph is required for --type queries');
          process.exit(1);
        }
      } else if (opts.entity) {
        lookupType = 'ENTITY_TRIPLES';
        request.entityUri = opts.entity;
        if (!contextGraphId) {
          console.error('--context-graph is required for --entity queries');
          process.exit(1);
        }
      } else if (opts.sparql) {
        lookupType = 'SPARQL_QUERY';
        request.sparql = opts.sparql;
        if (!contextGraphId) {
          console.error('--context-graph is required for --sparql queries');
          process.exit(1);
        }
      } else {
        console.error('Provide one of: --ual, --type, --entity, or --sparql');
        process.exit(1);
      }

      const response = await client.queryRemote(peer, { lookupType, ...request });

      if (response.status !== 'OK') {
        console.error(`Query failed: ${response.status}`);
        if (response.error) console.error(`  ${response.error}`);
        process.exit(1);
      }

      // Display results based on lookup type
      if (response.ntriples !== undefined) {
        if (response.ntriples) {
          console.log(response.ntriples);
        } else {
          console.log('No results.');
        }
      } else if (response.entityUris?.length) {
        for (const uri of response.entityUris) {
          console.log(uri);
        }
      } else if (response.bindings) {
        try {
          const bindings = JSON.parse(response.bindings);
          if (bindings.length === 0) {
            console.log('No results.');
          } else {
            const keys = Object.keys(bindings[0]);
            const rows = bindings as Array<Record<string, string>>;
            const widths = keys.map(k => Math.max(k.length, ...rows.map(
              (row) => stripQuotes(String(row[k] ?? '')).length,
            )));
            const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
            console.log(header);
            console.log(widths.map((w: number) => '─'.repeat(w)).join('  '));
            for (const row of rows) {
              const line = keys.map((k, i) => stripQuotes(String(row[k] ?? '')).padEnd(widths[i])).join('  ');
              console.log(line);
            }
            console.log(`\n${bindings.length} row(s)`);
          }
        } catch {
          console.log(response.bindings);
        }
      } else {
        console.log('No results.');
      }

      if (response.truncated) {
        console.log(`\n(results truncated — ${response.resultCount} total)`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg subscribe <context-graph> ──────────────────────────────────

program
  .command('subscribe <context-graph>')
  .description('Subscribe to a context graph\'s GossipSub topic')
  .option('--save', 'Also save to config so it auto-subscribes on restart')
  .action(async (contextGraph: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.subscribeToContextGraph(contextGraph);
      console.log(`Subscribed to context graph: ${contextGraph}`);
      const catchup = result.catchup;
      if (catchup) {
        if ('peersTried' in catchup) {
          console.log(
            `Catch-up sync: peers ${catchup.peersTried}/${catchup.syncCapablePeers} (connected ${catchup.connectedPeers}), data ${catchup.dataSynced}, shared memory ${catchup.workspaceSynced}`,
          );
        } else {
          console.log(
            `Catch-up sync queued in background (job ${catchup.jobId}, shared memory ${catchup.includeWorkspace ? 'enabled' : 'disabled'}).`,
          );
        }
      }

      if (opts.save) {
        const config = await loadConfig();
        const cgs = new Set(resolveContextGraphs(config));
        cgs.add(contextGraph);
        config.contextGraphs = [...cgs];
        config.paranets = [...cgs];
        await saveConfig(config);
        console.log('Saved to config (will auto-subscribe on restart).');
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg sync ─────────────────────────────────────────────────────────

const syncCmd = program
  .command('sync')
  .description('Sync status helpers');

syncCmd
  .command('catchup-status <context-graph>')
  .description('Show latest background catch-up status for a context graph')
  .action(async (contextGraph: string) => {
    try {
      const client = await ApiClient.connect();
      const status = await client.catchupStatus(contextGraph);

      console.log(`Context Graph: ${status.paranetId}`);
      console.log(`Job:           ${status.jobId}`);
      console.log(`Status:        ${status.status}`);
      console.log(`Shared Memory: ${status.includeWorkspace ? 'enabled' : 'disabled'}`);
      console.log(`Queued:        ${new Date(status.queuedAt).toISOString()}`);
      if (status.startedAt) console.log(`Started:       ${new Date(status.startedAt).toISOString()}`);
      if (status.finishedAt) console.log(`Finished:      ${new Date(status.finishedAt).toISOString()}`);
      if (status.result) {
        console.log(
          `Result:        peers ${status.result.peersTried}/${status.result.syncCapablePeers} (connected ${status.result.connectedPeers}), data ${status.result.dataSynced}, shared memory ${status.result.workspaceSynced}`,
        );
      }
      if (status.error) {
        console.log(`Error:         ${status.error}`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg context-graph (alias: paranet) ─────────────────────────────

const contextGraphCmd = program
  .command('context-graph')
  .alias('paranet')
  .description('Manage context graphs (knowledge graph partitions)');

contextGraphCmd
  .command('create <id>')
  .description('Create a new context graph (publishes definition to the system ontology)')
  .option('-n, --name <name>', 'Human-readable name (defaults to id)')
  .option('-d, --description <desc>', 'Description of the context graph')
  .option('--subscribe', 'Also subscribe to the context graph after creation', true)
  .option('--save', 'Persist subscription to config')
  .action(async (id: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.createContextGraph(id, opts.name ?? id, opts.description);
      console.log(`Context graph created:`);
      console.log(`  ID:   ${result.created}`);
      console.log(`  URI:  ${result.uri}`);
      console.log(`  Auto-subscribed to GossipSub topic.`);

      if (opts.save) {
        const config = await loadConfig();
        const cgs = new Set(resolveContextGraphs(config));
        cgs.add(id);
        config.contextGraphs = [...cgs];
        config.paranets = [...cgs];
        await saveConfig(config);
        console.log('  Saved to config (will auto-subscribe on restart).');
      }
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
      const { paranets: contextGraphs } = await client.listContextGraphs();

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
      const { paranets: contextGraphs } = await client.listContextGraphs();
      const p = contextGraphs.find(x => x.id === id);
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

// ─── dkg openclaw ───────────────────────────────────────────────────

const openclawCmd = program
  .command('openclaw')
  .description('OpenClaw adapter management');

openclawCmd
  .command('setup')
  .description('Set up the DKG OpenClaw adapter (runs npx setup script)')
  .allowUnknownOption(true)
  .action(async () => {
    const { execFileSync } = await import('node:child_process');
    // Forward args after "openclaw setup" to the adapter setup script.
    const oclawIdx = process.argv.indexOf('openclaw');
    const setupIdx = oclawIdx >= 0 ? process.argv.indexOf('setup', oclawIdx + 1) : -1;
    const extraArgs = setupIdx >= 0 ? process.argv.slice(setupIdx + 1) : [];
    try {
      // This is a thin convenience wrapper — the primary entry point is:
      //   npx @origintrail-official/dkg-adapter-openclaw setup
      // The adapter's own setup script warns if running from an ephemeral
      // npx cache and advises users to install globally.
      execFileSync('npx', ['--yes', '@origintrail-official/dkg-adapter-openclaw', 'setup', ...extraArgs], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
    } catch (err: any) {
      if (err.status) {
        process.exit(err.status);
      }
      console.error('\nTo set up the OpenClaw adapter, run:');
      console.error('  npx @origintrail-official/dkg-adapter-openclaw setup\n');
      process.exit(1);
    }
  });

// ─── dkg ccl ────────────────────────────────────────────────────────

const cclCmd = program
  .command('ccl')
  .description('Manage paranet-scoped CCL policies');

const cclPolicyCmd = cclCmd
  .command('policy')
  .description('Publish, approve, revoke, list, and resolve CCL policies');

cclPolicyCmd
  .command('publish <paranetId>')
  .description('Publish a CCL policy proposal into the ontology graph')
  .requiredOption('--name <name>', 'Policy name')
  .requiredOption('--version <version>', 'Policy version')
  .requiredOption('--file <path>', 'Path to canonical policy file')
  .option('--description <desc>', 'Description of the policy')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .option('--language <language>', 'Policy language identifier', 'ccl/v0.1')
  .option('--format <format>', 'Canonical policy format', 'canonical-yaml')
  .action(async (paranetId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const content = readFileSync(opts.file, 'utf8');
      const result = await client.publishCclPolicy({
        paranetId,
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
  .command('approve <paranetId> <policyUri>')
  .description('Approve a published CCL policy for a paranet or context override')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .action(async (paranetId: string, policyUri: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.approveCclPolicy({ paranetId, policyUri, contextType: opts.contextType });
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
  .command('revoke <paranetId> <policyUri>')
  .description('Revoke the currently active CCL policy binding for a paranet or context override')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .action(async (paranetId: string, policyUri: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.revokeCclPolicy({ paranetId, policyUri, contextType: opts.contextType });
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
  .option('--paranet <id>', 'Filter by paranet id')
  .option('--name <name>', 'Filter by policy name')
  .option('--context-type <contextType>', 'Filter by context type')
  .option('--status <status>', 'Filter by status')
  .option('--include-body', 'Include policy body in output')
  .action(async (opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const { policies } = await client.listCclPolicies({
        paranetId: opts.paranet,
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
        console.log(`  Paranet: ${policy.paranetId}`);
        console.log(`  Status:  ${policy.status}${policy.isActiveDefault ? ' (active default)' : ''}`);
        if (policy.contextType) console.log(`  Context: ${policy.contextType}`);
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
  .command('resolve <paranetId>')
  .description('Resolve the active approved policy for a paranet and policy name')
  .requiredOption('--name <name>', 'Policy name')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .option('--include-body', 'Include policy body in output')
  .action(async (paranetId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const { policy } = await client.resolveCclPolicy({
        paranetId,
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
      console.log(`  Paranet: ${policy.paranetId}`);
      console.log(`  Hash:    ${policy.hash}`);
      if (policy.contextType) console.log(`  Context: ${policy.contextType}`);
      if (policy.body) console.log(`  Body:\n${policy.body}`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

cclCmd
  .command('eval <paranetId>')
  .description('Resolve the approved CCL policy for a paranet and evaluate it against facts')
  .requiredOption('--name <name>', 'Policy name')
  .option('--context-type <contextType>', 'Optional stricter context override scope')
  .option('--case <path>', 'YAML/JSON file with { facts, context? }')
  .option('--facts-file <path>', 'YAML/JSON file containing facts array')
  .option('--publish-result', 'Publish the evaluation output back into the paranet as typed records')
  .option('--view <view>', 'Declared view, for example accepted')
  .option('--snapshot-id <snapshotId>', 'Snapshot identifier')
  .option('--scope-ual <scopeUal>', 'Scope UAL for evaluation')
  .action(async (paranetId: string, opts: ActionOpts) => {
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
        paranetId,
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
  .command('results <paranetId>')
  .description('List published CCL evaluation results in a paranet')
  .option('--policy-uri <policyUri>', 'Filter by evaluated policy URI')
  .option('--snapshot-id <snapshotId>', 'Filter by snapshot id')
  .option('--view <view>', 'Filter by view')
  .option('--context-type <contextType>', 'Filter by context type')
  .option('--result-kind <kind>', 'Filter by result kind: derived or decision')
  .option('--result-name <name>', 'Filter by result predicate/decision name')
  .action(async (paranetId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const { evaluations } = await client.listCclEvaluations({
        paranetId,
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

// ─── dkg index ──────────────────────────────────────────────────────

program
  .command('index [directory]')
  .description('Index a repository and write to shared memory or publish directly')
  .option('-p, --context-graph <id>', 'Target context graph', 'dev-coordination')
  .option('--paranet <id>', 'Target context graph (legacy alias)')
  .option('--shared-memory', 'Write indexed quads to shared memory instead of publishing')
  .option('--workspace', 'Write indexed quads to shared memory instead of publishing (legacy alias)')
  .option('--include-content', 'Index docs/content files in addition to source code')
  .option('--dry-run', 'Print statistics without publishing')
  .option('--output <file>', 'Write quads to a JSON file instead of publishing')
  .action(async (directory: string | undefined, opts: ActionOpts) => {
    try {
      const { resolve } = await import('node:path');
      const repoRoot = resolve(directory ?? '.');
      const targetContextGraph = opts.contextGraph ?? opts.paranet ?? 'dev-coordination';
      const useSharedMemory = opts.sharedMemory || opts.workspace;

      console.log(`Indexing ${repoRoot}...`);
      const { indexRepository } = await import('./indexer.js');
      const result = await indexRepository(repoRoot, {
        includeContent: Boolean(opts.includeContent),
      });

      console.log(`\n  Packages:  ${result.packageCount}`);
      console.log(`  Modules:   ${result.moduleCount}`);
      console.log(`  Functions: ${result.functionCount}`);
      console.log(`  Classes:   ${result.classCount}`);
      console.log(`  Contracts: ${result.contractCount}`);
      console.log(`  Quads:     ${result.quads.length}`);

      if (opts.output) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(opts.output, JSON.stringify(result.quads, null, 2));
        console.log(`\nWritten to ${opts.output}`);
        return;
      }

      if (opts.dryRun) {
        console.log('\n  (dry run — not publishing)');
        return;
      }

      const client = await ApiClient.connect();
      const verb = useSharedMemory ? 'Writing to shared memory' : 'Publishing';
      const applyBatch = useSharedMemory
        ? async (batch: typeof result.quads) => client.sharedMemoryWrite(targetContextGraph, batch)
        : async (batch: typeof result.quads) => client.publish(targetContextGraph, batch);

      await publishEntityBatches(result.quads, applyBatch, (sent) => {
        process.stdout.write(`\r  ${verb}: ${sent}/${result.quads.length} quads`);
      }, {
        maxBatchBytes: useSharedMemory ? 240 * 1024 : undefined,
        estimateBatchBytes: useSharedMemory
          ? (batch) => new TextEncoder().encode(JSON.stringify({ contextGraphId: targetContextGraph, quads: batch })).length
          : undefined,
      });

      if (useSharedMemory) {
        console.log(`\n\n  Written ${result.quads.length} quads to shared memory for context graph "${targetContextGraph}".`);
        console.log('  Next: dkg shared-memory publish ' + targetContextGraph);
      } else {
        console.log(`\n\n  Published ${result.quads.length} quads to context graph "${targetContextGraph}".`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg shared-memory (alias: workspace) ───────────────────────────

const sharedMemoryCmd = program
  .command('shared-memory')
  .alias('workspace')
  .description('Shared memory operations (write-first workflow)');

sharedMemoryCmd
  .command('write [context-graph]')
  .description('Write triples to shared memory from an RDF file or inline')
  .option('-f, --file <path>', 'RDF file (.nq, .nt, .ttl, .trig, .jsonld, .json)')
  .option('--format <fmt>', 'Explicit RDF format (nquads|ntriples|turtle|trig|json|jsonld)')
  .option('-t, --triples <json>', 'Inline JSON array of {subject, predicate, object} triples')
  .option('-s, --subject <uri>', 'Subject URI for simple write')
  .option('-p, --predicate <uri>', 'Predicate URI for simple write')
  .option('-o, --object <value>', 'Object value for simple write')
  .action(async (contextGraph: string | undefined, opts: ActionOpts) => {
    try {
      const targetContextGraph = contextGraph ?? 'dev-coordination';
      const client = await ApiClient.connect();
      const defaultGraph = `did:dkg:context-graph:${targetContextGraph}`;
      const quads = await loadQuadsFromInput(opts, defaultGraph);
      const results: Array<Awaited<ReturnType<typeof client.sharedMemoryWrite>>> = [];
      await publishEntityBatches(
        quads,
        async (batch) => {
          const result = await client.sharedMemoryWrite(targetContextGraph, batch);
          results.push(result);
          return result;
        },
        (sent) => {
          process.stdout.write(`\r  Writing to shared memory: ${sent}/${quads.length} quads`);
        },
        {
          maxBatchBytes: 240 * 1024,
          estimateBatchBytes: (batch) => new TextEncoder().encode(JSON.stringify({ contextGraphId: targetContextGraph, quads: batch })).length,
        },
      );
      const firstResult = results[0];
      const lastResult = results[results.length - 1];
      console.log();
      console.log(`Written to shared memory for "${targetContextGraph}":`);
      if (results.length === 1) {
        console.log(`  Share operation: ${firstResult.workspaceOperationId}`);
      } else {
        console.log(`  Batches:         ${results.length}`);
        console.log(`  First share op:  ${firstResult.workspaceOperationId}`);
        console.log(`  Last share op:   ${lastResult.workspaceOperationId}`);
      }
      console.log(`  Triples written: ${results.reduce((sum, result) => sum + result.triplesWritten, 0)}`);
      console.log(`  Graph:           ${firstResult.graph}`);
      const totalSkolemized = results.reduce((sum, result) => sum + (result.skolemizedBlankNodes ?? 0), 0);
      if (totalSkolemized > 0) {
        console.log(`  Skolemized BNs:  ${totalSkolemized}`);
      }
      console.log(`  Next:            dkg shared-memory publish ${targetContextGraph}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

sharedMemoryCmd
  .command('publish [context-graph]')
  .description('Publish from shared memory to a context graph')
  .option('--keep', 'Keep shared memory triples after publishing')
  .option('--root <entity...>', 'Publish only specific root entities')
  .action(async (contextGraph: string | undefined, opts: ActionOpts) => {
    try {
      const targetContextGraph = contextGraph ?? 'dev-coordination';
      const client = await ApiClient.connect();
      const selection = opts.root?.length
        ? { rootEntities: opts.root as string[] }
        : 'all';
      const result = await client.publishFromSharedMemory(targetContextGraph, selection, !opts.keep);
      console.log(`Published from shared memory to "${targetContextGraph}":`);
      console.log(`  Status: ${result.status}`);
      console.log(`  KC ID:  ${result.kcId}`);
      console.log(`  KAs:    ${result.kas.length}`);
      if (result.txHash) {
        console.log(`  TX:     ${result.txHash}`);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg publisher ────────────────────────────────────────────────────

const publisherCmd = program
  .command('publisher')
  .description('Async publisher job inspection and control');

const publisherWalletCmd = publisherCmd
  .command('wallet')
  .description('Manage async publisher wallets');

publisherWalletCmd
  .command('add <private-key>')
  .description('Add a publisher wallet private key')
  .action(async (privateKey: string) => {
    try {
      const { addPublisherWallet, publisherWalletsPath } = await import('./publisher-wallets.js');
      const result = await addPublisherWallet(dkgDir(), privateKey);
      console.log('Publisher wallet added.');
      console.log(`  File:    ${publisherWalletsPath(dkgDir())}`);
      console.log(`  Wallets: ${result.wallets.length}`);
      console.log(`  Address: ${result.wallets[result.wallets.length - 1]?.address}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherWalletCmd
  .command('list')
  .description('List configured publisher wallets')
  .action(async () => {
    try {
      const { loadPublisherWallets, publisherWalletsPath } = await import('./publisher-wallets.js');
      const result = await loadPublisherWallets(dkgDir());
      console.log(`File: ${publisherWalletsPath(dkgDir())}`);
      if (result.wallets.length === 0) {
        console.log('No publisher wallets configured.');
        return;
      }
      for (const wallet of result.wallets) {
        console.log(wallet.address);
      }
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherWalletCmd
  .command('remove <address>')
  .description('Remove a publisher wallet by address')
  .action(async (address: string) => {
    try {
      const { removePublisherWallet, publisherWalletsPath } = await import('./publisher-wallets.js');
      const result = await removePublisherWallet(dkgDir(), address);
      console.log('Publisher wallet removed.');
      console.log(`  File:    ${publisherWalletsPath(dkgDir())}`);
      console.log(`  Wallets: ${result.wallets.length}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('enable')
  .description('Enable async publisher runtime')
  .option('--poll-interval <ms>', 'Poll interval in milliseconds', '12000')
  .option('--error-backoff <ms>', 'Error backoff in milliseconds', '5000')
  .action(async (opts: ActionOpts) => {
    try {
      const config = await loadConfig();
      config.publisher = {
        enabled: true,
        pollIntervalMs: parsePositiveMsOption(String(opts.pollInterval ?? '12000'), '--poll-interval'),
        errorBackoffMs: parsePositiveMsOption(String(opts.errorBackoff ?? '5000'), '--error-backoff'),
      };
      await saveConfig(config);
      console.log('Async publisher enabled');
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('disable')
  .description('Disable async publisher runtime')
  .action(async () => {
    try {
      const config = await loadConfig();
      config.publisher = { ...(config.publisher ?? {}), enabled: false };
      await saveConfig(config);
      console.log('Async publisher disabled');
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('enqueue <context-graph>')
  .description('Enqueue an async lift/publish job from shared memory')
  .requiredOption('--root <entity...>', 'Root entities to include in the lift request')
  .requiredOption('--namespace <value>', 'Namespace for the lifted publish')
  .requiredOption('--scope <value>', 'Scope for the lifted publish')
  .requiredOption('--authority-proof-ref <value>', 'Authority proof reference')
  .option('--swm-id <value>', 'Shared memory id', 'swm-main')
  .option('--workspace-id <value>', 'Legacy alias for --swm-id')
  .option('--share-operation-id <value>', 'Share operation id')
  .option('--workspace-operation-id <value>', 'Legacy alias for --share-operation-id')
  .option('--transition-type <value>', 'Transition type (CREATE|MUTATE|REVOKE)', 'CREATE')
  .option('--authority-type <value>', 'Authority type (owner|multisig|quorum|capability)', 'owner')
  .option('--prior-version <value>', 'Prior version reference for MUTATE/REVOKE flows')
  .action(async (contextGraph: string, opts: ActionOpts) => {
    try {
      const shareOperationId = opts.shareOperationId ?? opts.workspaceOperationId;
      if (!shareOperationId) {
        console.error('Provide --share-operation-id (or legacy --workspace-operation-id).');
        process.exit(1);
      }
      const roots = (opts.root as string[] | undefined)?.map((v) => v.trim()).filter(Boolean) ?? [];
      if (roots.length === 0) {
        console.error('Provide at least one --root.');
        process.exit(1);
      }
      const transitionType = String(opts.transitionType ?? 'CREATE').toUpperCase();
      if (!['CREATE', 'MUTATE', 'REVOKE'].includes(transitionType)) {
        console.error('Invalid --transition-type. Use CREATE, MUTATE, or REVOKE.');
        process.exit(1);
      }
      const authorityType = String(opts.authorityType ?? 'owner');
      if (!['owner', 'multisig', 'quorum', 'capability'].includes(authorityType)) {
        console.error('Invalid --authority-type. Use owner, multisig, quorum, or capability.');
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const result = await client.publisherEnqueue({
        swmId: opts.swmId ?? opts.workspaceId ?? 'swm-main',
        shareOperationId,
        roots,
        contextGraphId: contextGraph,
        namespace: String(opts.namespace),
        scope: String(opts.scope),
        transitionType: transitionType as 'CREATE' | 'MUTATE' | 'REVOKE',
        authorityType: authorityType as 'owner' | 'multisig' | 'quorum' | 'capability',
        authorityProofRef: String(opts.authorityProofRef),
        priorVersion: opts.priorVersion ? String(opts.priorVersion) : undefined,
      });

      console.log('Async publisher job enqueued:');
      console.log(`  Job ID:     ${result.jobId}`);
      console.log(`  Context:    ${contextGraph}`);
      console.log(`  Share op:   ${shareOperationId}`);
      console.log(`  Roots:      ${roots.length}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('jobs')
  .description('List async publisher jobs')
  .option('--status <value>', 'Filter by status')
  .action(async (opts: ActionOpts) => {
    try {
      const status = opts.status ? String(opts.status) : undefined;
      if (status && !['accepted', 'claimed', 'validated', 'broadcast', 'included', 'finalized', 'failed'].includes(status)) {
        console.error(`Invalid publisher job status: ${status}`);
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const { jobs } = await client.publisherJobs(status);
      console.log(JSON.stringify(jobs.map(formatPublisherJobOutput), null, 2));
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('job <job-id>')
  .description('Show async publisher job details')
  .option('--payload', 'Include prepared payload details')
  .action(async (jobId: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      if (opts.payload) {
        const { job, payload } = await client.publisherJobPayload(jobId);
        console.log(JSON.stringify(formatPublisherJobOutput({ ...job, payload }), null, 2));
        return;
      }
      const { job } = await client.publisherJob(jobId);
      console.log(JSON.stringify(formatPublisherJobOutput(job), null, 2));
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('stats')
  .description('Show async publisher job counts by status')
  .action(async () => {
    try {
      const client = await ApiClient.connect();
      const { stats } = await client.publisherStats();
      console.log(JSON.stringify(stats, null, 2));
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('cancel <job-id>')
  .description('Cancel an async publisher job')
  .action(async (jobId: string) => {
    try {
      const client = await ApiClient.connect();
      await client.publisherCancel(jobId);
      console.log(`Cancelled publisher job: ${jobId}`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('retry')
  .description('Retry failed async publisher jobs')
  .option('--status <value>', 'Retry filter (currently only "failed" is supported)', 'failed')
  .action(async (opts: ActionOpts) => {
    try {
      const status = String(opts.status ?? 'failed');
      if (status !== 'failed') {
        console.error(`Invalid retry status: ${status}. Only "failed" is supported.`);
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const { retried } = await client.publisherRetry('failed');
      console.log(`Retried ${retried} publisher job(s).`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

publisherCmd
  .command('clear <status>')
  .description('Clear terminal async publisher jobs by status')
  .action(async (status: string) => {
    try {
      if (status !== 'finalized' && status !== 'failed') {
        console.error(`Invalid clear status: ${status}. Use "finalized" or "failed".`);
        process.exit(1);
      }
      const client = await ApiClient.connect();
      const { cleared } = await client.publisherClear(status);
      console.log(`Cleared ${cleared} publisher job(s) with status ${status}.`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

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
  .description('Show operational wallet addresses and balances')
  .action(async () => {
    try {
      const config = await loadConfig();
      const network = await loadNetworkConfig();
      const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
      const opWallets = await loadOpWallets(dkgDir());

      if (!opWallets.wallets.length) {
        console.error('No operational wallets found. Run "dkg start" to auto-generate them.');
        process.exit(1);
      }

      const rpcUrl = config.chain?.rpcUrl ?? network?.chain?.rpcUrl;
      const hubAddress = config.chain?.hubAddress ?? network?.chain?.hubAddress;
      const chainId = config.chain?.chainId ?? network?.chain?.chainId ?? '(unknown)';

      let provider: ethers.JsonRpcProvider | null = null;
      let token: ethers.Contract | null = null;
      let tokenSymbol = 'TRAC';

      if (rpcUrl) {
        try {
          provider = new ethers.JsonRpcProvider(rpcUrl);
          if (hubAddress) {
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
      console.log(`  File:  ~/.dkg/wallets.json`);
      console.log('\nFund these addresses with ETH (gas) and TRAC (staking/publishing).');
      console.log('The primary wallet is used for identity registration. All wallets are used for publishing.\n');
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
      const network = await loadNetworkConfig();
      const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
      const opWallets = await loadOpWallets(dkgDir());

      if (!opWallets.wallets.length) {
        console.error('No operational wallets found. Run "dkg start" to auto-generate them.');
        process.exit(1);
      }

      const rpcUrl = config.chain?.rpcUrl ?? network?.chain?.rpcUrl;
      const hubAddress = config.chain?.hubAddress ?? network?.chain?.hubAddress;
      if (!rpcUrl || !hubAddress) {
        console.error('Chain not configured. Run "dkg init" and set RPC URL + Hub address.');
        process.exit(1);
      }

      const askWei = ethers.parseEther(amount);
      if (askWei === 0n) {
        console.error('Ask must be > 0.');
        process.exit(1);
      }

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(opWallets.wallets[0].privateKey, provider);

      const hub = new ethers.Contract(hubAddress, [
        'function getContractAddress(string) view returns (address)',
      ], provider);

      const identityStorageAddr = await hub.getContractAddress('IdentityStorage');
      const identityStorage = new ethers.Contract(identityStorageAddr, [
        'function getIdentityId(address) view returns (uint72)',
      ], provider);

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
      ], provider);
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
      const tx = await profile.updateAsk(identityId, askWei);
      console.log(`  TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt!.blockNumber}`);
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

function printMessage(
  m: { ts: number; direction: string; peer: string; text: string },
  selfName: string,
  nameMap?: Map<string, string>,
) {
  const time = new Date(m.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const who = m.direction === 'in'
    ? (nameMap?.get(m.peer) ?? shortId(m.peer))
    : selfName;
  console.log(`  [${time}] ${who}: ${m.text}`);
}

function shortId(peerId: string): string {
  if (peerId.length > 16) return peerId.slice(0, 8) + '...' + peerId.slice(-4);
  return peerId;
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

async function publishEntityBatches(
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
  applyBatch: (batch: Array<{ subject: string; predicate: string; object: string; graph: string }>) => Promise<unknown>,
  onProgress?: (publishedQuadCount: number) => void,
  options: {
    maxBatchBytes?: number;
    estimateBatchBytes?: (batch: Array<{ subject: string; predicate: string; object: string; graph: string }>) => number;
    splitOversizedEntities?: boolean;
  } = {},
): Promise<void> {
  let sent = 0;
  const batches = batchEntityQuads(quads, {
    maxBatchQuads: 500,
    maxBatchBytes: options.maxBatchBytes,
    estimateBatchBytes: options.estimateBatchBytes,
    splitOversizedEntities: options.splitOversizedEntities,
  });

  for (const batch of batches) {
    await applyBatch(batch);
    sent += batch.length;
    onProgress?.(sent);
  }
}

function formatPublisherJobOutput<T>(value: T): T {
  return formatPublisherJobValue(value) as T;
}

function formatPublisherJobValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => formatPublisherJobValue(item));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = formatPublisherJobValue(entryValue, entryKey);
    }
    return result;
  }
  if (typeof value === 'number' && key && /At$/.test(key)) {
    return new Date(value).toISOString();
  }
  return value;
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Returns true if daemon was stopped (or not running). False if it couldn't be stopped. */
async function stopDaemonIfRunning(): Promise<boolean> {
  const pid = await readPid();
  if (!pid || !isProcessRunning(pid)) return true;
  console.log('Stopping daemon...');
  try { process.kill(pid, 'SIGTERM'); } catch (err) {
    if (!hasErrorCode(err, 'ESRCH')) throw err;
  }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!isProcessRunning(pid)) return true;
  }
  console.error('Daemon is still running after SIGTERM. Stop it manually before restarting.');
  return false;
}

// ─── dkg update ──────────────────────────────────────────────────────

program
  .command('update [versionOrRef]')
  .description('Check for and apply DKG node updates (blue-green swap)')
  .option('--check', 'Only check for updates, do not apply')
  .option('--allow-prerelease', 'Allow pre-release target versions')
  .option('--no-verify-tag', 'Skip signed-tag verification for version/tag updates')
  .action(async (versionOrRef: string | undefined, opts: ActionOpts) => {
    const config = await loadConfig();
    const net = await loadNetworkConfig();
    const au = config.autoUpdate ?? net?.autoUpdate ?? {
      enabled: true,
      repo: 'OriginTrail/dkg-v9',
      branch: 'main',
      allowPrerelease: true,
      checkIntervalMinutes: 30,
    };
    const standalone = isStandaloneInstall();
    const allowPre = opts.allowPrerelease === true ? true : (au.allowPrerelease ?? true);

    if (standalone) {
      const logFn = (msg: string) => console.log(msg);

      if (opts.check) {
        console.log('Checking NPM registry for updates...');
        const check = await checkForNpmVersionUpdate(logFn, allowPre);
        if (check.status === 'available' && check.version) {
          console.log(`Update available: ${check.version}`);
        } else if (check.status === 'up-to-date') {
          console.log('No updates available.');
        } else {
          console.error('Update check failed. See logs above for details.');
          process.exit(1);
        }
        return;
      }

      let version = versionOrRef ?? null;
      if (version) {
        version = version.replace(/^refs\/tags\/v?/, '').replace(/^v/, '');
      }
      if (!version) {
        console.log('Checking NPM registry for updates...');
        const check = await checkForNpmVersionUpdate(logFn, allowPre);
        if (check.status === 'available' && check.version) {
          version = check.version;
        } else if (check.status === 'up-to-date') {
          console.log('No update needed — already on latest.');
          return;
        } else {
          console.error('Update check failed. See logs above for details.');
          process.exit(1);
        }
      }

      console.log(`Updating to ${version} via NPM...`);
      const updateStatus = await performNpmUpdate(version!, logFn);
      if (updateStatus === 'updated') {
        const stopped = await stopDaemonIfRunning();
        if (!stopped) {
          console.error('Update applied but old daemon is still running. Stop it manually and run "dkg start".');
          process.exit(1);
        }
        console.log('Update applied. Run "dkg start" to start with the new version.');
      } else {
        console.error('Update failed. Check logs and retry.');
        process.exit(1);
      }
      return;
    }

    // --- Git-based update path (monorepo / install.sh installs) ---

    const refOverride = versionOrRef ? normalizeVersionTagRef(versionOrRef) : undefined;
    const verifyTagSignature = Boolean(refOverride && refOverride.startsWith('refs/tags/')) && opts.verifyTag !== false;

    if (opts.check) {
      console.log('Checking for updates...');
      const check = await checkForNewCommitWithStatus(au, (msg) => console.log(msg), refOverride);
      if (check.status === 'available' && check.commit) {
        console.log(`Update available: ${check.commit.slice(0, 8)}`);
      } else if (check.status === 'up-to-date') {
        console.log('No updates available.');
      } else {
        console.error('Update check failed. See logs above for details.');
        process.exit(1);
      }
      return;
    }

    await migrateToBlueGreen((msg) => console.log(msg), { allowRemoteBootstrap: true });
    console.log('Checking for updates and applying...');
    try {
      const updateStatus = await performUpdateWithStatus(au, (msg) => console.log(msg), {
        refOverride,
        allowPrerelease: opts.allowPrerelease ? true : undefined,
        verifyTagSignature,
      });
      if (updateStatus === 'updated') {
        const pid = await readPid();
        if (pid && isProcessRunning(pid)) {
          console.log('Stopping daemon...');
          try {
            process.kill(pid, 'SIGTERM');
          } catch (err) {
            if (!hasErrorCode(err, 'ESRCH')) throw err;
          }
          for (let i = 0; i < 20; i++) {
            await sleep(500);
            if (!isProcessRunning(pid)) break;
          }
          if (isProcessRunning(pid)) {
            console.error('Update applied but daemon is still running after SIGTERM. Stop it manually before restarting.');
            process.exit(1);
          }
          console.log('Update applied. Run "dkg start" to start with the new version.');
        } else {
          console.log('Update applied. Start the daemon with: dkg start');
        }
      } else if (updateStatus === 'up-to-date') {
        console.log('No update needed — already on latest.');
      } else {
        console.error('Update failed before activation. Check logs and retry.');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Update failed: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  });

// ─── dkg rollback ────────────────────────────────────────────────────

program
  .command('rollback')
  .description('Roll back to the previous release slot and stop the daemon')
  .action(async () => {
    const current = await activeSlot();
    if (!current) {
      console.error('Blue-green slots not initialized. Nothing to roll back.');
      process.exit(1);
    }

    const target = current === 'a' ? 'b' : 'a';
    const targetDir = join(releasesDir(), target);
    if (!existsSync(targetDir)) {
      console.error(`Slot ${target} does not exist. Cannot roll back.`);
      process.exit(1);
    }
    const targetEntry = slotEntryPoint(targetDir);
    if (!targetEntry) {
      console.error(`Slot ${target} has no build output. Run "dkg update" first to prepare it.`);
      process.exit(1);
    }

    const pid = await readPid();
    if (pid && isProcessRunning(pid)) {
      console.log('Stopping daemon...');
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        if (!hasErrorCode(err, 'ESRCH')) throw err;
      }
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (!isProcessRunning(pid)) break;
      }
      if (isProcessRunning(pid)) {
        console.error('Rollback aborted: daemon is still running after SIGTERM. Stop it manually and retry.');
        process.exit(1);
      }
    }

    await swapSlot(target);
    const commitFile = join(dkgDir(), '.current-commit');
    const versionFile = join(dkgDir(), '.current-version');
    if (existsSync(join(targetDir, '.git'))) {
      try {
        const commit = execSync('git rev-parse HEAD', {
          cwd: targetDir,
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim();
        await writeFile(commitFile, commit);
      } catch (err) {
        console.warn(`Warning: failed to read rollback commit: ${toErrorMessage(err)}`);
      }
    } else {
      try { await unlink(commitFile); } catch { /* already absent */ }
    }
    try {
      // Try git layout first, then NPM layout for version metadata.
      const candidates = [
        join(targetDir, 'packages', 'cli', 'package.json'),
        join(targetDir, 'node_modules', '@origintrail-official', 'dkg', 'package.json'),
      ];
      for (const pkgPath of candidates) {
        try {
          const pkgRaw = readFileSync(pkgPath, 'utf-8');
          const version = String((JSON.parse(pkgRaw) as { version?: string }).version ?? '').trim();
          if (version) { await writeFile(versionFile, version); break; }
        } catch { /* try next */ }
      }
    } catch (err) {
      console.warn(`Warning: failed to update rollback version metadata: ${toErrorMessage(err)}`);
    }
    console.log(`Rolled back: current → slot ${target}`);
    console.log('Daemon stopped. Run "dkg start" to start with the rolled-back version.');
  });

program.parse();
