/**
 * E2E: a node whose host locale differs from the one that wrote a Shared
 * Working Memory snapshot still accepts it.
 *
 * Two real agents over real libp2p on the shared Hardhat chain. Node A writes
 * public quads to Shared Working Memory on an en-US host and records the digest
 * of the snapshot it persisted. Node B subscribes AFTER the write, so it must
 * catch the data up from A, and verifies each snapshot against the digest A
 * advertised. B runs on a da-DK host (`useAmbientCollation`), whose own digest
 * of the very same quads is a different string: before the dual-accept change B
 * rejected the snapshot as corrupt and never held the data.
 *
 * The rows are chosen so their canonical order really differs between the
 * two collations (`aa` sorts after `z` in da-DK), asserted below.
 *
 * Both agents live in one process, so the simulated da-DK collation is
 * process-wide: node A also computes under it while B catches up. The test
 * therefore proves the pair converges only with the dual-accept change; it does
 * not isolate B's verifier from A's serving path (the child-process e2e in the
 * publisher package and the devnet suite give each node its own real locale).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { DKGAgent as RealDKGAgent } from '../src/index.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { TEST_SNAPSHOT_CONFIG } from '../../../scripts/testing/snapshot-storage.js';
import { divergentObjectQuads, referenceDigest, useAmbientCollation } from '../../../scripts/testing/digest-locale.js';

type DKGAgent = RealDKGAgent;
const DKGAgent = {
  create(config: Parameters<typeof RealDKGAgent.create>[0]) {
    return RealDKGAgent.create({ rfc64CatalogActivation: { enabled: false }, ...config });
  },
};

const CONTEXT_GRAPH = 'swm-digest-locale-e2e';
const ROOT = 'urn:e2e:swm-digest-locale:root';
const NAME = 'https://schema.org/name';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 90_000,
  stepMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!done(last) && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

async function sharedMemoryObjects(agent: DKGAgent): Promise<string[]> {
  const result = await agent.query(
    `SELECT ?o WHERE { <${ROOT}> <${NAME}> ?o }`,
    { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
  ).catch(() => ({ bindings: [] as Array<Record<string, unknown>> }));
  return result.bindings.map((row) => String(row['o'])).sort();
}

/** Digests (file names) under a node's snapshot directory. */
async function snapshotDigests(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.nq')) found.push(`sha256:${entry.name.slice(0, -'.nq'.length)}`);
    }
  };
  await walk(join(directory, 'swm-public-snapshots'));
  return found.sort();
}

let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

describe('SWM digest across host locales (2 real agents)', () => {
  const quads = divergentObjectQuads(ROOT, NAME);
  const enUS = referenceDigest(quads, 'en-US');
  const daDK = referenceDigest(quads, 'da-DK');
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let dirA: string;
  let dirB: string;

  beforeAll(async () => {
    dirA = await mkdtemp(join(tmpdir(), 'dkg-e2e-digest-a-'));
    dirB = await mkdtemp(join(tmpdir(), 'dkg-e2e-digest-b-'));
  });

  afterAll(async () => {
    await nodeA?.stop().catch(() => {});
    await nodeB?.stop().catch(() => {});
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('uses rows whose digest depends on the host locale', () => {
    expect(enUS).not.toBe(daDK);
  });

  it('node B, on a da-DK host, catches up what an en-US node A shared and keeps the advertised digest', async () => {
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'DigestLocaleA',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
      dataDir: dirA,
      ...TEST_SNAPSHOT_CONFIG,
    });
    nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'DigestLocaleB',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
      dataDir: dirB,
      ...TEST_SNAPSHOT_CONFIG,
    });
    await nodeA.start();
    await nodeB.start();
    await sleep(800);
    await nodeB.connectTo(nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    await sleep(500);

    await nodeA.createContextGraph({
      id: CONTEXT_GRAPH,
      name: 'SWM digest locale E2E',
      description: 'Digest forms across host locales',
    });
    await nodeA.registerContextGraph(CONTEXT_GRAPH);
    await nodeA.share(CONTEXT_GRAPH, quads);
    expect(await sharedMemoryObjects(nodeA)).toHaveLength(quads.length);
    // Node A persisted its snapshot under its own (en-US) digest.
    expect(await snapshotDigests(dirA)).toEqual([enUS]);

    // Node B joins now, on a da-DK host: it must verify A's advertised digest.
    const restore = useAmbientCollation('da-DK');
    try {
      nodeB.subscribeToContextGraph(CONTEXT_GRAPH);
      const objects = await pollUntil(() => sharedMemoryObjects(nodeB), (rows) => rows.length >= quads.length);
      expect(objects).toHaveLength(quads.length);
    } finally {
      restore();
    }
    // The snapshot is stored under the digest node A advertised, not under the
    // da-DK digest B would compute for the same bytes.
    expect(await snapshotDigests(dirB)).toEqual([enUS]);
  }, 180_000);
});
