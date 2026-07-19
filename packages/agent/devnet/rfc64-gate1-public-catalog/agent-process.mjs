// SPDX-License-Identifier: Apache-2.0
//
// RFC-64 Gate 1 demo child: one REAL DKGAgent process. It boots the agent
// (which wires the public author-catalog service onto its production router),
// then drives the author/receiver flow via a line protocol on stdin/stdout.
// Everything runs through the WIRED agent API — no transport is hand-built.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { multiaddr } from '@multiformats/multiaddr';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

const ROLE = process.argv[2] ?? 'agent';

function emit(event) {
  process.stdout.write(`RFC64_GATE1_EVENT ${JSON.stringify({ role: ROLE, ...event })}\n`);
}

let agent;
let dataDir;

async function boot() {
  dataDir = await mkdtemp(join(tmpdir(), `dkg-rfc64-gate1-${ROLE}-`));
  agent = await DKGAgent.create({
    name: `RFC64Gate1${ROLE}`,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
  });
  await agent.start();
  const tcp = agent.multiaddrs.find((a) => a.includes('/tcp/'));
  emit({
    event: 'ready',
    agentClass: agent.constructor.name,
    peerId: agent.peerId,
    multiaddr: tcp,
    catalogServiceStarted: agent.rfc64PublicCatalogStatsV1()?.started === true,
  });
}

async function handle(cmd) {
  switch (cmd.cmd) {
    case 'dial': {
      await agent.node.libp2p.dial(multiaddr(cmd.multiaddr));
      emit({ event: 'dialed', to: cmd.peerId });
      break;
    }
    case 'accept-policy': {
      const accepted = agent.acceptOpenContextGraphPolicyV1({
        networkId: cmd.networkId,
        contextGraphId: cmd.contextGraphId,
        ownerAddress: cmd.ownerAddress,
      });
      emit({ event: 'policy-accepted', policyDigest: accepted.policyDigest });
      break;
    }
    case 'publish': {
      const wallet = new ethers.Wallet(cmd.authorPrivateKey);
      const result = await agent.publishOpenAuthorCatalogGenesisV1({
        networkId: cmd.networkId,
        contextGraphId: cmd.contextGraphId,
        author: wallet,
        peers: cmd.peers,
        issuedAt: cmd.issuedAt,
      });
      emit({
        event: 'published',
        headObjectDigest: result.headObjectDigest,
        signatureVariantDigest: result.signatureVariantDigest,
        policyDigest: result.announcement.policyDigest,
        announcedPeers: result.announcedPeers,
        failedPeers: result.failedPeers,
      });
      break;
    }
    case 'await-staged': {
      // The wired receiver scheduler stages asynchronously on the announcement.
      await agent.whenRfc64PublicCatalogReceiverIdleV1();
      const stagedDigest = await agent.readRfc64StagedAuthorCatalogHeadV1({
        objectDigest: cmd.headObjectDigest,
        signatureVariantDigest: cmd.signatureVariantDigest,
      });
      emit({
        event: 'staged',
        readBackFromControlStore: stagedDigest,
        matchesExactHead: stagedDigest === cmd.headObjectDigest,
        receiverStats: agent.rfc64PublicCatalogStatsV1()?.receiver ?? null,
        activeContextGraphs: (await agent.listContextGraphs())
          .filter((row) => row.id === cmd.contextGraphId || row.uri.includes(cmd.contextGraphId))
          .map((row) => row.id),
      });
      break;
    }
    case 'stop': {
      await shutdown(0);
      break;
    }
    default:
      emit({ event: 'error', message: `unknown command ${cmd.cmd}` });
  }
}

async function shutdown(code) {
  try { await agent?.stop(); } catch { /* best-effort */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(code);
}

process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(130); });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    emit({ event: 'error', message: 'invalid command json' });
    return;
  }
  handle(cmd).catch((error) => {
    emit({ event: 'error', message: error instanceof Error ? error.message : String(error) });
  });
});

boot().catch((error) => {
  emit({ event: 'boot-failed', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
