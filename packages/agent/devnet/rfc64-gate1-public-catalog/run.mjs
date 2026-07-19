// SPDX-License-Identifier: Apache-2.0
//
// RFC-64 Gate 1 demonstration: TWO real DKGAgent OS processes.
//
// The author process publishes + announces a signed empty author-catalog
// genesis head; the receiver process's WIRED onCatalogHeadAvailable + scheduler
// fetch it by exact digest, re-verify it, and durably stage it into its
// control-object store. Correctness proof: the receiver reads the exact head
// back from its own control store, and the CG is NOT activated as queryable
// knowledge (Gate 1 stages; it does not activate KA/SWM/VM).
//
// Usage: node devnet/rfc64-gate1-public-catalog/run.mjs
// Requires: packages/agent + workspace deps built to dist.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { ethers } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const AGENT_PROCESS = join(HERE, 'agent-process.mjs');
const ARTIFACT = join(HERE, 'artifacts', 'gate1-result.json');

const NETWORK_ID = 'otp:20430';
const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/gate-1-demo';
const ISSUED_AT = '1773900000000';
const AUTHOR_PRIVATE_KEY = `0x${'64'.repeat(32)}`;
const AUTHOR_ADDRESS = new ethers.Wallet(AUTHOR_PRIVATE_KEY).address.toLowerCase();

function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

class Child {
  constructor(role) {
    this.role = role;
    this.events = [];
    this.waiters = [];
    this.proc = spawn(process.execPath, [AGENT_PROCESS, role], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const marker = 'RFC64_GATE1_EVENT ';
      if (!line.startsWith(marker)) return;
      const event = JSON.parse(line.slice(marker.length));
      this.events.push(event);
      this.waiters = this.waiters.filter((w) => {
        if (w.name === event.event) { w.resolve(event); return false; }
        return true;
      });
    });
  }

  send(cmd) {
    this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  waitFor(name, timeoutMs = 45_000) {
    const existing = this.events.find((e) => e.event === name);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.role}: timed out waiting for '${name}'`)),
        timeoutMs,
      );
      this.waiters.push({ name, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }

  stop() {
    try { this.proc.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`); } catch { /* */ }
    setTimeout(() => { try { this.proc.kill('SIGTERM'); } catch { /* */ } }, 1500).unref();
  }
}

async function main() {
  const author = new Child('author');
  const receiver = new Child('receiver');

  const authorReady = await author.waitFor('ready');
  const receiverReady = await receiver.waitFor('ready');

  // Real libp2p connectivity between the two processes (both directions).
  receiver.send({ cmd: 'dial', multiaddr: authorReady.multiaddr, peerId: authorReady.peerId });
  author.send({ cmd: 'dial', multiaddr: receiverReady.multiaddr, peerId: receiverReady.peerId });
  await Promise.all([receiver.waitFor('dialed'), author.waitFor('dialed')]);

  // Receiver independently accepts the SAME open policy from CG identity facts
  // (owner = author EOA) — never derived from the wire announcement.
  receiver.send({
    cmd: 'accept-policy',
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR_ADDRESS,
  });
  const receiverPolicy = await receiver.waitFor('policy-accepted');

  // Author produces + durably stages + announces the genesis head.
  author.send({
    cmd: 'publish',
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorPrivateKey: AUTHOR_PRIVATE_KEY,
    peers: [receiverReady.peerId],
    issuedAt: ISSUED_AT,
  });
  const published = await author.waitFor('published');

  // Receiver's wired scheduler fetches + re-verifies + durably stages the head.
  receiver.send({
    cmd: 'await-staged',
    headObjectDigest: published.headObjectDigest,
    signatureVariantDigest: published.signatureVariantDigest,
    contextGraphId: CONTEXT_GRAPH_ID,
  });
  const staged = await receiver.waitFor('staged');

  const checks = {
    authorCatalogServiceStarted: authorReady.catalogServiceStarted === true,
    receiverCatalogServiceStarted: receiverReady.catalogServiceStarted === true,
    policyDigestsMatchIndependently: receiverPolicy.policyDigest === published.policyDigest,
    announcementAcknowledged:
      Array.isArray(published.announcedPeers)
      && published.announcedPeers.includes(receiverReady.peerId)
      && published.failedPeers.length === 0,
    receiverStagedExactHead: staged.matchesExactHead === true
      && staged.readBackFromControlStore === published.headObjectDigest,
    exactlyOneDurableStage: staged.receiverStats?.stagedOnly === 1
      && staged.receiverStats?.applied === 0
      && staged.receiverStats?.failed === 0,
    noKaSwmActivation: Array.isArray(staged.activeContextGraphs)
      && staged.activeContextGraphs.length === 0,
  };
  const status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';

  const artifact = {
    schema: 'dkg-rfc64-gate1-public-catalog-evidence-v1',
    status,
    checks,
    scope: { networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, authorAddress: AUTHOR_ADDRESS },
    processes: {
      author: { agentClass: authorReady.agentClass, peerId: authorReady.peerId },
      receiver: { agentClass: receiverReady.agentClass, peerId: receiverReady.peerId },
    },
    head: {
      objectDigest: published.headObjectDigest,
      signatureVariantDigest: published.signatureVariantDigest,
      policyDigest: published.policyDigest,
    },
    receiver: {
      independentlyAcceptedPolicyDigest: receiverPolicy.policyDigest,
      readBackFromControlStore: staged.readBackFromControlStore,
      receiverStats: staged.receiverStats,
      activeContextGraphsForCg: staged.activeContextGraphs,
    },
  };

  await mkdir(dirname(ARTIFACT), { recursive: true });
  await writeFile(ARTIFACT, `${stableJson(artifact)}\n`);

  author.stop();
  receiver.stop();

  process.stdout.write(`\n${stableJson(artifact)}\n`);
  process.stdout.write(`\nGate 1 two-process demo: ${status}\n`);
  process.exit(status === 'PASS' ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`gate1 demo failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
