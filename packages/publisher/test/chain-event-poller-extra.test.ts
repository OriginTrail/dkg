/**
 * ChainEventPoller edge-case coverage (spec §5.1 / §6).
 *
 * NO BLOCKCHAIN MOCKS. Every test uses the real `EVMChainAdapter`
 * wired to the shared Hardhat node spun up by
 * `packages/chain/test/hardhat-global-setup.ts` (port 9546 for publisher).
 * Events are produced by real V10 contract calls
 * (`createOnChainContextGraph` → `ContextGraphCreated` on
 * `ContextGraphStorage`). Block ranges are advanced using real
 * `hardhat_mine` RPC so cursor / MAX_RANGE behaviour is exercised
 * against genuine on-chain block numbers.
 *
 * This file was migrated from the V9 NameClaimed flow (which depended on
 * the now-archived `ContextGraphNameRegistry.createContextGraph` surface)
 * to the V10 `createOnChainContextGraph` path that emits
 * `ContextGraphCreated`. The poller dispatches both NameClaimed and
 * ContextGraphCreated to `onContextGraphCreated`, so this rewire
 * preserves the original behavioural assertions verbatim.
 *
 * This file covers:
 *   - cursor persistence across restart (load + advance)
 *   - load() errors are non-fatal
 *   - live context graph tail starts near the chain head
 *   - pending publishes do not force unrelated context graph backfill
 *   - historical context graph recovery is left to the daemon chain scan
 *   - callback failures must NOT abort the poll (fault isolation)
 *   - double-start() is a no-op (no duplicate timers)
 *   - stop() is idempotent and clears the interval
 *
 * ======================================================================
 * SPEC-GAP SG-6 (carried forward from the original V9 migration, now
 * PARTLY CLOSED — see the last describe in this file):
 *   The real `EVMChainAdapter.listenForEvents()` used to yield none of
 *   `KnowledgeAssetUpdated`, `AllowListUpdated`, `ProfileCreated`,
 *   `ProfileUpdated`, though `ChainEventPoller` declared a callback slot
 *   for each — four dead code paths in production.
 *   #2435 closed the first one: the adapter now yields all four KA
 *   root-mutation events and the `kaRootMutations` lane dispatches them,
 *   so that row is a POSITIVE end-to-end test. The remaining three are
 *   still unserved and still pinned.
 * ======================================================================
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import {
  createEVMAdapter as _createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import {
  ChainEventPoller,
  type ChainEventPollerLane,
  type CursorPersistence,
  type LaneCursorPersistence,
  type LegacyCursorPersistence,
} from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';

// Track adapters across the file so afterEach can release their HTTP
// keep-alive sockets. Without this, every `createEVMAdapter()` leaks a
// `JsonRpcProvider` whose idle TCP socket eventually gets reset by
// Hardhat (during subsequent test files' load), surfacing as a
// `TCP.onStreamRead ECONNRESET` unhandled rejection attributed back
// to whichever test happened to be running when Node fired it. In CI
// this manifested as 40k+ unhandled rejections per `publisher [2/4]`
// shard. The poller-side fix (await-in-flight-poll + serialize ticks)
// catches the on-the-wire case; this catches the "test ended, socket
// still alive" case.
const trackedAdapters: Array<ReturnType<typeof _createEVMAdapter>> = [];
function createEVMAdapter(privateKey?: string): ReturnType<typeof _createEVMAdapter> {
  const adapter = _createEVMAdapter(privateKey);
  trackedAdapters.push(adapter);
  return adapter;
}
afterEach(() => {
  while (trackedAdapters.length > 0) {
    const adapter = trackedAdapters.pop();
    try { (adapter as unknown as { destroy: () => void } | undefined)?.destroy(); } catch { /* idempotent */ }
  }
});

class InMemoryCursor implements LegacyCursorPersistence {
  public saved: number[] = [];
  constructor(public loaded?: number) {}
  async load(): Promise<number | undefined> { return this.loaded; }
  async save(n: number): Promise<void> { this.saved.push(n); }
}

class InMemoryLaneCursor implements LaneCursorPersistence {
  public saved: Array<{ lane: ChainEventPollerLane; block: number }> = [];
  constructor(private readonly loaded = new Map<ChainEventPollerLane, number>()) {}
  async loadLane(lane: ChainEventPollerLane): Promise<number | undefined> { return this.loaded.get(lane); }
  async saveLane(lane: ChainEventPollerLane, block: number): Promise<void> {
    this.saved.push({ lane, block });
    this.loaded.set(lane, block);
  }
}

async function pollOnce(_poller: ChainEventPoller, timeoutMs = 300): Promise<void> {
  // Poller kicks off a first poll synchronously inside start(); we just
  // give the microtask queue + event loop enough headroom for one or
  // more polls against the real RPC.
  await new Promise((r) => setTimeout(r, timeoutMs));
}

/**
 * Mine `count` empty blocks on Hardhat so `chain.getBlockNumber()`
 * returns `head + count`. Used to create large gaps between the poll
 * cursor and the chain head without paying for real transactions.
 */
async function mineBlocks(count: number): Promise<void> {
  const provider = createProvider();
  await provider.send('hardhat_mine', ['0x' + count.toString(16)]);
}

/**
 * Create a V10 on-chain context graph via the ContextGraphs contract.
 * Returns `{ contextGraphId, blockNumber }` mirroring the shape the
 * pre-V10 NameClaimed helper used, so the test bodies need no further
 * adjustments. `ContextGraphCreated` is the event the poller will
 * surface through `onContextGraphCreated`.
 */
async function createV10Cg(chain: ReturnType<typeof createEVMAdapter>): Promise<{ contextGraphId: string; blockNumber: number }> {
  const id = BigInt(getSharedContext().coreProfileId);
  const result = await chain.createOnChainContextGraph({
    accessPolicy: 1,
    publishPolicy: 0,
  });
  if (!result.success || result.contextGraphId === 0n) {
    throw new Error(`createV10Cg failed: ${JSON.stringify(result)}`);
  }
  return { contextGraphId: result.contextGraphId.toString(), blockNumber: result.blockNumber! };
}

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  // Fund CORE_OP with enough TRAC to cover V10 createOnChainContextGraph
  // gas across all tests in this file (each call is its own real tx).
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

describe('ChainEventPoller — cursor persistence', () => {
  it('restores cursor from persistence on start()', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const provider = createProvider();
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    // Emit a real ContextGraphCreated event; capture the exact block number.
    const result = await createV10Cg(chain);
    const eventBlock = result.blockNumber;

    // Persist a cursor one block before the event so restore semantics are
    // observable: the first poll must start at `eventBlock` and pick up
    // the ContextGraphCreated that would otherwise be missed if the cursor
    // reset to 0 (slow / redundant) or to head (skips the event).
    const cursor = new InMemoryLaneCursor(new Map([['contextGraphDiscovery', eventBlock - 1]]));
    const received: Array<{ id: string; blockNumber: number }> = [];

    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 50,
      cursorPersistence: cursor,
      onContextGraphCreated: async (e) => {
        received.push({ id: e.contextGraphId, blockNumber: e.blockNumber });
      },
    });

    await poller.start();
    await pollOnce(poller);
    await poller.stop();

    // Our event must be among the restored-cursor scan results (other
    // tests may have created CGs too — we only care that OURS is picked).
    const mine = received.find((r) => r.blockNumber === eventBlock);
    expect(mine, `expected ContextGraphCreated at block ${eventBlock}; received=${JSON.stringify(received)}`).toBeDefined();

    // Cursor must have advanced past the event block (not regressed).
    const savedBlocks = cursor.saved
      .filter((entry) => entry.lane === 'contextGraphDiscovery')
      .map((entry) => entry.block);
    expect(savedBlocks.length).toBeGreaterThan(0);
    expect(savedBlocks.at(-1)).toBeGreaterThanOrEqual(eventBlock);
    const head = await provider.getBlockNumber();
    expect(savedBlocks.at(-1)).toBeLessThanOrEqual(head);
  }, 30_000);

  it('persists advancing cursor to survive restart', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    const cursor = new InMemoryLaneCursor();

    // Take a snapshot of current head, then emit an event.
    const result = await createV10Cg(chain);
    const eventBlock = result.blockNumber;

    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 50,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* seen */ },
    });

    await poller.start();
    await pollOnce(poller);
    await poller.stop();

    const savedBlocks = cursor.saved
      .filter((entry) => entry.lane === 'contextGraphDiscovery')
      .map((entry) => entry.block);
    expect(savedBlocks.length).toBeGreaterThan(0);
    // Final cursor must cover the block we emitted at.
    expect(savedBlocks.at(-1)).toBeGreaterThanOrEqual(eventBlock);
  }, 30_000);

  it('load() errors are non-fatal (poller still starts)', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    const brokenCursor: CursorPersistence = {
      load: async () => { throw new Error('disk full'); },
      save: async () => { /* ok */ },
    };

    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 50,
      cursorPersistence: brokenCursor,
      onContextGraphCreated: async () => { /* noop */ },
    });

    await expect(poller.start()).resolves.toBeUndefined();
    await poller.stop();
  }, 15_000);
});

describe('ChainEventPoller — context graph live tail', () => {
  it('does not replay old context graph events outside the live tail window', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const provider = createProvider();
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    // Emit a ContextGraphCreated at block B, then mine 1000 empty blocks so
    // the new head is B+1000, putting B well before the seed window (head-500).
    const result = await createV10Cg(chain);
    const oldEventBlock = result.blockNumber;
    await mineBlocks(1000);
    const head = await provider.getBlockNumber();
    expect(head).toBeGreaterThanOrEqual(oldEventBlock + 1000);

    const received: number[] = [];
    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 50,
      onContextGraphCreated: async (e) => { received.push(e.blockNumber); },
    });

    // Context graph event polling is the live tail. Historical recovery runs
    // through DKGAgent.discoverContextGraphsFromChain, not this event lane.
    await poller.start();
    await pollOnce(poller);
    await poller.stop();

    expect(received.includes(oldEventBlock), `old block ${oldEventBlock} should be left to chain discovery (head=${head}); received=${received.join(',')}`).toBe(false);
  }, 45_000);

  it('does not let live pending publishes force context graph backfill from genesis', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const provider = createProvider();
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    // Plant a live pending publish sentinel. The publish lane may become
    // active, but it must not change the context graph lane into a historical
    // backfill lane.
    (handler as unknown as { pendingPublishes: Map<string, unknown> }).pendingPublishes.set(
      'sentinel',
      { expectedMerkleRoot: new Uint8Array(32), restoredFromJournal: false } as never,
    );
    expect(handler.hasPendingPublishes).toBe(true);

    const beforeHead = await provider.getBlockNumber();
    const result = await createV10Cg(chain);
    const earlyBlock = result.blockNumber;
    expect(earlyBlock).toBeGreaterThan(beforeHead);

    // Mine far past the early block so it is outside the context live-tail
    // window.
    await mineBlocks(2000);

    const received: number[] = [];
    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 50,
      onContextGraphCreated: async (e) => { received.push(e.blockNumber); },
    });

    await poller.start();
    await pollOnce(poller, 500);
    await poller.stop();

    expect(received.includes(earlyBlock), `context graph block ${earlyBlock} should be left to chain discovery; received=${received.join(',')}`).toBe(false);
  }, 45_000);

  it('delivers near-head context graph events without walking the historical gap first', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const provider = createProvider();
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    // Live pending publishes must not force unrelated context graph backfill.
    (handler as unknown as { pendingPublishes: Map<string, unknown> }).pendingPublishes.set(
      'sentinel',
      { expectedMerkleRoot: new Uint8Array(32), restoredFromJournal: false } as never,
    );

    // Emit an early event (current head + 1 after this tx).
    const earlyResult = await createV10Cg(chain);
    const earlyBlock = earlyResult.blockNumber;

    // Mine far enough that a genesis backfill would need multiple MAX_RANGE
    // pages before it could reach the fresh event.
    await mineBlocks(10_000);

    // Emit a late event near current head — two events straddle the cap.
    const lateResult = await createV10Cg(chain);
    const lateBlock = lateResult.blockNumber;
    const head = await provider.getBlockNumber();
    expect(head - earlyBlock).toBeGreaterThan(9_000);
    expect(lateBlock).toBeGreaterThan(earlyBlock + 9_000);

    const received: number[] = [];
    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 50,
      onContextGraphCreated: async (e) => { received.push(e.blockNumber); },
    });

    await poller.start();
    // Wait long enough for the live tail to catch the near-head event.
    await pollOnce(poller, 1500);
    await poller.stop();

    // The old event is left to chain discovery; the near-head event is
    // observed promptly.
    expect(received.includes(earlyBlock), `earlyBlock ${earlyBlock} should be left to chain discovery; received=${received.join(',')}`).toBe(false);
    expect(received.includes(lateBlock),  `lateBlock  ${lateBlock}  missing; received=${received.join(',')}`).toBe(true);
  }, 60_000);
});

describe('ChainEventPoller — fault isolation & lifecycle', () => {
  it('a callback that throws does NOT propagate or stop the poll', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    const id1 = (await createV10Cg(chain)).contextGraphId;
    const id2 = (await createV10Cg(chain)).contextGraphId;

    // First event sees a throwing callback; the second must still be
    // delivered → poller's dispatch loop catches and continues.
    let throwerCalls = 0;
    const seen: string[] = [];

    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 50,
      onContextGraphCreated: async (e) => {
        seen.push(e.contextGraphId);
        if (e.contextGraphId === id1) {
          throwerCalls++;
          throw new Error('kaboom');
        }
      },
    });

    await poller.start();
    await pollOnce(poller, 500);
    await poller.stop();

    expect(throwerCalls).toBeGreaterThanOrEqual(1);
    expect(seen).toContain(id1);
    expect(seen).toContain(id2);
  }, 45_000);

  it('stop() is idempotent and clears the interval timer', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      intervalMs: 50,
      onContextGraphCreated: async () => { /* noop */ },
    });

    await poller.start();
    await poller.stop();
    await poller.stop();

    // Re-start succeeds without leaving ghost timers (open-handle warning
    // from vitest would fail the suite if the previous interval leaked).
    await poller.start();
    await poller.stop();
  }, 15_000);

  it('start() is idempotent (calling twice does not create two timers)', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    const result = await createV10Cg(chain);
    const ourId = result.contextGraphId;
    const ourBlock = result.blockNumber;

    // Probe the timer count directly on the internal state. A non-idempotent
    // start() would overwrite `timer` with a second handle, losing the first
    // (still active) interval — observable as a leaked setInterval only on
    // real node runtimes. Here we also check the `running` flag flipped
    // exactly once and that the second start() was a no-op.
    const pollCalls: number[] = [];
    const cursor = new InMemoryLaneCursor(new Map([['contextGraphDiscovery', ourBlock - 1]]));
    const poller = new ChainEventPoller({
      chain,
      publishHandler: handler,
      // Large interval so `setInterval` never fires during this test — any
      // poll observed must come from the synchronous `this.poll()` call
      // inside `start()`. If start() were non-idempotent, we'd see 2.
      intervalMs: 60_000,
      onContextGraphCreated: async (e) => {
        if (e.contextGraphId === ourId && e.blockNumber === ourBlock) {
          pollCalls.push(e.blockNumber);
        }
      },
      cursorPersistence: cursor,
    });

    await poller.start();
    // Capture timer + running snapshot before the second start() call.
    const firstTimer = (poller as unknown as { timer: unknown }).timer;
    const firstRunning = (poller as unknown as { running: boolean }).running;

    await poller.start(); // MUST be a no-op — `running === true` short-circuits
    const secondTimer = (poller as unknown as { timer: unknown }).timer;

    // Give the first (synchronous) poll time to complete its async work.
    await pollOnce(poller, 400);
    await poller.stop();

    // Timer handle must be unchanged after the second start() call — proof
    // that no additional setInterval was scheduled.
    expect(secondTimer).toBe(firstTimer);
    expect(firstRunning).toBe(true);
    // Our event must have been observed exactly once — the synchronous
    // first poll. setInterval's next tick would be at T=60s, so any count
    // above 1 would mean start() double-fired the immediate poll.
    expect(pollCalls.length).toBe(1);
    expect(pollCalls[0]).toBe(ourBlock);
  }, 30_000);
});

/**
 * SG-6, flipped (#2435).
 *
 * The original SG-6 row PINNED the absence of `KnowledgeAssetUpdated` on the
 * real adapter, and instructed its own successor: "if a future PR extends the
 * adapter correctly, rewrite this into a positive coverage test." That PR is
 * this one. What follows is the positive half — the whole path from a real
 * contract emit through the real adapter and the real lane to the callback —
 * plus the residual half of the gap, which is still real.
 */
describe('ChainEventPoller — SG-6 flipped: KA root mutations dispatch end to end', () => {
  it('dispatches all four root-mutation kinds from real contract emits', async () => {
    // Hub owner: `HubDependent._checkHubContract` grants the `onlyContracts`
    // emitters to the Hub owner as well as to registered contracts.
    const chain = createEVMAdapter(HARDHAT_KEYS.DEPLOYER);
    const provider = createProvider();
    await (chain as any).init();

    const hub = (chain as any).contracts.hub;
    const ka = (chain as any).contracts.knowledgeAssetStorage;
    const deployer = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER).address;
    expect(String(await hub.owner()).toLowerCase()).toBe(deployer.toLowerCase());

    // OT-RFC-43: the KA id's high 160 bits must equal the attested author.
    const author = ethers.getAddress('0x6666666666666666666666666666666666666666');
    const kaId = (BigInt(author) << 96n) | 7_777n;
    const updateRoot = ethers.keccak256(ethers.toUtf8Bytes('sg6-update'));
    const pushedRoot = ethers.keccak256(ethers.toUtf8Bytes('sg6-pushed'));
    const replacedRoot = ethers.keccak256(ethers.toUtf8Bytes('sg6-replaced'));

    const startBlock = await provider.getBlockNumber();
    await (await ka.createKnowledgeAsset(
      deployer, author, kaId, 'sg6-create',
      ethers.keccak256(ethers.toUtf8Bytes('sg6-create-root')),
      1, 1000, 1, 2, 0, false, 1,
    )).wait();
    await (await ka.updateKnowledgeAsset(
      deployer, author, kaId, 'sg6-update', updateRoot, 0, [], 2000, 0, 2,
    )).wait();
    await (await ka.pushMerkleRoot(deployer, kaId, pushedRoot)).wait();
    await (await ka.setMerkleRoots(kaId, [[deployer, replacedRoot, 1_700_000_000n]])).wait();
    await (await ka.popMerkleRoot(kaId)).wait();

    const seen: Array<{ kind: string; kaId: string; merkleRoot?: string; author?: string | null }> = [];
    const poller = new ChainEventPoller({
      chain,
      publishHandler: new PublishHandler(new OxigraphStore(), new TypedEventBus()),
      intervalMs: 60_000,
      // Seed the lane just before the first emit so the scan covers them all
      // without depending on where the shared node's head happens to be.
      cursorPersistence: {
        async loadLane() { return startBlock; },
        async saveLane() { /* not under test here */ },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => {
        if (e.kaId !== kaId.toString()) return;
        seen.push({ kind: e.kind, kaId: e.kaId, merkleRoot: e.merkleRoot, author: e.author });
      },
    });

    (poller as unknown as { laneRunner: { clearActiveLaneSchedules(): void } })
      .laneRunner.clearActiveLaneSchedules(); // force-scan seam (pollNow deleted, review r17)
    await (poller as unknown as { poll(): Promise<void> }).poll();
    await poller.stop();

    expect(seen.map((e) => e.kind)).toEqual([
      'lifecycle-update',
      'root-added',
      'roots-replaced',
      'root-removed',
    ]);
    expect(seen[0].merkleRoot).toBe(updateRoot);
    expect(seen[0].author).toBe(author.toLowerCase());
    expect(seen[1].merkleRoot).toBe(pushedRoot);
    // The dynamic root array is deliberately never decoded.
    expect(seen[2].merkleRoot).toBeUndefined();
    expect(seen[3].merkleRoot).toBe(replacedRoot);
  }, 120_000);

  it('still does NOT yield AllowListUpdated / ProfileCreated / ProfileUpdated', async () => {
    // The residual half of SG-6. `KnowledgeAssetUpdated` has left this list;
    // these three callback slots remain dead code in production, and this row
    // keeps saying so until someone wires them.
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const provider = createProvider();

    const head = await provider.getBlockNumber();
    const yielded: string[] = [];

    for await (const ev of chain.listenForEvents({
      eventTypes: [
        'KCCreated',
        'ContextGraphCreated',
        'AllowListUpdated',
        'ProfileCreated',
        'ProfileUpdated',
      ],
      fromBlock: 0,
      toBlock: head,
    })) {
      yielded.push(ev.type);
    }

    // Positive control: without it these three could pass vacuously against a
    // scan that yielded nothing at all.
    expect(yielded.length).toBeGreaterThan(0);
    for (const type of ['AllowListUpdated', 'ProfileCreated', 'ProfileUpdated']) {
      expect(yielded.includes(type), `adapter now yields "${type}" — rewrite this row into a positive dispatch test for it`).toBe(false);
    }
  }, 30_000);
});
