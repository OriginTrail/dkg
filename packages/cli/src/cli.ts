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
import {
  loadConfig, saveConfig, configExists, configPath,
  readPid, readApiPort, isProcessRunning, dkgDir, logPath, ensureDkgDir,
  loadNetworkConfig, releasesDir, activeSlot, swapSlot,
  slotEntryPoint, isStandaloneInstall,
} from './config.js';
import { ApiClient } from './api-client.js';
import {
  runDaemon,
  performUpdateWithStatus,
  checkForNewCommitWithStatus,
  checkForNpmVersionUpdate,
  performNpmUpdate,
  DAEMON_EXIT_CODE_RESTART,
} from './daemon.js';
import { migrateToBlueGreen } from './migration.js';

/** Options object passed to commander action callbacks (parsed .option() values) */
type ActionOpts = Record<string, any>;

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

function resolveDaemonEntryPoint(): string {
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

const program = new Command();
program
  .name('dkg')
  .description('DKG V9 testnet node CLI')
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

    const defaultParanets = existing.paranets?.length
      ? existing.paranets.join(',')
      : network?.defaultParanets?.length
        ? network.defaultParanets.join(',')
        : undefined;
    const paranetsStr = await ask(
      'Paranets to subscribe (comma-separated)',
      defaultParanets,
    );
    const paranets = paranetsStr ? paranetsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
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

    const chainSection: any = rpcUrl && hubAddress ? {
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

    console.log('\nOperational wallets are stored in ~/.dkg/wallets.json');
    console.log('They are auto-generated on first start. You can edit the file to add your own keys.');

    rl.close();

    const config = {
      ...existing,
      name: name || 'dkg-node',
      relay: (!existing.relay && relay === networkDefaultRelay) ? undefined : (relay || undefined),
      apiPort,
      nodeRole,
      paranets,
      autoUpdate: enableAutoUpdate ? autoUpdate : existing.autoUpdate,
      chain: chainSection ?? existing.chain,
      auth: { enabled: enableAuth, tokens: existing.auth?.tokens },
    };
    await saveConfig(config);

    console.log(`\nConfig saved to ${configPath()}`);
    console.log(`  name:       ${config.name}`);
    console.log(`  role:       ${config.nodeRole}`);
    const relayDisplay = config.relay
      ?? (network?.relays?.length ? `(network default — ${network.relays.length} relays)` : '(none)');
    console.log(`  relay:      ${relayDisplay}`);
    console.log(`  paranets:   ${paranets.length ? paranets.join(', ') : '(none)'}`);
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
    await migrateToBlueGreen((msg) => console.log(msg), { allowRemoteBootstrap: false });

    if (opts.foreground) {
      await runDaemon(true);
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
    if (startedPid) {
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
    } catch (err: any) {
      console.error(err.message);
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
    } catch (err: any) {
      console.error(err.message);
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
    } catch (err: any) {
      console.error(err.message);
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
    } catch (err: any) {
      console.error(err.message);
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
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── dkg publish <paranet> ───────────────────────────────────────────

program
  .command('publish <paranet>')
  .description('Publish triples to a paranet from an RDF file or inline')
  .option('-f, --file <path>', 'RDF file (.nq, .nt, .ttl, .trig, .jsonld, .json)')
  .option('--private-file <path>', 'RDF file with private triples (encrypted, access-controlled)')
  .option('--format <fmt>', 'Explicit RDF format (nquads|ntriples|turtle|trig|json|jsonld)')
  .option('-t, --triples <json>', 'Inline JSON array of {subject, predicate, object} triples')
  .option('-s, --subject <uri>', 'Subject URI for simple publish')
  .option('-p, --predicate <uri>', 'Predicate URI for simple publish')
  .option('-o, --object <value>', 'Object value for simple publish')
  .option('--access-policy <policy>', 'Access policy for private triples (public|ownerOnly|allowList)')
  .option('--allowed-peer <peerId>', 'Peer ID allowed when using allowList policy', (v, prev: string[] = []) => [...prev, v], [])
  .action(async (paranet: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const rdfParser = await import('./rdf-parser.js');
      const defaultGraph = `did:dkg:paranet:${paranet}`;

      let quads: Array<{ subject: string; predicate: string; object: string; graph: string }>;

      if (opts.file) {
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(opts.file, 'utf-8');
        const format = opts.format ?? rdfParser.detectFormat(opts.file);
        quads = await rdfParser.parseRdf(raw, format, defaultGraph);
        console.log(`Parsed ${quads.length} quad(s) from ${opts.file} (${format})`);
      } else if (opts.triples) {
        const parsed = JSON.parse(opts.triples);
        quads = parsed.map((q: any) => ({ ...q, graph: q.graph || defaultGraph }));
      } else if (opts.subject && opts.predicate && opts.object) {
        quads = [{
          subject: opts.subject,
          predicate: opts.predicate,
          object: opts.object.startsWith('"') || opts.object.startsWith('http') || opts.object.startsWith('did:')
            ? opts.object
            : `"${opts.object}"`,
          graph: defaultGraph,
        }];
      } else {
        console.error(`Provide --file (${rdfParser.supportedExtensions().join(', ')}), --triples, or --subject/--predicate/--object`);
        process.exit(1);
      }

      let privateQuads: Array<{ subject: string; predicate: string; object: string; graph: string }> | undefined;
      if (opts.privateFile) {
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(opts.privateFile, 'utf-8');
        const format = opts.format ?? rdfParser.detectFormat(opts.privateFile);
        privateQuads = await rdfParser.parseRdf(raw, format, defaultGraph);
        console.log(`Parsed ${privateQuads.length} private quad(s) from ${opts.privateFile} (${format})`);
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

      const result = await client.publish(paranet, quads, privateQuads, {
        accessPolicy,
        allowedPeers,
      });
      console.log(`Published to "${paranet}":`);
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
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── dkg query <paranet> <sparql> ───────────────────────────────────

program
  .command('query [paranet]')
  .description('Run a SPARQL query against a paranet (or all)')
  .option('-q, --sparql <query>', 'SPARQL query string')
  .option('-f, --file <path>', 'File containing SPARQL query')
  .action(async (paranet: string | undefined, opts: ActionOpts) => {
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

      const { result } = await client.query(sparql, paranet);

      if (result?.type === 'bindings' && result.bindings) {
        if (result.bindings.length === 0) {
          console.log('No results.');
          return;
        }
        const keys = Object.keys(result.bindings[0]);
        const widths = keys.map(k => Math.max(k.length, ...result.bindings.map(
          (row: any) => stripQuotes(String(row[k] ?? '')).length,
        )));

        const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
        console.log(header);
        console.log(widths.map((w: number) => '─'.repeat(w)).join('  '));
        for (const row of result.bindings) {
          const line = keys.map((k, i) => stripQuotes(String(row[k] ?? '')).padEnd(widths[i])).join('  ');
          console.log(line);
        }
        console.log(`\n${result.bindings.length} row(s)`);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── dkg query-remote <peer> ───────────────────────────────────────

program
  .command('query-remote <peer>')
  .description('Query a remote peer\'s knowledge store')
  .option('-q, --sparql <query>', 'SPARQL query (requires --paranet)')
  .option('--ual <ual>', 'Look up a knowledge asset by UAL')
  .option('--entity <uri>', 'Get all triples for an entity URI (requires --paranet)')
  .option('--type <rdfType>', 'Find entities by RDF type (requires --paranet)')
  .option('-p, --paranet <id>', 'Target paranet')
  .option('-l, --limit <n>', 'Max results', '100')
  .option('--timeout <ms>', 'Query timeout in ms', '5000')
  .action(async (peer: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();

      let lookupType: string;
      const request: Record<string, any> = {
        paranetId: opts.paranet,
        limit: parseInt(opts.limit, 10),
        timeout: parseInt(opts.timeout, 10),
      };

      if (opts.ual) {
        lookupType = 'ENTITY_BY_UAL';
        request.ual = opts.ual;
      } else if (opts.type) {
        lookupType = 'ENTITIES_BY_TYPE';
        request.rdfType = opts.type;
        if (!opts.paranet) {
          console.error('--paranet is required for --type queries');
          process.exit(1);
        }
      } else if (opts.entity) {
        lookupType = 'ENTITY_TRIPLES';
        request.entityUri = opts.entity;
        if (!opts.paranet) {
          console.error('--paranet is required for --entity queries');
          process.exit(1);
        }
      } else if (opts.sparql) {
        lookupType = 'SPARQL_QUERY';
        request.sparql = opts.sparql;
        if (!opts.paranet) {
          console.error('--paranet is required for --sparql queries');
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
            const widths = keys.map(k => Math.max(k.length, ...bindings.map(
              (row: any) => stripQuotes(String(row[k] ?? '')).length,
            )));
            const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
            console.log(header);
            console.log(widths.map((w: number) => '─'.repeat(w)).join('  '));
            for (const row of bindings) {
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
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── dkg subscribe <paranet> ────────────────────────────────────────

program
  .command('subscribe <paranet>')
  .description('Subscribe to a paranet\'s GossipSub topic')
  .option('--save', 'Also save to config so it auto-subscribes on restart')
  .action(async (paranet: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.subscribe(paranet);
      console.log(`Subscribed to paranet: ${paranet}`);
      const catchup = result.catchup;
      if (catchup) {
        if ('peersTried' in catchup) {
          console.log(
            `Catch-up sync: peers ${catchup.peersTried}/${catchup.syncCapablePeers} (connected ${catchup.connectedPeers}), data ${catchup.dataSynced}, workspace ${catchup.workspaceSynced}`,
          );
        } else {
          console.log(
            `Catch-up sync queued in background (job ${catchup.jobId}, workspace ${catchup.includeWorkspace ? 'enabled' : 'disabled'}).`,
          );
        }
      }

      if (opts.save) {
        const config = await loadConfig();
        const paranets = new Set(config.paranets ?? []);
        paranets.add(paranet);
        config.paranets = [...paranets];
        await saveConfig(config);
        console.log('Saved to config (will auto-subscribe on restart).');
      }
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── dkg sync ─────────────────────────────────────────────────────────

const syncCmd = program
  .command('sync')
  .description('Sync status helpers');

syncCmd
  .command('catchup-status <paranet>')
  .description('Show latest background catch-up status for a paranet')
  .action(async (paranet: string) => {
    try {
      const client = await ApiClient.connect();
      const status = await client.catchupStatus(paranet);

      console.log(`Paranet:   ${status.paranetId}`);
      console.log(`Job:       ${status.jobId}`);
      console.log(`Status:    ${status.status}`);
      console.log(`Workspace: ${status.includeWorkspace ? 'enabled' : 'disabled'}`);
      console.log(`Queued:    ${new Date(status.queuedAt).toISOString()}`);
      if (status.startedAt) console.log(`Started:   ${new Date(status.startedAt).toISOString()}`);
      if (status.finishedAt) console.log(`Finished:  ${new Date(status.finishedAt).toISOString()}`);
      if (status.result) {
        console.log(
          `Result:    peers ${status.result.peersTried}/${status.result.syncCapablePeers} (connected ${status.result.connectedPeers}), data ${status.result.dataSynced}, workspace ${status.result.workspaceSynced}`,
        );
      }
      if (status.error) {
        console.log(`Error:     ${status.error}`);
      }
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── dkg paranet ────────────────────────────────────────────────────

const paranetCmd = program
  .command('paranet')
  .description('Manage paranets (knowledge graph partitions)');

paranetCmd
  .command('create <id>')
  .description('Create a new paranet (publishes definition to the system ontology)')
  .option('-n, --name <name>', 'Human-readable name (defaults to id)')
  .option('-d, --description <desc>', 'Description of the paranet')
  .option('--subscribe', 'Also subscribe to the paranet after creation', true)
  .option('--save', 'Persist subscription to config')
  .action(async (id: string, opts: ActionOpts) => {
    try {
      const client = await ApiClient.connect();
      const result = await client.createParanet(id, opts.name ?? id, opts.description);
      console.log(`Paranet created:`);
      console.log(`  ID:   ${result.created}`);
      console.log(`  URI:  ${result.uri}`);
      console.log(`  Auto-subscribed to GossipSub topic.`);

      if (opts.save) {
        const config = await loadConfig();
        const paranets = new Set(config.paranets ?? []);
        paranets.add(id);
        config.paranets = [...paranets];
        await saveConfig(config);
        console.log('  Saved to config (will auto-subscribe on restart).');
      }
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

paranetCmd
  .command('list')
  .description('List all known paranets')
  .action(async () => {
    try {
      const client = await ApiClient.connect();
      const { paranets } = await client.listParanets();

      if (paranets.length === 0) {
        console.log('No paranets registered yet.');
        return;
      }

      const idW = Math.max(4, ...paranets.map(p => p.id.length));
      const nameW = Math.max(4, ...paranets.map(p => p.name.length));

      const header = `  ${'ID'.padEnd(idW)}   ${'Name'.padEnd(nameW)}   Type       Creator`;
      console.log(header);
      console.log('  ' + '─'.repeat(header.length - 2));

      for (const p of paranets) {
        const type = p.isSystem ? 'system' : 'user';
        const creator = p.creator
          ? (p.creator.length > 24 ? p.creator.slice(0, 12) + '...' + p.creator.slice(-8) : p.creator)
          : '—';
        console.log(`  ${p.id.padEnd(idW)}   ${p.name.padEnd(nameW)}   ${type.padEnd(9)}  ${creator}`);
      }
      console.log(`\n  ${paranets.length} paranet(s)`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

paranetCmd
  .command('info <id>')
  .description('Show details of a specific paranet')
  .action(async (id: string) => {
    try {
      const client = await ApiClient.connect();
      const { paranets } = await client.listParanets();
      const p = paranets.find(x => x.id === id);
      if (!p) {
        console.error(`Paranet "${id}" not found.`);
        process.exit(1);
      }
      console.log(`  ID:          ${p.id}`);
      console.log(`  URI:         ${p.uri}`);
      console.log(`  Name:        ${p.name}`);
      console.log(`  Description: ${p.description ?? '—'}`);
      console.log(`  Type:        ${p.isSystem ? 'system' : 'user'}`);
      console.log(`  Creator:     ${p.creator ?? '—'}`);
      console.log(`  Created:     ${p.createdAt ?? '—'}`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── dkg index ──────────────────────────────────────────────────────

program
  .command('index [directory]')
  .description('Index a repository and write to workspace graph or publish directly')
  .option('-p, --paranet <id>', 'Target paranet', 'dev-coordination')
  .option('--workspace', 'Write indexed quads to workspace graph instead of publishing')
  .option('--include-content', 'Index docs/content files in addition to source code')
  .option('--dry-run', 'Print statistics without publishing')
  .option('--output <file>', 'Write quads to a JSON file instead of publishing')
  .action(async (directory: string | undefined, opts: ActionOpts) => {
    try {
      const { resolve } = await import('node:path');
      const repoRoot = resolve(directory ?? '.');

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
      const verb = opts.workspace ? 'Staging in workspace' : 'Publishing';
      const applyBatch = opts.workspace
        ? async (batch: typeof result.quads) => client.workspaceWrite(opts.paranet, batch)
        : async (batch: typeof result.quads) => client.publish(opts.paranet, batch);

      await publishEntityBatches(result.quads, applyBatch, (sent) => {
        process.stdout.write(`\r  ${verb}: ${sent}/${result.quads.length} quads`);
      });

      if (opts.workspace) {
        console.log(`\n\n  Staged ${result.quads.length} quads to workspace graph for paranet "${opts.paranet}".`);
        console.log('  Next: dkg workspace publish ' + opts.paranet);
      } else {
        console.log(`\n\n  Published ${result.quads.length} quads to paranet "${opts.paranet}".`);
      }
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── dkg workspace ───────────────────────────────────────────────────

const workspaceCmd = program
  .command('workspace')
  .description('Workspace graph operations (stage-first workflow)');

workspaceCmd
  .command('publish [paranet]')
  .description('Enshrine staged workspace graph into a paranet publish')
  .option('--keep', 'Keep workspace triples after enshrining')
  .option('--root <entity...>', 'Enshrine only specific root entities')
  .action(async (paranet: string | undefined, opts: ActionOpts) => {
    try {
      const targetParanet = paranet ?? 'dev-coordination';
      const client = await ApiClient.connect();
      const selection = opts.root?.length
        ? { rootEntities: opts.root as string[] }
        : 'all';
      const result = await client.workspaceEnshrine(targetParanet, selection, !opts.keep);
      console.log(`Workspace enshrined to "${targetParanet}":`);
      console.log(`  Status: ${result.status}`);
      console.log(`  KC ID:  ${result.kcId}`);
      console.log(`  KAs:    ${result.kas.length}`);
      if (result.txHash) {
        console.log(`  TX:     ${result.txHash}`);
      }
    } catch (err: any) {
      console.error(err.message);
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
    } catch (err: any) {
      console.error(err.message);
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
    } catch (err: any) {
      if (err.code === 'CALL_EXCEPTION') {
        console.error(
          `Transaction reverted. The primary wallet may not be the admin/operational key for this identity.\n` +
          `Use --identity <id> if auto-detection picked the wrong identity.`,
        );
      }
      console.error(err.message ?? err);
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
): Promise<void> {
  // Keep entities intact per batch to avoid partial-entity writes.
  const byEntity = new Map<string, typeof quads>();
  for (const q of quads) {
    const key = q.subject;
    let arr = byEntity.get(key);
    if (!arr) { arr = []; byEntity.set(key, arr); }
    arr.push(q);
  }

  const MAX_BATCH_QUADS = 500;
  let batch: typeof quads = [];
  let sent = 0;

  for (const entityQuads of byEntity.values()) {
    if (batch.length + entityQuads.length > MAX_BATCH_QUADS && batch.length > 0) {
      await applyBatch(batch);
      sent += batch.length;
      onProgress?.(sent);
      batch = [];
    }
    batch.push(...entityQuads);
  }

  if (batch.length > 0) {
    await applyBatch(batch);
    sent += batch.length;
    onProgress?.(sent);
  }
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
  try { process.kill(pid, 'SIGTERM'); } catch (err: any) {
    if (err?.code !== 'ESRCH') throw err;
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
          } catch (err: any) {
            if (err?.code !== 'ESRCH') throw err;
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
    } catch (err: any) {
      console.error(`Update failed: ${err?.message ?? String(err)}`);
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
      } catch (err: any) {
        if (err?.code !== 'ESRCH') throw err;
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
      } catch (err: any) {
        console.warn(`Warning: failed to read rollback commit: ${err?.message ?? String(err)}`);
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
    } catch (err: any) {
      console.warn(`Warning: failed to update rollback version metadata: ${err?.message ?? String(err)}`);
    }
    console.log(`Rolled back: current → slot ${target}`);
    console.log('Daemon stopped. Run "dkg start" to start with the rolled-back version.');
  });

program.parse();
