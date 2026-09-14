import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import {
  type FinalizationRecoveryStore,
  type FinalizationRecoveryStoreFactory,
} from '../src/index.js';
import {
  bindAndSubscribePublicContextGraph,
  createPublishProtocolAgent,
  pollUntil,
  sleep,
  stageRootlessAssertion,
  type PublishProtocolAgent,
} from './_helpers/publish-protocol.js';
import { openSqliteFinalizationRecoveryStore } from
  '../src/finalization-recovery-sqlite-store.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { setMinimumRequiredSignatures } from '../../chain/test/hardhat-harness.js';

function boundedFinalizationRecoveryStoreFactory(
  capture: (store: FinalizationRecoveryStore) => void,
): FinalizationRecoveryStoreFactory {
  return async (dataDir: string): Promise<FinalizationRecoveryStore> => {
    const store = await openSqliteFinalizationRecoveryStore(dataDir, { maxEntries: 1 });
    capture(store);
    return store;
  };
}

async function fillFinalizationRecoveryInbox(
  store: FinalizationRecoveryStore,
  prefix: string,
): Promise<string> {
  const key = `${prefix}-capacity`;
  const result = await store.receive({
    key,
    chainId: 'evm:31337',
    contextGraphId: `${prefix}-filler-graph`,
    sourcePeerId: `${prefix}-filler-peer`,
    ual: `did:dkg:evm:31337/0x${'11'.repeat(20)}/1`,
    txHash: `0x${'01'.padStart(64, '0')}`,
    assertionVersion: '1',
    merkleRoot: `0x${'22'.repeat(32)}`,
    kaId: '1',
    batchId: '1',
    rawMessage: new Uint8Array([1]),
  });
  expect(result.status).toBe('inserted');
  await expect(store.health()).resolves.toMatchObject({
    degradedReason: 'capacity-exhausted',
    stateCounts: { RECEIVED: 1 },
    deferredEntries: 0,
  });
  return key;
}

interface CapacityRecoveryReceiver {
  readonly node: PublishProtocolAgent;
  readonly store: FinalizationRecoveryStore;
  fillInbox(): Promise<void>;
  releaseCapacity(): Promise<void>;
  close(): Promise<void>;
}

async function createCapacityRecoveryReceiver(
  name: string,
  privateKey: string,
  prefix: string,
): Promise<CapacityRecoveryReceiver> {
  const dataDir = await mkdtemp(join(tmpdir(), `dkg-2091-${prefix}-`));
  const captured: { store?: FinalizationRecoveryStore } = {};
  let node: PublishProtocolAgent | undefined;
  try {
    node = await createPublishProtocolAgent({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name,
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(privateKey),
      nodeRole: 'core',
      dataDir,
      finalizationRecoveryStoreFactory: boundedFinalizationRecoveryStoreFactory(
        (store) => { captured.store = store; },
      ),
      storeConfig: { backend: 'oxigraph' },
      syncOnConnectEnabled: false,
    });
    await node.start();
    const store = captured.store;
    if (store === undefined) throw new Error(`Recovery store factory was not invoked for ${name}`);
    let fillerKey: string | undefined;
    return {
      node,
      store,
      async fillInbox() {
        if (fillerKey !== undefined) throw new Error(`${name} inbox is already filled`);
        fillerKey = await fillFinalizationRecoveryInbox(store, prefix);
      },
      async releaseCapacity() {
        if (fillerKey === undefined) throw new Error(`${name} inbox was not filled`);
        await expect(store.transition(fillerKey, 0, 'SUPERSEDED')).resolves.toBe(true);
      },
      async close() {
        try {
          await node.stop();
        } finally {
          await rm(dataDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try { await node?.stop(); } catch {}
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

interface CapacityRecoveryReceiverSpec {
  readonly name: string;
  readonly privateKey: string;
  readonly prefix: string;
}

type CapacityRecoveryReceiverFactory = (
  name: string,
  privateKey: string,
  prefix: string,
) => Promise<CapacityRecoveryReceiver>;

async function createCapacityRecoveryReceivers(
  specs: readonly CapacityRecoveryReceiverSpec[],
  createReceiver: CapacityRecoveryReceiverFactory = createCapacityRecoveryReceiver,
): Promise<CapacityRecoveryReceiver[]> {
  const created: CapacityRecoveryReceiver[] = [];
  try {
    for (const spec of specs) {
      created.push(await createReceiver(spec.name, spec.privateKey, spec.prefix));
    }
    return created;
  } catch (error) {
    await Promise.allSettled(created.map((receiver) => receiver.close()));
    throw error;
  }
}

describe('capacity recovery receiver setup', () => {
  it('closes earlier receivers when a later factory call fails', async () => {
    const close = vi.fn(async () => undefined);
    const first: CapacityRecoveryReceiver = {
      node: undefined!,
      store: undefined!,
      fillInbox: async () => undefined,
      releaseCapacity: async () => undefined,
      close,
    };
    const setupFailure = new Error('second receiver setup failed');
    const createReceiver = vi.fn<CapacityRecoveryReceiverFactory>(async (name) => {
      if (name === 'second') throw setupFailure;
      return first;
    });

    await expect(createCapacityRecoveryReceivers([
      { name: 'first', privateKey: 'first-key', prefix: 'first-prefix' },
      { name: 'second', privateKey: 'second-key', prefix: 'second-prefix' },
    ], createReceiver)).rejects.toBe(setupFailure);

    expect(createReceiver).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('E2E: acknowledged-core finalization recovery at inbox capacity', () => {
  const contextGraphId = 'publish-protocol-capacity-recovery-e2e';
  let nodeA: PublishProtocolAgent;
  const receivers: CapacityRecoveryReceiver[] = [];
  let describeSnapshot: string | undefined;

  beforeAll(async () => {
    describeSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    await setMinimumRequiredSignatures(
      createProvider(),
      hubAddress,
      HARDHAT_KEYS.DEPLOYER,
      2,
    );
    nodeA = await createPublishProtocolAgent({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'CapacityPublisher',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });
    receivers.push(...await createCapacityRecoveryReceivers([
      { name: 'CapacityCoreB', privateKey: HARDHAT_KEYS.REC1_OP, prefix: 'core-b' },
      { name: 'CapacityCoreC', privateKey: HARDHAT_KEYS.REC2_OP, prefix: 'core-c' },
    ]));
    await nodeA.start();
    await sleep(800);
    const addrA = nodeA.multiaddrs.find(
      (address) => address.includes('/tcp/') && !address.includes('/p2p-circuit'),
    )!;
    await Promise.all(receivers.map(({ node }) => node.connectTo(addrA)));
    await sleep(2_000);
    expect(nodeA.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(2);
    await nodeA.createContextGraph({
      id: contextGraphId,
      name: 'Capacity Recovery E2E',
      description: '',
    });
    const registration = await nodeA.registerContextGraph(contextGraphId);
    await bindAndSubscribePublicContextGraph(nodeA, contextGraphId, registration.onChainId);
    await Promise.all(receivers.map(({ node }) =>
      bindAndSubscribePublicContextGraph(node, contextGraphId, registration.onChainId)));
    await sleep(1_500);
  }, 30_000);

  afterAll(async () => {
    try {
      try { await nodeA?.stop(); } catch {}
      await Promise.all(receivers.map(async (receiver) => {
        try { await receiver.close(); } catch {}
      }));
    } finally {
      if (describeSnapshot !== undefined) await revertSnapshot(describeSnapshot);
    }
  });

  it('makes a KA readable by UAL on every ACK core after both full inboxes drain', async () => {
    const subject = 'urn:protocol:entity:capacity-recovery';
    const object = '"Recovered after capacity"';
    await stageRootlessAssertion(nodeA, contextGraphId, 'capacity-recovery', [{
      subject,
      predicate: 'http://schema.org/name',
      object,
    }]);
    await Promise.all(receivers.map(async ({ node }) => {
      const sharedMemory = await pollUntil(
        () => node.query(
          `SELECT ?name WHERE { <${subject}> <http://schema.org/name> ?name }`,
          { contextGraphId, graphSuffix: '_shared_memory' },
        ),
        (bindings) => bindings.some((binding) => binding.name === object),
        15_000,
      );
      expect(sharedMemory).toContainEqual({ name: object });
      await node.getOrCreateFinalizationHandler().stopRecoveryWorker();
    }));
    const settledBaselines = await Promise.all(receivers.map(async ({ store }) =>
      (await store.health()).stateCounts.SETTLED ?? 0));
    await Promise.all(receivers.map((receiver) => receiver.fillInbox()));
    const result = await nodeA.publishFromFinalizedAssertion(
      contextGraphId,
      'capacity-recovery',
      { clearSharedMemoryAfter: true },
    );
    expect(result.status).toBe('confirmed');
    expect(new Set(result.v10ACKs?.map((ack) => ack.peerId))).toEqual(new Set(
      receivers.map(({ node }) => node.peerId),
    ));
    await Promise.all(receivers.map(async ({ node }) => {
      await expect.poll(
        () => node.getFinalizationRecoveryHealth(),
        { timeout: 10_000 },
      ).toMatchObject({
        degradedReason: 'capacity-exhausted',
        stateCounts: { RECEIVED: 1 },
        deferredEntries: 1,
      });
    }));
    await Promise.all(receivers.map((receiver) => receiver.releaseCapacity()));
    for (const { node } of receivers) node.getOrCreateFinalizationHandler().startRecoveryWorker();
    await Promise.all(receivers.map(async ({ node }, index) => {
      await expect.poll(
        () => nodeA.lookupEntity(node.peerId, result.ual),
        { timeout: 20_000, interval: 500 },
      ).toMatchObject({
        status: 'OK',
        resultCount: 1,
        ntriples: expect.stringContaining(
          `<${subject}> <http://schema.org/name> ${object} .`,
        ),
      });
      await expect(node.getFinalizationRecoveryHealth()).resolves.toMatchObject({
        stateCounts: { SETTLED: settledBaselines[index]! + 1 },
        deferredEntries: 0,
      });
    }));
  }, 90_000);
});
