import { mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { multiaddr } from '@multiformats/multiaddr';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import {
  GATE1_ADAPTER_PROTOCOL_VERSION,
  GATE1_AGENT_EVENT_PREFIX,
  GATE1_REAL_DKG_AGENT_ADAPTER_ID,
  type Gate1ProductionAdapterOperation,
} from './model.js';
import {
  inspectGate1ProductCapabilities,
  requireGate1ProductMethod,
} from './product-capabilities.js';

const role = process.argv[2];
const dataDirInput = process.env.DKG_RFC64_GATE1_ADAPTER_DATA_DIR;
const masterKeyHex = process.env.DKG_RFC64_GATE1_AGENT_MASTER_KEY_HEX;
if (role !== 'author' && role !== 'receiver') throw new Error('adapter role is required');
if (!dataDirInput) throw new Error('DKG_RFC64_GATE1_ADAPTER_DATA_DIR is required');
if (!masterKeyHex || !/^[0-9a-f]{64}$/u.test(masterKeyHex)) {
  throw new Error('DKG_RFC64_GATE1_AGENT_MASTER_KEY_HEX must be 32 lowercase hex bytes');
}

const dataDir = resolve(dataDirInput);
const pinnedMasterKeyHex = masterKeyHex;
let agent: DKGAgent | undefined;
let stopping = false;
let commandTail = Promise.resolve();

interface Command {
  readonly command: string;
  readonly input?: unknown;
  readonly requestId: string;
}

function emit(event: Record<string, unknown>): void {
  const line = JSON.stringify({ role, ...event });
  if (Buffer.byteLength(line) > 1_000_000) {
    throw new Error('Gate 1 adapter event exceeds the 1 MiB process-protocol bound');
  }
  process.stdout.write(`${GATE1_AGENT_EVENT_PREFIX}${line}\n`);
}

async function emitAndFlush(event: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ role, ...event });
  if (Buffer.byteLength(line) > 1_000_000) {
    throw new Error('Gate 1 adapter event exceeds the 1 MiB process-protocol bound');
  }
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(`${GATE1_AGENT_EVENT_PREFIX}${line}\n`, (error) => {
      if (error === null || error === undefined) resolveWrite();
      else rejectWrite(error);
    });
  });
}

async function ensureDeterministicAgentKey(): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, 'agent-key.bin');
  const expected = Buffer.from(pinnedMasterKeyHex, 'hex');
  try {
    const handle = await open(keyPath, 'wx', 0o600);
    try {
      await handle.writeFile(expected);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    const existing = await readFile(keyPath);
    if (!existing.equals(expected)) {
      throw new Error('existing DKGAgent master key differs from the role-pinned harness key');
    }
  }
}

async function boot(): Promise<void> {
  await ensureDeterministicAgentKey();
  const created = await DKGAgent.create({
    name: `RFC64Gate1${role}`,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(join(dataDir, 'store.nq')),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
  });
  agent = created;
  await created.start();
  const tcp = created.multiaddrs.find((address) => address.includes('/tcp/'));
  if (tcp === undefined) throw new Error('real DKGAgent exposed no TCP multiaddr');
  emit({
    adapterId: GATE1_REAL_DKG_AGENT_ADAPTER_ID,
    agentClass: created.constructor.name,
    capabilities: inspectGate1ProductCapabilities(created),
    catalogServiceStarted: created.rfc64PublicCatalogStatsV1()?.started === true,
    event: 'ready',
    multiaddr: tcp,
    peerId: created.peerId,
    protocolVersion: GATE1_ADAPTER_PROTOCOL_VERSION,
    startupRepair: null,
  });
}

async function handle(command: Command): Promise<void> {
  if (typeof command.requestId !== 'string' || command.requestId.length === 0) {
    throw new Error('requestId is required');
  }
  const currentAgent = requireAgent();
  switch (command.command) {
    case 'dial': {
      const input = plainRecord(command.input, 'dial input');
      const address = requiredString(input.multiaddr, 'dial.multiaddr');
      const expectedPeerId = requiredString(input.peerId, 'dial.peerId');
      const connection = await currentAgent.node.libp2p.dial(multiaddr(address));
      const connectedPeerId = connection.remotePeer.toString();
      if (connectedPeerId !== expectedPeerId) {
        throw new Error(`dial connected to ${connectedPeerId}, expected ${expectedPeerId}`);
      }
      emit({ event: 'dialed', peerId: connectedPeerId, requestId: command.requestId });
      return;
    }
    case 'acceptOpenPolicy': {
      const accepted = currentAgent.acceptOpenContextGraphPolicyV1(
        plainRecord(command.input, 'acceptOpenPolicy input') as never,
      );
      emit({
        event: 'operation-completed',
        operation: command.command,
        output: accepted,
        requestId: command.requestId,
      });
      return;
    }
    case 'publishGenesis':
    case 'publishSuccessor': {
      requireRole('author');
      const input = plainRecord(command.input, `${command.command} input`);
      const authorPrivateKey = requiredString(
        input.authorPrivateKey,
        `${command.command}.authorPrivateKey`,
      );
      const author = new ethers.Wallet(authorPrivateKey);
      const forwarded: Record<string, unknown> = { ...input, author };
      delete forwarded.authorPrivateKey;
      // Publication and announcement are separate frozen operations. Genesis's
      // legacy combined API is driven with an empty peer set to preserve that boundary.
      if (command.command === 'publishGenesis') forwarded.peers = [];
      if (typeof forwarded.projectionNQuads === 'string') {
        forwarded.projectionBytes = new TextEncoder().encode(forwarded.projectionNQuads);
        delete forwarded.projectionNQuads;
      }
      const method = requireGate1ProductMethod(currentAgent, command.command);
      const output = await method(forwarded);
      emitOperationResult(command, output);
      return;
    }
    case 'announce':
    case 'appliedHeadReadback':
    case 'exactInventoryReadback': {
      const requiredRole = command.command === 'announce' ? 'author' : 'receiver';
      requireRole(requiredRole);
      const method = requireGate1ProductMethod(
        currentAgent,
        command.command as Exclude<Gate1ProductionAdapterOperation, 'killRestart'>,
      );
      const output = await method(plainRecord(command.input, `${command.command} input`));
      emitOperationResult(command, output);
      return;
    }
    case 'awaitReceiverIdle':
      requireRole('receiver');
      await currentAgent.whenRfc64PublicCatalogReceiverIdleV1();
      emit({ event: 'receiver-idle', requestId: command.requestId });
      return;
    case 'killRestart':
      requireRole('receiver');
      // The parent process owns SIGKILL and replacement. This command only
      // establishes an explicit process-protocol boundary; it creates no fake
      // repair record and intentionally does not stop the DKGAgent.
      emit({ event: 'kill-restart-ready', requestId: command.requestId });
      return;
    case 'stop':
      await stop(0, command.requestId);
      return;
    default:
      throw new Error(`unknown adapter command: ${command.command}`);
  }
}

function emitOperationResult(command: Command, output: unknown): void {
  assertJsonWireValue(output, `${command.command} output`);
  emit({
    event: 'operation-completed',
    operation: command.command,
    output,
    requestId: command.requestId,
  });
}

function assertJsonWireValue(value: unknown, path: string, depth = 0): void {
  if (depth > 32) throw new Error(`${path} exceeds the adapter JSON depth bound`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error(`${path} exceeds the adapter array bound`);
    value.forEach((entry, index) => assertJsonWireValue(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonWireValue(entry, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`${path} is not a bounded plain JSON value`);
}

async function stop(exitCode: number, requestId?: string): Promise<never> {
  if (stopping) return await new Promise<never>(() => undefined);
  stopping = true;
  try {
    await agent?.stop();
    if (requestId !== undefined) {
      await emitAndFlush({ event: 'stopped', requestId });
    }
    process.exit(exitCode);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

function requireAgent(): DKGAgent {
  if (agent === undefined) throw new Error('real DKGAgent is not ready');
  return agent;
}

function requireRole(expected: 'author' | 'receiver'): void {
  if (role !== expected) throw new Error(`${role} cannot handle ${expected} operation`);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

process.once('SIGTERM', () => { void stop(0); });
process.once('SIGINT', () => { void stop(130); });

await boot().catch(async (error) => {
  emit({ event: 'boot-failed', message: error instanceof Error ? error.message : String(error) });
  await stop(1);
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (Buffer.byteLength(line) > 1_000_000) {
    emit({ event: 'error', message: 'command exceeds the 1 MiB process-protocol bound' });
    return;
  }
  let command: Command;
  try {
    command = JSON.parse(line) as Command;
  } catch (error) {
    emit({ event: 'error', message: `invalid command JSON: ${String(error)}` });
    return;
  }
  commandTail = commandTail.then(() => handle(command)).catch((error) => {
    emit({
      event: 'error',
      message: error instanceof Error ? error.message : String(error),
      requestId: command.requestId,
    });
  });
});
lines.once('close', () => { void stop(0); });
