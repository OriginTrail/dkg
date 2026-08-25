import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { readCleanRepositoryHead } from '../rfc64-persistence-lifecycle/evidence.js';
import { ChildProcessRegistry } from '../rfc64-persistence-lifecycle/process-lifecycle.js';
import { Gate2AgentChild, type Gate2AgentEvent } from './agent-child.js';
import {
  GATE2_ADAPTER_PROTOCOL_VERSION,
  GATE2_REAL_DKG_AGENT_ADAPTER_ID,
} from './model.js';
import {
  assertGate2RuntimeManifestEqualV1,
  buildGate2RuntimeManifestV1,
  type Gate2RuntimeManifestV1,
} from './runtime-provenance.ts';

const ADAPTER_PROCESS = join(import.meta.dirname, 'adapter-process.ts');
const RUNTIME_LOAD_HOOK = join(import.meta.dirname, 'runtime-load-hook.ts');
const PROCESS_TIMEOUT_MS = 90_000;
const ROLE_MASTER_KEYS = Object.freeze({
  author: '1a'.repeat(32),
  receiver: '2b'.repeat(32),
});

export type Gate2HarnessAgentRoleV1 = 'author' | 'receiver';

export interface Gate2TwoAgentDataDirsV1 {
  readonly author: string;
  readonly receiver: string;
}

export function createGate2TwoAgentDataDirsV1(label: string): Gate2TwoAgentDataDirsV1 {
  if (!/^[a-z0-9-]+$/u.test(label)) throw new TypeError('harness label is not safe');
  return Object.freeze({
    author: mkdtempSync(join(tmpdir(), `dkg-rfc64-${label}-author-`)),
    receiver: mkdtempSync(join(tmpdir(), `dkg-rfc64-${label}-receiver-`)),
  });
}

/** Verify one clean source/runtime boundary and return the exact current HEAD. */
export function assertGate2HarnessSourceStateV1(
  repoRoot: string,
  expectedSourceCommit: string,
  expectedManifest: Gate2RuntimeManifestV1,
): string {
  const head = readCleanRepositoryHead(repoRoot);
  exact(head, expectedSourceCommit, 'clean harness source commit');
  assertGate2RuntimeManifestEqualV1(
    buildGate2RuntimeManifestV1(repoRoot, head),
    expectedManifest,
  );
  return head;
}

export function spawnGate2HarnessAgentV1(input: {
  readonly catalogLocalAgentAddress?: string;
  readonly dataDir: string;
  readonly finalizedVmConfigJson?: string;
  readonly networkChainId?: string;
  readonly registry: ChildProcessRegistry;
  readonly repoRoot: string;
  readonly role: Gate2HarnessAgentRoleV1;
  readonly runtimeManifestDigest: string;
  readonly sourceCommit: string;
}): Gate2AgentChild {
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_PATH;
  delete childEnv.TSX_TSCONFIG_PATH;
  return new Gate2AgentChild({
    eventTimeoutMs: PROCESS_TIMEOUT_MS,
    registry: input.registry,
    role: input.role,
    spawn: {
      command: process.execPath,
      args: ['--import', 'tsx', '--import', RUNTIME_LOAD_HOOK, ADAPTER_PROCESS, input.role],
      cwd: input.repoRoot,
      env: {
        ...childEnv,
        DKG_RFC64_GATE2_ADAPTER_DATA_DIR: input.dataDir,
        DKG_RFC64_GATE2_AGENT_MASTER_KEY_HEX: ROLE_MASTER_KEYS[input.role],
        DKG_RFC64_GATE2_RUNTIME_MANIFEST_DIGEST: input.runtimeManifestDigest,
        DKG_RFC64_GATE2_RUNTIME_SOURCE_COMMIT: input.sourceCommit,
        ...(input.catalogLocalAgentAddress === undefined
          ? {}
          : {
              DKG_RFC64_GATE2_CATALOG_LOCAL_AGENT_ADDRESS:
                input.catalogLocalAgentAddress,
            }),
        ...(input.networkChainId === undefined
          ? {}
          : { DKG_RFC64_GATE2_NETWORK_CHAIN_ID: input.networkChainId }),
        ...(input.finalizedVmConfigJson === undefined
          ? {}
          : { DKG_RFC64_GATE2_FINALIZED_VM_CONFIG: input.finalizedVmConfigJson }),
        NODE_ENV: 'production',
      },
    },
  });
}

export function assertGate2HarnessReadyV1(
  event: Gate2AgentEvent,
  expectedRole: Gate2HarnessAgentRoleV1,
  runtimeManifestDigest: string,
): void {
  exact(event.role, expectedRole, 'ready role');
  exact(event.adapterId, GATE2_REAL_DKG_AGENT_ADAPTER_ID, 'ready adapter');
  exact(event.protocolVersion, GATE2_ADAPTER_PROTOCOL_VERSION, 'ready protocol');
  exact(event.agentClass, 'DKGAgent', 'ready agent class');
  exact(event.catalogServiceStarted, true, 'ready catalog service');
  exact(event.startupRepair, null, 'ready startup repair');
  exact(event.runtimeBuildManifestDigest, runtimeManifestDigest, 'ready runtime manifest');
  requiredString(event.peerId, 'ready peer ID');
  const multiaddr = requiredString(event.multiaddr, 'ready multiaddr');
  if (!multiaddr.includes('/tcp/')) throw new Error('ready multiaddr is not TCP');
}

export async function connectGate2HarnessAgentsV1(
  author: Gate2AgentChild,
  receiver: Gate2AgentChild,
  authorReady: Gate2AgentEvent,
  receiverReady: Gate2AgentEvent,
  label: string,
): Promise<void> {
  await Promise.all([
    receiver.request('dial', `${label}-receiver-dial-author-v1`, 'dialed', {
      multiaddr: authorReady.multiaddr,
      peerId: authorReady.peerId,
    }),
    author.request('dial', `${label}-author-dial-receiver-v1`, 'dialed', {
      multiaddr: receiverReady.multiaddr,
      peerId: receiverReady.peerId,
    }),
  ]);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is missing`);
  return value;
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} differs from expected`);
}
