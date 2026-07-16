const { createServer } = require('node:http');
const { performance } = require('node:perf_hooks');

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function busyWait(ms) {
  const start = performance.now();
  while (performance.now() - start < ms) {
    // Busy loop to simulate daemon work competing with request handling.
  }
}

async function mixedWork(cpuMs, ioMs = 2) {
  busyWait(cpuMs);
  await new Promise((resolve) => setTimeout(resolve, ioMs));
}

async function startProbeServer() {
  const server = createServer(async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind probe server');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function sampleApiLatency(origin, durationMs) {
  const latencies = [];
  const start = performance.now();
  while (performance.now() - start < durationMs) {
    const reqStart = performance.now();
    const response = await fetch(`${origin}/api/status`);
    await response.arrayBuffer();
    latencies.push(performance.now() - reqStart);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return latencies;
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
    async isPrivateContextGraph() { await mixedWork(3, 2); return false; },
    async resolvePreferredSyncPeerId() { await mixedWork(2, 2); return 'peer-a'; },
    async ensurePeerConnected() { await mixedWork(2, 3); },
    async primeCatchupConnections() { await mixedWork(4, 4); },
    selectCatchupPeers(peers) { busyWait(3); return peers; },
    async waitForSyncProtocol() { await mixedWork(3, 3); return true; },
    async syncFromPeerDetailed() {
      await mixedWork(8, 8);
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
      await mixedWork(7, 6);
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
    async refreshMetaSyncedFlags() { await mixedWork(2, 2); },
    async syncContextGraphFromConnectedPeers() {
      await mixedWork(40, 35);
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

async function measureRunner(name, createRunner) {
  const runner = createRunner();
  const request = { contextGraphId: 'bench-cg', includeSharedMemory: true };
  const probe = await startProbeServer();
  const start = performance.now();
  const workPromise = runner.run(request);
  const latencies = await sampleApiLatency(probe.origin, 300);
  await workPromise;
  const durationMs = performance.now() - start;
  await probe.close();
  await runner.close();

  return {
    durationMs: Number(durationMs.toFixed(2)),
    apiLatencyMs: {
      p50: Number(percentile(latencies, 50).toFixed(2)),
      p95: Number(percentile(latencies, 95).toFixed(2)),
      max: Number(Math.max(...latencies, 0).toFixed(2)),
      samples: latencies.length,
    },
  };
}

async function run() {
  const { createInlineCatchupRunner, createCatchupRunner } = await import('../dist/catchup-runner.js');

  const inline = await measureRunner('inline', () => createInlineCatchupRunner(createFakeAgent()));
  const worker = await measureRunner('worker', () => createCatchupRunner(createFakeAgent()));

  console.log(JSON.stringify({ inlineRunner: inline, workerRunner: worker }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
