/**
 * Test helper for reading the shared Hardhat context written by
 * hardhat-global-setup.ts and creating EVMChainAdapter instances.
 *
 * All test files across chain, publisher, agent, and CLI packages
 * use these helpers for real-chain integration testing via Hardhat.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { makeAdapterConfig, HARDHAT_KEYS } from './hardhat-harness.js';

export interface SharedHardhatContext {
  rpcUrl: string;
  hubAddress: string;
  coreProfileId: number;
  receiverIds: number[];
  baseSnapshotId: string;
}

export function contextFilePath(): string {
  const port = process.env.HARDHAT_PORT || '9545';
  return join(tmpdir(), `dkg-hardhat-ctx-${port}.json`);
}

let _cached: SharedHardhatContext | null = null;

export function getSharedContext(): SharedHardhatContext {
  if (!_cached) {
    _cached = JSON.parse(readFileSync(contextFilePath(), 'utf8'));
  }
  return _cached!;
}

let _sharedProvider: JsonRpcProvider | null = null;

export function createProvider(): JsonRpcProvider {
  if (!_sharedProvider) {
    const { rpcUrl } = getSharedContext();
    _sharedProvider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  }
  return _sharedProvider;
}

/**
 * Create a real EVMChainAdapter backed by the shared Hardhat node.
 */
export function createEVMAdapter(privateKey: string = HARDHAT_KEYS.CORE_OP): EVMChainAdapter {
  const { rpcUrl, hubAddress } = getSharedContext();
  return new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, privateKey));
}

/**
 * Take a snapshot of the current EVM state. Call revertSnapshot() later
 * to restore. Use in beforeAll/afterAll for per-file isolation.
 */
export async function takeSnapshot(): Promise<string> {
  const provider = createProvider();
  return provider.send('evm_snapshot', []);
}

/**
 * Revert to a previously taken snapshot.
 */
export async function revertSnapshot(snapshotId: string): Promise<void> {
  const provider = createProvider();
  await provider.send('evm_revert', [snapshotId]);
}

/**
 * Revert to the base snapshot (taken after initial deploy + profile setup).
 * Useful for resetting chain state between test files.
 */
export async function revertToBase(): Promise<void> {
  const { baseSnapshotId } = getSharedContext();
  await revertSnapshot(baseSnapshotId);
}

/**
 * Create an on-chain context graph for testing. Returns the numeric
 * context graph ID assigned by the ContextGraphs contract.
 *
 * Must be called after the Hardhat node is running and contracts deployed.
 */
export async function createTestContextGraph(
  chain?: EVMChainAdapter,
  identityId?: bigint,
): Promise<bigint> {
  const adapter = chain ?? createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const id = identityId ?? BigInt(getSharedContext().coreProfileId);
  const result = await adapter.createOnChainContextGraph({
    participantIdentityIds: [id],
    requiredSignatures: 1,
    publishPolicy: 0,
  });
  if (!result.success || result.contextGraphId === 0n) {
    throw new Error(`Failed to create on-chain context graph: ${JSON.stringify(result)}`);
  }
  return result.contextGraphId;
}

/**
 * Seed a triple-store with the registration metadata that the publisher
 * checks before allowing `publishFromSharedMemory`. Call this in
 * beforeEach when using publishFromSharedMemory with a real chain.
 */
export async function seedContextGraphRegistration(
  store: { insert: (quads: Array<{ subject: string; predicate: string; object: string; graph: string }>) => Promise<void> },
  contextGraphId: string,
): Promise<void> {
  const metaUri = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const dataUri = `did:dkg:context-graph:${contextGraphId}`;
  await store.insert([{
    subject: dataUri,
    predicate: 'https://dkg.network/ontology#registrationStatus',
    object: '"registered"',
    graph: metaUri,
  }]);
}

export { HARDHAT_KEYS, makeAdapterConfig } from './hardhat-harness.js';
