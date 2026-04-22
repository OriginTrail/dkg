const { performance } = require('node:perf_hooks');

function busyWait(ms) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    // Busy loop to simulate CPU-bound sync orchestration work.
  }
}

async function measureEventLoopDelay(runWork) {
  let maxDelay = 0;
  let tickCount = 0;
  let running = true;
  const intervalMs = 10;
  let expected = performance.now() + intervalMs;

  const timer = setInterval(() => {
    const now = performance.now();
    const delay = Math.max(0, now - expected);
    if (delay > maxDelay) maxDelay = delay;
    tickCount += 1;
    expected = now + intervalMs;
    if (!running) clearInterval(timer);
  }, intervalMs);

  const start = performance.now();
  const result = await runWork();
  const durationMs = performance.now() - start;
  running = false;
  await new Promise((resolve) => setTimeout(resolve, intervalMs * 2));

  return {
    durationMs: Number(durationMs.toFixed(2)),
    maxEventLoopDelayMs: Number(maxDelay.toFixed(2)),
    samplerTicks: tickCount,
    result,
  };
}

function createFakeAgent() {
  const peerIds = ['peer-a', 'peer-b', 'peer-c', 'peer-d'];
  return {
    peerId: 'self-peer',
    node: {
      libp2p: {
        getConnections() {
          return peerIds.map((peerId) => ({ remotePeer: { toString: () => peerId } }));
        },
      },
    },
    eventBus: { emit() {} },
    async isPrivateContextGraph() {
      busyWait(8);
      return false;
    },
    async resolvePreferredSyncPeerId() {
      busyWait(4);
      return 'peer-a';
    },
    async ensurePeerConnected() {
      busyWait(3);
    },
    async primeCatchupConnections() {
      busyWait(12);
    },
    selectCatchupPeers(peers) {
      busyWait(6);
      return peers;
    },
    async waitForSyncProtocol() {
      busyWait(10);
      return true;
    },
    async syncFromPeerDetailed() {
      busyWait(28);
      return {
        insertedTriples: 100,
        fetchedMetaTriples: 50,
        fetchedDataTriples: 50,
        insertedMetaTriples: 50,
        insertedDataTriples: 50,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
      };
    },
    async syncSharedMemoryFromPeerDetailed() {
      busyWait(22);
      return {
        insertedTriples: 80,
        fetchedMetaTriples: 40,
        fetchedDataTriples: 40,
        insertedMetaTriples: 40,
        insertedDataTriples: 40,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
      };
    },
    async refreshMetaSyncedFlags() {
      busyWait(5);
    },
    async syncContextGraphFromConnectedPeers() {
      busyWait(250);
      return {
        connectedPeers: peerIds.length,
        syncCapablePeers: peerIds.length,
        peersTried: peerIds.length,
        dataSynced: 400,
        sharedMemorySynced: 320,
        diagnostics: {
          noProtocolPeers: 0,
          durable: {
            fetchedMetaTriples: 200,
            fetchedDataTriples: 200,
            insertedMetaTriples: 200,
            insertedDataTriples: 200,
            emptyResponses: 0,
            metaOnlyResponses: 0,
            dataRejectedMissingMeta: 0,
            rejectedKcs: 0,
            failedPeers: 0,
          },
          sharedMemory: {
            fetchedMetaTriples: 160,
            fetchedDataTriples: 160,
            insertedMetaTriples: 160,
            insertedDataTriples: 160,
            emptyResponses: 0,
            droppedDataTriples: 0,
            failedPeers: 0,
          },
        },
      };
    },
  };
}

async function run() {
  const {
    createInlineCatchupRunner,
    createCatchupRunner,
  } = await import('../dist/catchup-runner.js');

  const request = { contextGraphId: 'bench-cg', includeSharedMemory: true };

  const inlineAgent = createFakeAgent();
  const inlineRunner = createInlineCatchupRunner(inlineAgent);
  const inlineMetrics = await measureEventLoopDelay(() => inlineRunner.run(request));
  await inlineRunner.close();

  const workerAgent = createFakeAgent();
  const workerRunner = createCatchupRunner(workerAgent);
  const workerMetrics = await measureEventLoopDelay(() => workerRunner.run(request));
  await workerRunner.close();

  console.log(JSON.stringify({
    inlineRunner: {
      durationMs: inlineMetrics.durationMs,
      maxEventLoopDelayMs: inlineMetrics.maxEventLoopDelayMs,
      samplerTicks: inlineMetrics.samplerTicks,
    },
    workerRunner: {
      durationMs: workerMetrics.durationMs,
      maxEventLoopDelayMs: workerMetrics.maxEventLoopDelayMs,
      samplerTicks: workerMetrics.samplerTicks,
    },
  }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
