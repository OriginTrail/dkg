#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  loadConfig, saveConfig, configExists, configPath,
  readPid, isProcessRunning, dkgDir, logPath, ensureDkgDir,
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
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string, def?: string): Promise<string> =>
      new Promise(resolve => {
        const suffix = def ? ` (${def})` : '';
        rl.question(`${q}${suffix}: `, answer => resolve(answer.trim() || def || ''));
      });

    console.log('DKG Node Setup\n');

    const name = await ask('Node name?', existing.name !== 'dkg-node' ? existing.name : undefined);
    const roleAnswer = await ask('Node role? (edge / core)', existing.nodeRole ?? 'edge');
    const nodeRole = roleAnswer === 'core' ? 'core' as const : 'edge' as const;
    const relay = nodeRole === 'edge'
      ? await ask('Relay multiaddr?', existing.relay)
      : await ask('Relay multiaddr? (optional for core)', existing.relay);
    const apiPort = parseInt(await ask('API port?', String(existing.apiPort)), 10);

    rl.close();

    const config = { ...existing, name: name || 'dkg-node', relay: relay || undefined, apiPort, nodeRole };
    await saveConfig(config);

    console.log(`\nConfig saved to ${configPath()}`);
    console.log(`  name:     ${config.name}`);
    console.log(`  role:     ${config.nodeRole}`);
    console.log(`  relay:    ${config.relay ?? '(none)'}`);
    console.log(`  apiPort:  ${config.apiPort}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function fileURLToPath(url: string): string {
  return new URL(url).pathname;
}

program.parse();
