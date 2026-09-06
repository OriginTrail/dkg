import { Command } from 'commander';

import { createInterface } from 'node:readline';

import { toErrorMessage } from '@origintrail-official/dkg-core';

import { ApiClient } from '../api-client.js';

import { printMessage } from '../cli-helpers.js';

export function registerNetworkCommands(program: Command): void {
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

program
  .command('peer info <peer-id>')
  .description('Inspect connection and sync capability for a specific peer')
  .action(async (peerId: string) => {
    try {
      const client = await ApiClient.connect();
      const info = await client.peerInfo(peerId);
      console.log(`Peer:          ${info.peerId}`);
      console.log(`Connected:     ${info.connected ? 'yes' : 'no'}`);
      console.log(`Connections:   ${info.connectionCount}`);
      console.log(`Sync Capable:  ${info.syncCapable ? 'yes' : 'no'}`);
      const syncStatus = info.syncStatus ?? {
        capable: info.syncCapable,
        capability: info.syncCapable ? 'supported' as const : 'unknown' as const,
        lastSuccessfulSyncAt: null,
        stale: false,
        backoff: null,
      };
      const syncLastOk = syncStatus.lastSuccessfulSyncAt
        ? new Date(syncStatus.lastSuccessfulSyncAt).toISOString()
        : 'never';
      const syncBackoff = syncStatus.backoff
        ? `, backoff failures=${syncStatus.backoff.failures}, retry in ${Math.round(syncStatus.backoff.retryInMs / 1000)}s`
        : '';
      const syncCapability = syncStatus.capability ?? (syncStatus.capable ? 'supported' : 'unsupported');
      const syncState = syncCapability === 'supported'
        ? (syncStatus.stale ? 'stale' : 'fresh')
        : syncCapability === 'unknown'
          ? (syncStatus.stale ? 'unknown/stale' : 'unknown')
        : 'unsupported';
      console.log(`Sync Status:   ${syncState} (last success: ${syncLastOk}${syncBackoff})`);
      if (info.transports.length > 0) console.log(`Transports:    ${info.transports.join(', ')}`);
      if (info.directions.length > 0) console.log(`Directions:    ${info.directions.join(', ')}`);
      if (info.remoteAddrs.length > 0) console.log(`Remote Addrs:  ${info.remoteAddrs.filter(Boolean).join(', ')}`);
      if (info.protocols.length > 0) console.log(`Protocols:     ${info.protocols.join(', ')}`);
      if (info.lastSeen) console.log(`Last Seen:     ${new Date(info.lastSeen).toISOString()}`);
      if (info.latencyMs != null) console.log(`Latency:       ${info.latencyMs} ms`);
    } catch (err) {
      console.error(toErrorMessage(err));
      process.exit(1);
    }
  });

// ─── dkg connect ─────────────────────────────────────────────────────
// Direct dial helper, mostly useful for ad-hoc P2P troubleshooting and
// validating an invite before pasting it into the UI. Two modes:
//   dkg connect <multiaddr>          legacy direct dial
//   dkg connect --peer-id <peerId>   V10 DHT-resolved dial
// The peer-id form is preferred — it asks the daemon to walk the libp2p
// Kademlia table and pick up the peer's *current* multiaddrs, which is
// exactly how invite redemption now resolves curators.
program
  .command('connect [multiaddr]')
  .description('Dial a peer by multiaddr or peer id (DHT-resolved)')
  .option('--peer-id <id>', 'Resolve via libp2p DHT (peerRouting.findPeer) and dial')
  .action(async (multiaddrArg: string | undefined, opts: { peerId?: string }) => {
    if (!multiaddrArg && !opts.peerId) {
      console.error('Provide either a multiaddr or --peer-id <id>');
      process.exit(1);
    }
    if (multiaddrArg && opts.peerId) {
      console.error('Pass either a multiaddr or --peer-id, not both');
      process.exit(1);
    }
    try {
      const client = await ApiClient.connect();
      if (opts.peerId) {
        await client.connectByPeerId(opts.peerId);
        console.log(`Connected to ${opts.peerId} (resolved via DHT)`);
      } else {
        await client.connect(multiaddrArg!);
        console.log(`Connected to ${multiaddrArg}`);
      }
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

}
