// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { multiaddr } from '@multiformats/multiaddr';
import { sealExecutedRuntimeManifestV1 } from '../../../../devnet/rfc64-runtime-load-hook.mts';
import {
  RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1,
  childCommandDescriptorV1,
  defineChildCommandHandlersV1,
  dispatchChildCommandV1,
} from './child-protocol.mjs';
import { emitAuthoritativeRuntimeShutdownReceiptV1 } from './runtime-shutdown.mjs';
import { createRfc64PrivateFaultProfileV1 } from './fault-injection.mjs';
import {
  createRfc64PrivateFinalizedRuntimeV1,
  createRfc64PrivateProbeRuntimeV1,
} from './agent-runtime-factory.mjs';
import {
  publishCatalogBaselineV1,
  publishCatalogUpdateV1,
} from './catalog-publication-handlers.mjs';
import {
  inspectPrivateCatalogV1,
  provePrivateCatalogDeniedV1,
  waitForBootstrapV1,
} from './catalog-evidence-handlers.mjs';
import {
  observeReceiverRevocationV1,
  revokeReceiverV1,
} from './catalog-authority-handlers.mjs';
import { boundedErrorChainV1 } from './bounded-error.mjs';

const ROLE = requiredEnv('DKG_RFC64_PRIVATE_ROLE');
const MODE = requiredEnv('DKG_RFC64_PRIVATE_MODE');
const DATA_DIR = requiredEnv('DKG_RFC64_PRIVATE_DATA_DIR');
const RUNTIME_MANIFEST_DIGEST = requiredEnv('DKG_RFC64_RUNTIME_MANIFEST_DIGEST');
const MANIFEST_PATH = process.env.DKG_RFC64_PRIVATE_MANIFEST;
let runtime;
let childCommandHandlers;
let stopping = false;

function emit(event, requestId, fields = {}) {
  process.stdout.write(`RFC64_PRIVATE_EVENT ${JSON.stringify({
    event,
    role: ROLE,
    ...(requestId === undefined ? {} : { requestId }),
    ...fields,
  })}\n`);
}

async function boot() {
  const faultProfile = createRfc64PrivateFaultProfileV1(process.env);
  if (MODE === 'probe') {
    runtime = await createRfc64PrivateProbeRuntimeV1({
      dataDir: DATA_DIR,
      faultProfile,
      role: ROLE,
    });
    childCommandHandlers = createChildCommandHandlersV1(runtime);
    emit(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready, undefined, readyFields(runtime));
    return;
  }
  if (MODE !== 'run' || MANIFEST_PATH === undefined) {
    throw new Error('runtime mode requires a manifest');
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  runtime = await createRfc64PrivateFinalizedRuntimeV1({
    dataDir: DATA_DIR,
    faultProfile,
    manifest,
    role: ROLE,
  });
  childCommandHandlers = createChildCommandHandlersV1(runtime);
  emit(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready, undefined, readyFields(runtime));
}

function readyFields(context) {
  const address = context.agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return {
    agentClass: context.agent.constructor.name,
    peerId: context.agent.peerId,
    multiaddr: address,
    catalogServiceStarted: context.agent.rfc64PublicCatalogStatsV1()?.started === true,
    runtimeBuildManifestDigest: RUNTIME_MANIFEST_DIGEST,
    ...(context.kind !== 'run' ? {} : {
      authoritySource: context.initialFinalizedAuthority.source,
      authorityPolicyDigest: context.initialFinalizedAuthority.policyDigest,
      authorityRosterVersion: context.initialFinalizedAuthority.roster.version,
      authorityMembers: context.initialFinalizedAuthority.roster.members.map(
        ({ agentAddress }) => agentAddress,
      ),
    }),
  };
}

async function handle(command) {
  if (childCommandHandlers === undefined) throw new Error('child runtime is not ready');
  const { descriptor } = await dispatchChildCommandV1(
    childCommandHandlers,
    command,
    emit,
  );
  if (descriptor.command === 'stop') {
    await shutdown(0, command.requestId, descriptor.responseEvent);
  }
}

function createChildCommandHandlersV1(context) {
  return defineChildCommandHandlersV1({
    dial: async (command) => {
      await context.agent.node.libp2p.dial(multiaddr(command.multiaddr));
      return { peerId: command.peerId };
    },
    publish: () => publishCatalogBaselineV1(context),
    'publish-update': () => publishCatalogUpdateV1(context),
    'wait-bootstrap': (command) => waitForBootstrapV1(context, command),
    inspect: (command) => inspectPrivateCatalogV1(context, command.expectedHeadDigest),
    'inspect-persisted': (command) => inspectPrivateCatalogV1(
      context,
      command.expectedHeadDigest,
      { includeNonmemberQuery: false },
    ),
    'sync-denied': (command) => provePrivateCatalogDeniedV1(context, command),
    'revoke-receiver': () => revokeReceiverV1(context),
    'observe-receiver-revocation': () => observeReceiverRevocationV1(context),
    stop: async () => Object.freeze({}),
  });
}

async function shutdown(
  code,
  requestId,
  responseEvent = childCommandDescriptorV1({ cmd: 'stop' }).responseEvent,
) {
  if (stopping) return;
  stopping = true;
  if (runtime === undefined) {
    process.exit(code);
    return;
  }
  await emitAuthoritativeRuntimeShutdownReceiptV1({
    agent: runtime.agent,
    rpc: runtime.rpc,
    sealExecutedRuntimeManifest: sealExecutedRuntimeManifestV1,
    emitReceipt: (fields) => emitAndFlush(responseEvent, requestId, fields),
  });
  process.exit(code);
}

function emitAndFlush(event, requestId, fields = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`RFC64_PRIVATE_EVENT ${JSON.stringify({
      event,
      role: ROLE,
      ...(requestId === undefined ? {} : { requestId }),
      ...fields,
    })}\n`, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

process.on('SIGTERM', () => { void shutdown(0); });
process.on('SIGINT', () => { void shutdown(130); });

const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    emit('command-error', undefined, { message: 'invalid command JSON' });
    return;
  }
  handle(command).catch((error) => {
    emit('command-error', command.requestId, {
      message: boundedErrorChainV1(error),
    });
  });
});

boot().catch((error) => {
  emit('boot-failed', undefined, {
    message: boundedErrorChainV1(error),
  });
  void shutdown(1);
});
