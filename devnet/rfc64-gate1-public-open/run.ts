import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { ethers } from 'ethers';

import { readCleanRepositoryHead } from '../rfc64-persistence-lifecycle/evidence.js';
import {
  ChildProcessRegistry,
  cleanupPreservingPrimaryFailure,
} from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { Gate1AgentChild, type Gate1AgentEvent } from './agent-child.js';
import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_REAL_DKG_AGENT_ADAPTER_ID,
} from './model.js';
import { assertGate1ProductCapabilities } from './product-capabilities.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ADAPTER_PROCESS = join(import.meta.dirname, 'adapter-process.ts');
const DEFAULT_RAW_ARTIFACT = join(import.meta.dirname, 'artifacts/gate1-result.json');
const DEFAULT_VERDICT_ARTIFACT = join(import.meta.dirname, 'artifacts/gate1-verdict.json');
const PROCESS_TIMEOUT_MS = 60_000;

const NETWORK_ID = 'otp:20430';
const CONTEXT_GRAPH_ID = '0x1111111111111111111111111111111111111111/gate-1';
const AUTHOR_PRIVATE_KEY = `0x${'64'.repeat(32)}`;
const AUTHOR_ADDRESS = new ethers.Wallet(AUTHOR_PRIVATE_KEY).address.toLowerCase();
const ROLE_MASTER_KEYS = Object.freeze({
  author: '1a'.repeat(32),
  receiver: '2b'.repeat(32),
});

async function execute(): Promise<void> {
  const headBefore = readCleanRepositoryHead(REPO_ROOT);
  const rawArtifactPath = process.env.DKG_RFC64_GATE1_ARTIFACT ?? DEFAULT_RAW_ARTIFACT;
  const verdictArtifactPath = process.env.DKG_RFC64_GATE1_VERDICT_ARTIFACT
    ?? DEFAULT_VERDICT_ARTIFACT;
  // A failed production exercise must never leave a fixture-era PASS available
  // for a later standalone verifier invocation.
  rmSync(rawArtifactPath, { force: true });
  rmSync(verdictArtifactPath, { force: true });

  const authorDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate1-author-'));
  const receiverDataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate1-receiver-'));
  const children = new ChildProcessRegistry(20_000);
  let operationFailed = true;
  let primaryFailure: unknown;
  try {
    const author = spawnAgent('author', authorDataDir, children);
    const receiver = spawnAgent('receiver', receiverDataDir, children);
    const [authorReady, receiverReady] = await Promise.all([
      author.waitFor('ready'),
      receiver.waitFor('ready'),
    ]);
    requireRealReady(authorReady, 'author');
    requireRealReady(receiverReady, 'receiver');
    requireCondition(authorReady.peerId !== receiverReady.peerId, 'peer identities are not distinct');

    await Promise.all([
      receiver.request('dial', 'receiver-dial-author-v1', 'dialed', {
        multiaddr: authorReady.multiaddr,
        peerId: authorReady.peerId,
      }),
      author.request('dial', 'author-dial-receiver-v1', 'dialed', {
        multiaddr: receiverReady.multiaddr,
        peerId: receiverReady.peerId,
      }),
    ]);

    // Both sides derive the accepted open policy from independently supplied
    // scenario identity facts; no announcement is trusted as an authorization oracle.
    const [authorPolicy, receiverPolicy] = await Promise.all([
      author.request('acceptOpenPolicy', 'author-policy-v1', 'operation-completed', {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        ownerAddress: AUTHOR_ADDRESS,
      }),
      receiver.request('acceptOpenPolicy', 'receiver-policy-v1', 'operation-completed', {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        ownerAddress: AUTHOR_ADDRESS,
      }),
    ]);
    const authorPolicyDigest = requiredOutputString(authorPolicy, 'policyDigest');
    const receiverPolicyDigest = requiredOutputString(receiverPolicy, 'policyDigest');
    requireCondition(
      authorPolicyDigest === receiverPolicyDigest,
      'author and receiver derived different open-policy digests',
    );

    assertGate1ProductCapabilities({
      author: authorReady.capabilities,
      receiver: receiverReady.capabilities,
    });

    // The exact successor/result mapping is intentionally not guessed on this
    // base commit. A follow-up composition against the native-wiring commit
    // replaces this closed failure with the six-operation scenario. Keeping the
    // boundary fatal prevents a newly-added but shape-incompatible API from
    // silently manufacturing an artifact.
    throw new Error(
      `RFC-64 Gate 1 production APIs are present at ${headBefore}, but the real successor `
        + 'result contract has not yet been composed into this harness; refusing to emit evidence',
    );
  } catch (error) {
    primaryFailure = error;
  } finally {
    await cleanupPreservingPrimaryFailure({
      operationFailed,
      primaryFailure,
      cleanup: () => children.terminateAllThenCleanup(() => {
        rmSync(authorDataDir, { force: true, recursive: true });
        rmSync(receiverDataDir, { force: true, recursive: true });
      }),
      reportSecondaryFailure: (primary, secondary) => {
        process.stderr.write(
          `[rfc64-gate1-harness] cleanup failure after ${String(primary)}: ${String(secondary)}\n`,
        );
      },
    });
  }
}

function spawnAgent(
  role: 'author' | 'receiver',
  dataDir: string,
  registry: ChildProcessRegistry,
): Gate1AgentChild {
  return new Gate1AgentChild({
    eventTimeoutMs: PROCESS_TIMEOUT_MS,
    registry,
    role,
    spawn: {
      command: process.execPath,
      args: ['--import', 'tsx', ADAPTER_PROCESS, role],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DKG_RFC64_GATE1_ADAPTER_DATA_DIR: dataDir,
        DKG_RFC64_GATE1_AGENT_MASTER_KEY_HEX: ROLE_MASTER_KEYS[role],
        NODE_ENV: 'production',
      },
    },
  });
}

function requireRealReady(event: Gate1AgentEvent, expectedRole: 'author' | 'receiver'): void {
  requireCondition(event.role === expectedRole, 'ready role differs from the spawned role');
  requireCondition(
    event.adapterId === GATE1_REAL_DKG_AGENT_ADAPTER_ID,
    'adapter did not identify the real DKGAgent boundary',
  );
  requireCondition(
    event.protocolVersion === GATE1_ADAPTER_PROTOCOL_VERSION,
    'adapter protocol version changed',
  );
  requireCondition(event.agentClass === 'DKGAgent', 'child did not boot a real DKGAgent');
  requireCondition(event.catalogServiceStarted === true, 'production catalog service did not start');
  requireCondition(event.startupRepair === null, 'adapter claimed nonexistent automatic startup repair');
  requireCondition(typeof event.peerId === 'string' && event.peerId.length > 0, 'peer ID is missing');
  requireCondition(
    typeof event.multiaddr === 'string' && event.multiaddr.includes('/tcp/'),
    'TCP multiaddr is missing',
  );
  requireCondition(
    event.capabilities !== null && typeof event.capabilities === 'object',
    'product capability report is missing',
  );
}

function requiredOutputString(event: Gate1AgentEvent, key: string): string {
  const output = event.output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`${event.role}/${event.event} output is not an object`);
  }
  const value = (output as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${event.role}/${event.event} output.${key} is missing`);
  }
  return value;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await execute();
