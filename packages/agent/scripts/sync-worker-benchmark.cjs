const { performance } = require('node:perf_hooks');

function makeNQuads(count, contextGraphId, graphUri) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const root = `urn:test:entity:${i}`;
    lines.push(`<${root}> <http://schema.org/name> "Entity ${i}" <${graphUri}> .`);
    lines.push(`<${root}/.well-known/genid/${i}> <http://schema.org/value> "${i}" <${graphUri}> .`);
    lines.push(`<urn:ignore:${i}> <http://schema.org/name> "Ignore ${i}" <did:dkg:context-graph:${contextGraphId}/assertion/${i}> .`);
  }
  return lines.join('\n');
}

function splitNQuadLine(line) {
  const parts = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) break;
    if (line[i] === '<') {
      const end = line.indexOf('>', i);
      if (end === -1) break;
      parts.push(line.slice(i, end + 1));
      i = end + 1;
    } else if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"') { j++; break; }
        j++;
      }
      parts.push(line.slice(i, j));
      i = j;
    } else {
      break;
    }
  }
  return parts;
}

function strip(value) {
  return value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
}

function parseAndFilterMainThread(text, graphUri, contextGraphId) {
  const quads = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const body = trimmed.endsWith(' .') ? trimmed.slice(0, -2).trim() : trimmed;
    const parts = splitNQuadLine(body);
    if (parts.length < 3) continue;
    quads.push({
      subject: strip(parts[0]),
      predicate: strip(parts[1]),
      object: parts[2].startsWith('"') ? parts[2] : strip(parts[2]),
      graph: parts[3] ? strip(parts[3]) : '',
    });
  }
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  return quads.filter((q) => q.graph === graphUri || q.graph.startsWith(prefix));
}

async function run() {
  const { SyncVerifyWorker } = await import('../dist/sync-verify-worker.js');
  const contextGraphId = 'bench-cg';
  const graphUri = `did:dkg:context-graph:${contextGraphId}`;
  const nquads = makeNQuads(5000, contextGraphId, graphUri);
  const worker = new SyncVerifyWorker();

  try {
    const mainStart = performance.now();
    const mainResult = parseAndFilterMainThread(nquads, graphUri, contextGraphId);
    const mainMs = performance.now() - mainStart;

    const workerStart = performance.now();
    const workerResult = await worker.parseAndFilter(nquads, graphUri, contextGraphId);
    const workerMs = performance.now() - workerStart;

    console.log(JSON.stringify({
      dataset: { lines: nquads.split('\n').length, kept: mainResult.length },
      mainThreadMs: Number(mainMs.toFixed(2)),
      workerMs: Number(workerMs.toFixed(2)),
      workerKept: workerResult.quads.length,
      workerTotal: workerResult.totalQuads,
    }, null, 2));
  } finally {
    await worker.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
