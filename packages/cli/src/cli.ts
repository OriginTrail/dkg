#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  loadConfig, saveConfig, configExists, configPath,
  readPid, isProcessRunning, dkgDir, logPath, ensureDkgDir,
  loadNetworkConfig,
} from './config.js';
import { ApiClient } from './api-client.js';
import { runDaemon } from './daemon.js';

const program = new Command();
program
  .name('dkg')
  .description('DKG V9 testnet node CLI')
  .version('0.0.1');

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

    const name = await ask('Node name?', existing.name !== 'dkg-node' ? existing.name : undefined);
    const defaultRole = existing.nodeRole ?? network?.defaultNodeRole ?? 'edge';
    const roleAnswer = await ask('Node role? (edge / core)', defaultRole);
    const nodeRole = roleAnswer === 'core' ? 'core' as const : 'edge' as const;

    // Pre-fill relay from network config if user hasn't set one
    const defaultRelay = existing.relay ?? network?.relays?.[0];
    const relay = nodeRole === 'edge'
      ? await ask('Relay multiaddr?', defaultRelay)
      : await ask('Relay multiaddr? (optional for core)', defaultRelay);

    const defaultParanets = existing.paranets?.length
      ? existing.paranets.join(',')
      : network?.defaultParanets?.length
        ? network.defaultParanets.join(',')
        : undefined;
    const paranetsStr = await ask(
      'Paranets to subscribe? (comma-separated)',
      defaultParanets,
    );
    const paranets = paranetsStr ? paranetsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    const apiPort = parseInt(await ask('API port?', String(existing.apiPort)), 10);
    const enableAutoUpdate = (await ask('Enable auto-update from GitHub? (y/n)', 'n')).toLowerCase() === 'y';

    let autoUpdate = existing.autoUpdate;
    if (enableAutoUpdate) {
      const repo = await ask('GitHub repo (owner/name)?', existing.autoUpdate?.repo);
      const branch = await ask('Branch?', existing.autoUpdate?.branch ?? 'main');
      const interval = parseInt(await ask('Check interval (minutes)?', String(existing.autoUpdate?.checkIntervalMinutes ?? 5)), 10);
      autoUpdate = { enabled: true, repo, branch, checkIntervalMinutes: interval };
    }

    rl.close();

    const config = {
      ...existing,
      name: name || 'dkg-node',
      relay: relay || undefined,
      apiPort,
      nodeRole,
      paranets,
      autoUpdate: enableAutoUpdate ? autoUpdate : existing.autoUpdate,
    };
    await saveConfig(config);

    console.log(`\nConfig saved to ${configPath()}`);
    console.log(`  name:       ${config.name}`);
    console.log(`  role:       ${config.nodeRole}`);
    console.log(`  relay:      ${config.relay ?? '(none)'}`);
    console.log(`  paranets:   ${paranets.length ? paranets.join(', ') : '(none)'}`);
    console.log(`  apiPort:    ${config.apiPort}`);
    console.log(`  autoUpdate: ${config.autoUpdate?.enabled ? `${config.autoUpdate.repo}@${config.autoUpdate.branch}` : 'disabled'}`);
    if (network) {
      console.log(`  network:    ${network.networkName}`);
    }
    console.log(`\nRun "dkg start" to start the node.`);
  });

// ─── dkg start ───────────────────────────────────────────────────────

program
  .command('start')
  .description('Start the DKG daemon')
  .option('-f, --foreground', 'Run in the foreground (don\'t daemonize)')
  .action(async (opts) => {
    if (!configExists()) {
      console.error('No config found. Run "dkg init" first.');
      process.exit(1);
    }

    const pid = await readPid();
    if (pid && isProcessRunning(pid)) {
      console.error(`Daemon already running (PID ${pid}). Use "dkg stop" first.`);
      process.exit(1);
    }

    if (opts.foreground) {
      await runDaemon(true);
      return;
    }

    // Spawn detached background process
    const child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), 'start', '--foreground'],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: process.env,
      },
    );
    child.unref();

    // Wait for daemon to write its PID file
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const newPid = await readPid();
      if (newPid && isProcessRunning(newPid)) {
        const config = await loadConfig();
        console.log(`DKG node "${config.name}" started (PID ${newPid}).`);
        console.log(`Logs: ${logPath()}`);
        return;
      }
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
        } catch {}
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
  .option('--format <fmt>', 'Explicit RDF format (nquads|ntriples|turtle|trig|json|jsonld)')
  .option('-t, --triples <json>', 'Inline JSON array of {subject, predicate, object} triples')
  .option('-s, --subject <uri>', 'Subject URI for simple publish')
  .option('-p, --predicate <uri>', 'Predicate URI for simple publish')
  .option('-o, --object <value>', 'Object value for simple publish')
  .action(async (paranet: string, opts) => {
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

      const result = await client.publish(paranet, quads);
      console.log(`Published to "${paranet}":`);
      console.log(`  KC ID: ${result.kcId}`);
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
  .action(async (paranet: string | undefined, opts) => {
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

// ─── dkg subscribe <paranet> ────────────────────────────────────────

program
  .command('subscribe <paranet>')
  .description('Subscribe to a paranet\'s GossipSub topic')
  .option('--save', 'Also save to config so it auto-subscribes on restart')
  .action(async (paranet: string, opts) => {
    try {
      const client = await ApiClient.connect();
      await client.subscribe(paranet);
      console.log(`Subscribed to paranet: ${paranet}`);

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
  .action(async (id: string, opts) => {
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

// ─── dkg logs ────────────────────────────────────────────────────────

program
  .command('logs')
  .description('Tail the daemon log')
  .option('-n, --lines <n>', 'Number of trailing lines', '30')
  .action(async (opts) => {
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

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function fileURLToPath(url: string): string {
  return new URL(url).pathname;
}

program.parse();
