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

/** Minimal ServerResponse stand-in: the route only writes a head and a body. */
function responseRecorder() {
  const state = {};
  const res = {
    writeHead(status, headers = {}) {
      state.status = status;
      state.headers = headers;
      return this;
    },
    end(body) {
      state.body = body ?? '';
      return this;
    },
  };
  return { state, res };
}

async function callRoute(handleContextGraphListRoute, rows, query, ifNoneMatch) {
  const recorder = responseRecorder();
  await handleContextGraphListRoute({
    req: { headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch } },
    res: recorder.res,
    agent: { listContextGraphs: async () => rows },
    url: new URL(`http://127.0.0.1/api/context-graph/list?${query}`),
    requestAgentAddress: null,
  });
  return {
    status: recorder.state.status,
    headers: recorder.state.headers ?? {},
    body: recorder.state.body ?? '',
    bodyBytes: Buffer.byteLength(recorder.state.body ?? ''),
  };
}

async function main() {
  const {
    CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
    handleContextGraphListRoute,
  } = await import('../dist/daemon/routes/context-graph-list.js');
  const { serializeContextGraphListOptions } = await import(
    '@origintrail-official/dkg-core/context-graph-list-wire'
  );
  const rows = makeRows();

  const limit = 100;
  const projection = 'summary';
  const firstPageQuery = serializeContextGraphListOptions({ limit, projection });
  const pageQuery = (cursor) => serializeContextGraphListOptions({ limit, projection, cursor });

  // --- Refresh 1: the full page walk, every page issued through the route. ---
  const pageSizes = [];
  const walkedRows = [];
  let transferredBodyBytes = 0;
  let query = firstPageQuery;
  let firstPageEtag;
  for (;;) {
    const response = await callRoute(handleContextGraphListRoute, rows, query);
    if (response.status !== 200) {
      throw new Error(`The initial page walk returned HTTP ${response.status}`);
    }
    if (firstPageEtag === undefined) firstPageEtag = response.headers.ETag;
    pageSizes.push(response.bodyBytes);
    transferredBodyBytes += response.bodyBytes;
    const payload = JSON.parse(response.body);
    walkedRows.push(...payload.contextGraphs);
    if (!payload.nextCursor) break;
    query = pageQuery(payload.nextCursor);
  }

  const maxPageBytes = Math.max(...pageSizes);
  if (maxPageBytes > CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES) {
    throw new Error(`Page exceeded ${CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES} bytes`);
  }
  if (walkedRows.length !== ROWS) {
    throw new Error(`Expected ${ROWS} cached rows, received ${walkedRows.length}`);
  }
  if (!firstPageEtag) throw new Error('The initial page walk returned no ETag');

  // --- Refreshes 2..N: each one really issued, with the cached ETag. ---
  // This mirrors the UI client (`fetchContextGraphPages`), where a 304 on the
  // first page serves the whole cached walk: an unchanged registry costs one
  // conditional request per refresh and no response body at all. Because the
  // requests are executed rather than assumed, a regression in ETag stability
  // or in per-refresh re-serialization shows up in these counters.
  let conditionalRefreshes = 0;
  let notModifiedResponses = 0;
  let revalidationBodyBytes = 0;
  for (let refresh = 1; refresh < REFRESHES; refresh += 1) {
    const response = await callRoute(
      handleContextGraphListRoute,
      rows,
      firstPageQuery,
      firstPageEtag,
    );
    conditionalRefreshes += 1;
    if (response.status === 304) notModifiedResponses += 1;
    revalidationBodyBytes += response.bodyBytes;
    transferredBodyBytes += response.bodyBytes;
  }
  if (conditionalRefreshes !== REFRESHES - 1) {
    throw new Error(`Expected ${REFRESHES - 1} conditional refreshes, ran ${conditionalRefreshes}`);
  }
  if (notModifiedResponses !== conditionalRefreshes) {
    throw new Error(
      `ETag instability: ${conditionalRefreshes - notModifiedResponses} of `
      + `${conditionalRefreshes} conditional refreshes re-sent a body`,
    );
  }

  const bounded = {
    pagesOnInitialRefresh: pageSizes.length,
    maxPageBytes,
    transferredBodyBytes,
    // Only the initial walk is parsed; every 304 is served from the client cache.
    parsedRows: walkedRows.length,
    conditionalRefreshes,
    notModifiedResponses,
    revalidationBodyBytes,
  };

  // The legacy route has no conditional path: every refresh re-serializes and
  // re-sends the whole registry, so one measured response times the refresh
  // count is its cost by construction.
  const legacy = await callRoute(handleContextGraphListRoute, rows, '');
  if (legacy.status !== 200 || legacy.headers['X-DKG-List-Mode'] !== 'legacy') {
    throw new Error('Unable to measure the legacy list response');
  }
  const legacyTransferredBodyBytes = legacy.bodyBytes * REFRESHES;

  const result = {
    scenario: `${REFRESHES} list refreshes over ${ROWS} context graphs`,
    method: {
      bounded: `measured: one ${pageSizes.length}-request page walk plus `
        + `${conditionalRefreshes} If-None-Match requests, all issued through `
        + 'handleContextGraphListRoute; the byte counts are the real response bodies',
      legacy: 'measured: one legacy route response; the legacy route is unconditional, '
        + `so its total is that response times ${REFRESHES}`,
    },
    legacy: {
      responseBytes: legacy.bodyBytes,
      transferredBodyBytes: legacyTransferredBodyBytes,
      parsedRows: ROWS * REFRESHES,
    },
    bounded,
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
