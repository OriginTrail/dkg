#!/usr/bin/env node

const REFRESHES = 1_200;
const ROWS = 537;

function sampleHeap(profile) {
  profile.peakBytes = Math.max(profile.peakBytes, process.memoryUsage().heapUsed);
}

function heapProfile(run) {
  global.gc?.();
  const profile = {
    baselineBytes: process.memoryUsage().heapUsed,
    peakBytes: process.memoryUsage().heapUsed,
  };
  const value = run(profile);
  global.gc?.();
  const retainedBytes = process.memoryUsage().heapUsed - profile.baselineBytes;
  return {
    value,
    peakDeltaBytes: Math.max(0, profile.peakBytes - profile.baselineBytes),
    retainedDeltaBytes: Math.max(0, retainedBytes),
  };
}

function makeRows() {
  return Array.from({ length: ROWS }, (_, index) => ({
    id: `context-graph-${String(index).padStart(4, '0')}`,
    uri: `did:dkg:context-graph:${index}:${'u'.repeat(512)}`,
    name: `Context graph ${index} ${'n'.repeat(320)}`,
    description: `Representative context graph ${index} ${'d'.repeat(2_048)}`,
    creator: `did:dkg:agent:${index}:${'c'.repeat(256)}`,
    createdAt: '2026-09-14T00:00:00.000Z',
    curator: `0x${index.toString(16).padStart(40, '0')}`,
    accessPolicy: index % 2 === 0 ? 'public' : 'curated',
    isSystem: false,
    subscribed: index % 3 !== 0,
    synced: index % 5 !== 0,
    onChainId: String(index + 1),
  }));
}

async function main() {
  const {
    CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
    buildContextGraphListPage,
    parseContextGraphListQuery,
  } = await import('../dist/daemon/routes/context-graph-list.js');
  const rows = makeRows();
  const legacyBody = JSON.stringify({ contextGraphs: rows });

  const legacy = heapProfile((profile) => {
    let checksum = 0;
    for (let refresh = 0; refresh < REFRESHES; refresh += 1) {
      const parsed = JSON.parse(legacyBody);
      checksum += parsed.contextGraphs.length;
      sampleHeap(profile);
    }
    return { checksum };
  });

  const parsedQuery = parseContextGraphListQuery(new URLSearchParams({
    limit: '100',
    projection: 'summary',
  }));
  if (!parsedQuery.ok || parsedQuery.mode !== 'paged') {
    throw new Error('Unable to create the benchmark pagination query');
  }

  const pageBodies = [];
  let pageQuery = parsedQuery.query;
  do {
    const built = buildContextGraphListPage(rows, pageQuery);
    if (!built.ok) throw new Error(built.error);
    const body = JSON.stringify(built.payload);
    pageBodies.push(body);
    pageQuery = built.payload.nextCursor
      ? { ...pageQuery, cursorDigest: Buffer.from(built.payload.nextCursor, 'base64url')
        .toString('utf8').split(':').at(-1) }
      : undefined;
  } while (pageQuery);

  const pageSizes = pageBodies.map((body) => Buffer.byteLength(body));
  const maxPageBytes = Math.max(...pageSizes);
  if (maxPageBytes > CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES) {
    throw new Error(`Page exceeded ${CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES} bytes`);
  }

  const bounded = heapProfile((profile) => {
    const cachedRows = [];
    for (const body of pageBodies) {
      const page = JSON.parse(body);
      cachedRows.push(...page.contextGraphs);
      sampleHeap(profile);
    }

    if (cachedRows.length !== ROWS) {
      throw new Error(`Expected ${ROWS} cached rows, received ${cachedRows.length}`);
    }
    // The remaining refreshes receive 304 with no response body and reuse this cache.
    for (let refresh = 1; refresh < REFRESHES; refresh += 1) sampleHeap(profile);
    return {
      pagesOnInitialRefresh: pageSizes.length,
      maxPageBytes,
      transferredBodyBytes: pageSizes.reduce((total, bytes) => total + bytes, 0),
      parsedRows: cachedRows.length,
    };
  });

  const legacyTransferredBodyBytes = Buffer.byteLength(legacyBody) * REFRESHES;
  const result = {
    scenario: `${REFRESHES} list refreshes over ${ROWS} context graphs`,
    legacy: {
      responseBytes: Buffer.byteLength(legacyBody),
      transferredBodyBytes: legacyTransferredBodyBytes,
      parsedRows: ROWS * REFRESHES,
      clientPeakHeapDeltaBytes: legacy.peakDeltaBytes,
      clientRetainedHeapDeltaBytes: legacy.retainedDeltaBytes,
    },
    bounded: {
      ...bounded.value,
      conditionalRefreshes: REFRESHES - 1,
      clientPeakHeapDeltaBytes: bounded.peakDeltaBytes,
      clientRetainedHeapDeltaBytes: bounded.retainedDeltaBytes,
    },
    reduction: {
      transferredBodyPercent: Number((
        (1 - bounded.value.transferredBodyBytes / legacyTransferredBodyBytes) * 100
      ).toFixed(4)),
      parsedRowsPercent: Number((
        (1 - bounded.value.parsedRows / (ROWS * REFRESHES)) * 100
      ).toFixed(4)),
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
