#!/usr/bin/env node

const REFRESHES = 1_200;
const ROWS = 537;

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
  const { serializeContextGraphListOptions } = await import(
    '@origintrail-official/dkg-core/context-graph-list-wire'
  );
  const rows = makeRows();
  const legacyBody = JSON.stringify({ contextGraphs: rows });

  const initialOptions = {
    limit: '100',
    projection: 'summary',
  };
  const parsedQuery = parseContextGraphListQuery(new URLSearchParams(initialOptions));
  if (!parsedQuery.ok || parsedQuery.mode !== 'paged') {
    throw new Error('Unable to create the benchmark pagination query');
  }

  const pageBodies = [];
  let pageQuery = parsedQuery.query;
  do {
    const built = buildContextGraphListPage(rows, pageQuery);
    if (!built.ok) throw new Error(built.error);
    pageBodies.push(built.body);
    if (!built.payload.nextCursor) {
      pageQuery = undefined;
      continue;
    }
    const serialized = serializeContextGraphListOptions({
      limit: Number(initialOptions.limit),
      projection: initialOptions.projection,
      cursor: built.payload.nextCursor,
    });
    const nextQuery = parseContextGraphListQuery(new URLSearchParams(serialized));
    if (!nextQuery.ok || nextQuery.mode !== 'paged') {
      throw new Error('Unable to parse the benchmark continuation query');
    }
    pageQuery = nextQuery.query;
  } while (pageQuery);

  const pageSizes = pageBodies.map((body) => Buffer.byteLength(body));
  const maxPageBytes = Math.max(...pageSizes);
  if (maxPageBytes > CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES) {
    throw new Error(`Page exceeded ${CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES} bytes`);
  }

  const cachedRows = pageBodies.flatMap((body) => JSON.parse(body).contextGraphs);
  if (cachedRows.length !== ROWS) {
    throw new Error(`Expected ${ROWS} cached rows, received ${cachedRows.length}`);
  }
  const bounded = {
    pagesOnInitialRefresh: pageSizes.length,
    maxPageBytes,
    transferredBodyBytes: pageSizes.reduce((total, bytes) => total + bytes, 0),
    parsedRows: cachedRows.length,
  };

  const legacyTransferredBodyBytes = Buffer.byteLength(legacyBody) * REFRESHES;
  const result = {
    scenario: `${REFRESHES} list refreshes over ${ROWS} context graphs`,
    legacy: {
      responseBytes: Buffer.byteLength(legacyBody),
      transferredBodyBytes: legacyTransferredBodyBytes,
      parsedRows: ROWS * REFRESHES,
    },
    bounded: {
      ...bounded,
      conditionalRefreshes: REFRESHES - 1,
    },
    reduction: {
      transferredBodyPercent: Number((
        (1 - bounded.transferredBodyBytes / legacyTransferredBodyBytes) * 100
      ).toFixed(4)),
      parsedRowsPercent: Number((
        (1 - bounded.parsedRows / (ROWS * REFRESHES)) * 100
      ).toFixed(4)),
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
