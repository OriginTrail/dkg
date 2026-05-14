#!/usr/bin/env node

const { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { createInterface } = require('node:readline');

const REPO_ROOT = resolve(__dirname, '../../..');
const DKG_ONTOLOGY = 'http://dkg.io/ontology/';
const DEFAULT_CONTEXT_GRAPH_ID = 'devnet-test';
const DEFAULT_PREDICATE = 'urn:dkg:benchmark:swm-large-payload:payload';
const DEFAULT_NAMESPACE = 'swm-large-payload';
const INVOCATION_CWD = process.env.INIT_CWD || process.cwd();
const FAILURE_PATTERNS = [
  { name: 'oxigraphWasmUnreachable', text: 'RuntimeError: unreachable' },
  { name: 'oxigraphTableIndexOutOfBounds', text: 'table index is out of bounds' },
  { name: 'gossipsubInvalidDataLength', text: 'InvalidDataLengthError' },
  { name: 'gossipsubMessageTooLong', text: 'Message length too long' },
];

function usage() {
  return `Usage: pnpm --filter @origintrail-official/dkg benchmark:swm-large-payload -- [options]

Writes large public SWM payloads to a running multi-node devnet and verifies that
the replicated payload is not duplicated into dkg:publicStagedQuads metadata.

Options:
  --ports <list>                 Comma-separated daemon API ports. Default derives from --api-port-base and --nodes.
  --api-port-base <port>         First daemon API port when --ports is omitted. Default: 9201.
  --nodes <count>                Node count when --ports is omitted. Default: 5.
  --context-graph-id <id>        Context graph to write/query. Default: devnet-test.
  --payload-mib-per-node <MiB>   Payload size written through each node. Default: 100.
  --chunk-mib <MiB>              Payload literal size per SWM write. Default: 0.5.
  --write-concurrency <count>    Concurrent write requests. Default: 1.
  --replication-timeout-ms <ms>  Time to wait for every node to see every payload. Default: 900000.
  --poll-interval-ms <ms>        Replication polling interval. Default: 5000.
  --request-timeout-ms <ms>      Per-request timeout. Default: 180000.
  --query-timeout-ms <ms>        Per-query timeout. Default: 120000.
  --auth-token <token>           Bearer token. Also reads DKG_BENCH_AUTH_TOKEN, DKG_AUTH_TOKEN, DKG_TOKEN, DEVNET_TOKEN, or DKG_AUTH.
  --auth-token-file <path>       File containing bearer token. Defaults to DEVNET_DIR/node1/auth.token, if present.
  --no-auth                      Send requests without Authorization.
  --run-id <id>                  Stable run id. Default: timestamp + random suffix.
  --namespace <name>             Subject namespace segment. Default: swm-large-payload.
  --predicate <iri>              Payload predicate IRI. Default: ${DEFAULT_PREDICATE}.
  --progress-every <count>       Emit a progress line every N writes. Default: 25.
  --output <path>                Write the final JSON result to a file.
  --skip-write                   Only verify an existing run id.
  --devnet-dir <path>            Devnet directory for appended log scanning. Default: DEVNET_DIR or repo .devnet.
  --scan-logs / --no-scan-logs   Scan appended daemon logs for known failure signatures. Default: scan when devnet dir exists.
  --quiet                        Suppress progress events on stderr.
  -h, --help                     Show this help.

Environment mirrors the main options with DKG_BENCH_SWM_* names, for example
DKG_BENCH_SWM_PORTS, DKG_BENCH_SWM_PAYLOAD_MIB_PER_NODE, DKG_BENCH_SWM_CHUNK_MIB,
DKG_BENCH_SWM_OUTPUT, DKG_BENCH_SWM_SCAN_LOGS, and DKG_BENCH_SWM_NO_AUTH.`;
}

function parsePositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

function parsePositiveNumber(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value ${JSON.stringify(value)}`);
}

function parsePorts(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const ports = String(value)
    .split(',')
    .map((part) => parsePositiveInteger('port', part.trim()));
  if (ports.length === 0) return undefined;
  return ports;
}

function nextArgValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return { value: argv[index + 1], nextIndex: index + 1 };
}

function readAuthTokenFile(path) {
  const text = readFileSync(path, 'utf8');
  const tokens = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .flatMap((line) => line.split(/\s+/))
    .filter(Boolean);
  return tokens.at(-1);
}

function resolveAuthToken(options, env, devnetDir) {
  if (options.noAuth) return undefined;
  const inline = options.authToken
    ?? env.DKG_BENCH_AUTH_TOKEN
    ?? env.DKG_AUTH_TOKEN
    ?? env.DKG_TOKEN
    ?? env.DEVNET_TOKEN
    ?? env.DKG_AUTH;
  if (inline) return inline;

  const tokenFile = options.authTokenFile
    ?? (env.DKG_BENCH_AUTH_TOKEN_FILE ? resolveInputPath(env.DKG_BENCH_AUTH_TOKEN_FILE) : undefined)
    ?? (devnetDir ? join(devnetDir, 'node1', 'auth.token') : undefined);
  if (tokenFile && existsSync(tokenFile)) {
    return readAuthTokenFile(tokenFile);
  }
  return undefined;
}

function parseBenchmarkArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--') {
      continue;
    }
    if (raw === '-h' || raw === '--help') {
      options.help = true;
      continue;
    }
    if (raw === '--no-auth') {
      options.noAuth = true;
      continue;
    }
    if (raw === '--skip-write') {
      options.skipWrite = true;
      continue;
    }
    if (raw === '--quiet') {
      options.quiet = true;
      continue;
    }
    if (raw === '--scan-logs') {
      options.scanLogs = true;
      continue;
    }
    if (raw === '--no-scan-logs') {
      options.scanLogs = false;
      continue;
    }
    if (!raw.startsWith('--')) {
      throw new Error(`Unexpected argument ${JSON.stringify(raw)}`);
    }

    const eqIndex = raw.indexOf('=');
    const name = eqIndex >= 0 ? raw.slice(2, eqIndex) : raw.slice(2);
    const inlineValue = eqIndex >= 0 ? raw.slice(eqIndex + 1) : undefined;
    const { value, nextIndex } = nextArgValue(argv, index, `--${name}`, inlineValue);
    index = nextIndex;

    switch (name) {
      case 'ports':
        options.ports = parsePorts(value);
        break;
      case 'api-port-base':
        options.apiPortBase = parsePositiveInteger('--api-port-base', value);
        break;
      case 'nodes':
        options.nodes = parsePositiveInteger('--nodes', value);
        break;
      case 'context-graph-id':
        options.contextGraphId = value;
        break;
      case 'payload-mib-per-node':
        options.payloadMiBPerNode = parsePositiveNumber('--payload-mib-per-node', value);
        break;
      case 'chunk-mib':
        options.chunkMiB = parsePositiveNumber('--chunk-mib', value);
        break;
      case 'write-concurrency':
        options.writeConcurrency = parsePositiveInteger('--write-concurrency', value);
        break;
      case 'replication-timeout-ms':
        options.replicationTimeoutMs = parsePositiveInteger('--replication-timeout-ms', value);
        break;
      case 'poll-interval-ms':
        options.pollIntervalMs = parsePositiveInteger('--poll-interval-ms', value);
        break;
      case 'request-timeout-ms':
        options.requestTimeoutMs = parsePositiveInteger('--request-timeout-ms', value);
        break;
      case 'query-timeout-ms':
        options.queryTimeoutMs = parsePositiveInteger('--query-timeout-ms', value);
        break;
      case 'auth-token':
        options.authToken = value;
        break;
      case 'auth-token-file':
        options.authTokenFile = resolveInputPath(value);
        break;
      case 'run-id':
        options.runId = value;
        break;
      case 'namespace':
        options.namespace = value;
        break;
      case 'predicate':
        options.predicate = value;
        break;
      case 'progress-every':
        options.progressEvery = parsePositiveInteger('--progress-every', value);
        break;
      case 'output':
        options.output = resolveInputPath(value);
        break;
      case 'devnet-dir':
        options.devnetDir = resolveInputPath(value);
        break;
      default:
        throw new Error(`Unknown option --${name}`);
    }
  }

  const envPorts = parsePorts(env.DKG_BENCH_SWM_PORTS);
  const devnetDir = options.devnetDir
    ?? (env.DKG_BENCH_SWM_DEVNET_DIR ? resolveInputPath(env.DKG_BENCH_SWM_DEVNET_DIR) : undefined)
    ?? (env.DEVNET_DIR ? resolveInputPath(env.DEVNET_DIR) : undefined)
    ?? join(REPO_ROOT, '.devnet');
  const nodes = options.nodes
    ?? (env.DKG_BENCH_SWM_NODES ? parsePositiveInteger('DKG_BENCH_SWM_NODES', env.DKG_BENCH_SWM_NODES) : 5);
  const apiPortBase = options.apiPortBase
    ?? (env.DKG_BENCH_SWM_API_PORT_BASE
      ? parsePositiveInteger('DKG_BENCH_SWM_API_PORT_BASE', env.DKG_BENCH_SWM_API_PORT_BASE)
      : (env.API_PORT_BASE ? parsePositiveInteger('API_PORT_BASE', env.API_PORT_BASE) : 9201));
  const ports = options.ports ?? envPorts ?? Array.from({ length: nodes }, (_, index) => apiPortBase + index);
  const noAuth = options.noAuth ?? parseBoolean(env.DKG_BENCH_SWM_NO_AUTH ?? env.DEVNET_NO_AUTH, false);
  const config = {
    help: Boolean(options.help),
    contextGraphId: options.contextGraphId ?? env.DKG_BENCH_SWM_CONTEXT_GRAPH_ID ?? env.DKG_BENCH_CONTEXT_GRAPH_ID ?? DEFAULT_CONTEXT_GRAPH_ID,
    ports,
    nodes: ports.length,
    apiPortBase,
    payloadMiBPerNode: options.payloadMiBPerNode
      ?? (env.DKG_BENCH_SWM_PAYLOAD_MIB_PER_NODE
        ? parsePositiveNumber('DKG_BENCH_SWM_PAYLOAD_MIB_PER_NODE', env.DKG_BENCH_SWM_PAYLOAD_MIB_PER_NODE)
        : 100),
    chunkMiB: options.chunkMiB
      ?? (env.DKG_BENCH_SWM_CHUNK_MIB ? parsePositiveNumber('DKG_BENCH_SWM_CHUNK_MIB', env.DKG_BENCH_SWM_CHUNK_MIB) : 0.5),
    writeConcurrency: options.writeConcurrency
      ?? (env.DKG_BENCH_SWM_WRITE_CONCURRENCY
        ? parsePositiveInteger('DKG_BENCH_SWM_WRITE_CONCURRENCY', env.DKG_BENCH_SWM_WRITE_CONCURRENCY)
        : 1),
    replicationTimeoutMs: options.replicationTimeoutMs
      ?? (env.DKG_BENCH_SWM_REPLICATION_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_REPLICATION_TIMEOUT_MS', env.DKG_BENCH_SWM_REPLICATION_TIMEOUT_MS)
        : 900_000),
    pollIntervalMs: options.pollIntervalMs
      ?? (env.DKG_BENCH_SWM_POLL_INTERVAL_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_POLL_INTERVAL_MS', env.DKG_BENCH_SWM_POLL_INTERVAL_MS)
        : 5_000),
    requestTimeoutMs: options.requestTimeoutMs
      ?? (env.DKG_BENCH_SWM_REQUEST_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_REQUEST_TIMEOUT_MS', env.DKG_BENCH_SWM_REQUEST_TIMEOUT_MS)
        : 180_000),
    queryTimeoutMs: options.queryTimeoutMs
      ?? (env.DKG_BENCH_SWM_QUERY_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_QUERY_TIMEOUT_MS', env.DKG_BENCH_SWM_QUERY_TIMEOUT_MS)
        : 120_000),
    runId: options.runId ?? env.DKG_BENCH_SWM_RUN_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    namespace: options.namespace ?? env.DKG_BENCH_SWM_NAMESPACE ?? DEFAULT_NAMESPACE,
    predicate: options.predicate ?? env.DKG_BENCH_SWM_PREDICATE ?? DEFAULT_PREDICATE,
    progressEvery: options.progressEvery
      ?? (env.DKG_BENCH_SWM_PROGRESS_EVERY
        ? parsePositiveInteger('DKG_BENCH_SWM_PROGRESS_EVERY', env.DKG_BENCH_SWM_PROGRESS_EVERY)
        : 25),
    output: options.output ?? (env.DKG_BENCH_SWM_OUTPUT ? resolveInputPath(env.DKG_BENCH_SWM_OUTPUT) : undefined),
    skipWrite: options.skipWrite ?? parseBoolean(env.DKG_BENCH_SWM_SKIP_WRITE, false),
    noAuth,
    devnetDir,
    scanLogs: options.scanLogs ?? parseBoolean(env.DKG_BENCH_SWM_SCAN_LOGS, existsSync(devnetDir)),
    quiet: options.quiet ?? parseBoolean(env.DKG_BENCH_SWM_QUIET, false),
  };
  config.authToken = resolveAuthToken({ ...options, noAuth }, env, devnetDir);
  return Object.freeze(config);
}

function resolveInputPath(value) {
  return isAbsolute(value) ? value : resolve(INVOCATION_CWD, value);
}

function bytesFromMiB(value) {
  return Math.round(value * 1024 * 1024);
}

function buildBenchmarkPlan(config) {
  const payloadBytesPerNode = bytesFromMiB(config.payloadMiBPerNode);
  const chunkBytes = bytesFromMiB(config.chunkMiB);
  if (payloadBytesPerNode <= 0) throw new Error('payloadMiBPerNode resolved to zero bytes');
  if (chunkBytes <= 0) throw new Error('chunkMiB resolved to zero bytes');
  const chunksPerNode = Math.ceil(payloadBytesPerNode / chunkBytes);
  const totalOperations = config.ports.length * chunksPerNode;
  const totalPayloadBytes = payloadBytesPerNode * config.ports.length;
  const rootPrefix = `urn:dkg:benchmark:${config.namespace}:${config.runId}:`;
  return Object.freeze({
    payloadBytesPerNode,
    chunkBytes,
    chunksPerNode,
    totalOperations,
    totalPayloadBytes,
    totalPayloadMiB: Number((totalPayloadBytes / 1024 / 1024).toFixed(3)),
    rootPrefix,
    metadataGraph: `did:dkg:context-graph:${config.contextGraphId}/_shared_memory_meta`,
  });
}

function payloadBytesForChunk(plan, chunkNumber) {
  const writtenBefore = (chunkNumber - 1) * plan.chunkBytes;
  return Math.min(plan.chunkBytes, plan.payloadBytesPerNode - writtenBefore);
}

function makePayload(runId, nodeNumber, chunkNumber, sizeBytes) {
  const prefix = `swm-large run=${runId} node=${nodeNumber} chunk=${chunkNumber} `;
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  if (prefixBytes > sizeBytes) {
    throw new Error(`Payload prefix is ${prefixBytes} bytes, larger than requested ${sizeBytes} byte chunk`);
  }
  const fillChar = String.fromCharCode(97 + ((nodeNumber + chunkNumber) % 26));
  return prefix + fillChar.repeat(sizeBytes - prefixBytes);
}

function buildWriteTasks(config, plan) {
  const tasks = [];
  for (let chunkNumber = 1; chunkNumber <= plan.chunksPerNode; chunkNumber += 1) {
    for (let nodeIndex = 0; nodeIndex < config.ports.length; nodeIndex += 1) {
      tasks.push({ nodeIndex, chunkNumber });
    }
  }
  return tasks;
}

function sparqlString(value) {
  return JSON.stringify(String(value));
}

function bindingValue(result, name) {
  return result?.bindings?.[0]?.[name]?.value ?? result?.bindings?.[0]?.[name];
}

function numericBinding(result, name) {
  const value = bindingValue(result, name);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const typedLiteral = value.match(/^"([^"]+)"\^\^<[^>]+>$/);
    const lexical = typedLiteral ? typedLiteral[1] : value;
    const parsed = Number(lexical);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function literalLexicalValue(value) {
  if (value == null) return undefined;
  if (typeof value !== 'string') return String(value);
  if (!value.startsWith('"')) return value;
  const closingQuote = findClosingLiteralQuote(value);
  if (closingQuote < 0) return value;
  try {
    return JSON.parse(value.slice(0, closingQuote + 1));
  } catch {
    return value.slice(1, closingQuote);
  }
}

function findClosingLiteralQuote(term) {
  for (let i = 1; i < term.length; i += 1) {
    if (term[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && term[j] === '\\'; j -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

async function postJson(port, path, body, config, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'content-type': 'application/json' };
    if (config.authToken && !config.noAuth) headers.authorization = `Bearer ${config.authToken}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${path} on ${port}: ${text.slice(0, 500)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function query(port, sparql, config, options = {}) {
  const response = await postJson(port, '/api/query', { sparql, ...options }, config, config.queryTimeoutMs);
  return response.result ?? response;
}

async function writeChunk(config, plan, nodeIndex, chunkNumber) {
  const port = config.ports[nodeIndex];
  const nodeNumber = nodeIndex + 1;
  const sizeBytes = payloadBytesForChunk(plan, chunkNumber);
  const subject = `${plan.rootPrefix}node:${nodeNumber}:chunk:${chunkNumber}`;
  const payload = makePayload(config.runId, nodeNumber, chunkNumber, sizeBytes);
  const startedAt = performance.now();
  const response = await postJson(port, '/api/shared-memory/write', {
    contextGraphId: config.contextGraphId,
    quads: [{
      subject,
      predicate: config.predicate,
      object: JSON.stringify(payload),
      graph: '',
    }],
  }, config, config.requestTimeoutMs);
  const durationMs = performance.now() - startedAt;
  return {
    port,
    nodeNumber,
    chunkNumber,
    subject,
    payloadBytes: sizeBytes,
    durationMs: Number(durationMs.toFixed(2)),
    operationId: response.operationId,
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function summarizeWrites(records, config) {
  const durations = records.map((record) => record.durationMs);
  const perNode = config.ports.map((port) => {
    const nodeRecords = records.filter((record) => record.port === port);
    const nodeDurations = nodeRecords.map((record) => record.durationMs);
    const nodeBytes = nodeRecords.reduce((sum, record) => sum + record.payloadBytes, 0);
    return {
      port,
      operations: nodeRecords.length,
      payloadMiB: Number((nodeBytes / 1024 / 1024).toFixed(3)),
      minMs: Number(Math.min(...nodeDurations).toFixed(2)),
      maxMs: Number(Math.max(...nodeDurations).toFixed(2)),
      meanMs: Number((nodeDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, nodeDurations.length)).toFixed(2)),
      p50Ms: Number(percentile(nodeDurations, 50).toFixed(2)),
      p95Ms: Number(percentile(nodeDurations, 95).toFixed(2)),
    };
  });
  return {
    operations: records.length,
    minMs: Number(Math.min(...durations).toFixed(2)),
    maxMs: Number(Math.max(...durations).toFixed(2)),
    meanMs: Number((durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)).toFixed(2)),
    p50Ms: Number(percentile(durations, 50).toFixed(2)),
    p95Ms: Number(percentile(durations, 95).toFixed(2)),
    perNode,
  };
}

function emitProgress(config, event) {
  if (!config.quiet) {
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  }
}

async function runWrites(config, plan) {
  if (config.skipWrite) {
    return { durationMs: 0, records: [], summary: undefined };
  }

  const tasks = buildWriteTasks(config, plan);

  const records = [];
  let nextTask = 0;
  let completed = 0;
  const startedAt = performance.now();

  async function worker() {
    while (nextTask < tasks.length) {
      const task = tasks[nextTask];
      nextTask += 1;
      const record = await writeChunk(config, plan, task.nodeIndex, task.chunkNumber);
      records.push(record);
      completed += 1;
      if (completed === 1 || completed === tasks.length || completed % config.progressEvery === 0) {
        emitProgress(config, {
          event: 'write-progress',
          completed,
          total: tasks.length,
          port: record.port,
          operationId: record.operationId,
          durationMs: record.durationMs,
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(config.writeConcurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  const durationMs = performance.now() - startedAt;
  return {
    durationMs: Number(durationMs.toFixed(2)),
    records,
    summary: summarizeWrites(records, config),
  };
}

async function countPayloads(port, config, plan) {
  const result = await query(
    port,
    `SELECT (COUNT(?s) AS ?count) WHERE {
       ?s <${config.predicate}> ?o .
       FILTER(STRSTARTS(STR(?s), ${sparqlString(plan.rootPrefix)}))
     }`,
    config,
    { contextGraphId: config.contextGraphId, view: 'shared-working-memory' },
  );
  return numericBinding(result, 'count');
}

async function samplePayloadBytes(port, config, plan) {
  const result = await query(
    port,
    `SELECT ?s ?o WHERE {
       ?s <${config.predicate}> ?o .
       FILTER(STRSTARTS(STR(?s), ${sparqlString(plan.rootPrefix)}))
     } ORDER BY ?s LIMIT 1`,
    config,
    { contextGraphId: config.contextGraphId, view: 'shared-working-memory' },
  );
  const value = literalLexicalValue(bindingValue(result, 'o'));
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : Number.NaN;
}

async function countGlobalMetaPredicate(port, config, plan, predicate) {
  const result = await query(
    port,
    `SELECT (COUNT(?value) AS ?count) WHERE {
       GRAPH <${plan.metadataGraph}> { ?op <${predicate}> ?value }
     }`,
    config,
  );
  return numericBinding(result, 'count');
}

async function countRunMetaPredicate(port, config, plan, predicate) {
  const result = await query(
    port,
    buildRunMetaPredicateCountQuery(plan, predicate),
    config,
  );
  return numericBinding(result, 'count');
}

async function countRunPublicStagedQuads(port, config, plan) {
  const result = await query(
    port,
    buildRunMetaPredicateCountQuery(
      plan,
      `${DKG_ONTOLOGY}publicStagedQuads`,
      [`${DKG_ONTOLOGY}rootEntity`, `${DKG_ONTOLOGY}publicSliceRootEntity`],
    ),
    config,
  );
  return numericBinding(result, 'count');
}

function buildRunMetaPredicateCountQuery(plan, predicate, rootPredicates = [`${DKG_ONTOLOGY}rootEntity`]) {
  const rootClauses = rootPredicates
    .map((rootPredicate) => `{ ?op <${rootPredicate}> ?root . }`)
    .join('\n           UNION\n           ');
  return `SELECT (COUNT(?value) AS ?count) WHERE {
       {
         SELECT DISTINCT ?op ?value WHERE {
           GRAPH <${plan.metadataGraph}> {
             ?op <${predicate}> ?value .
             ${rootClauses}
             FILTER(STRSTARTS(STR(?root), ${sparqlString(plan.rootPrefix)}))
           }
         }
       }
     }`;
}

async function countRunRootEntities(port, config, plan) {
  const result = await query(
    port,
    `SELECT (COUNT(?root) AS ?count) WHERE {
       GRAPH <${plan.metadataGraph}> {
         ?op <${DKG_ONTOLOGY}rootEntity> ?root .
         FILTER(STRSTARTS(STR(?root), ${sparqlString(plan.rootPrefix)}))
       }
     }`,
    config,
  );
  return numericBinding(result, 'count');
}

async function collectPublicStagedQuadsBaseline(config, plan) {
  const entries = [];
  for (const port of config.ports) {
    entries.push({
      port,
      publicStagedQuadsGlobal: await countGlobalMetaPredicate(port, config, plan, `${DKG_ONTOLOGY}publicStagedQuads`),
    });
  }
  return entries;
}

async function pollReplication(config, plan) {
  const startedAt = performance.now();
  const polls = [];
  while (performance.now() - startedAt <= config.replicationTimeoutMs) {
    const counts = [];
    for (const port of config.ports) {
      try {
        counts.push({ port, count: await countPayloads(port, config, plan) });
      } catch (error) {
        counts.push({ port, error: error instanceof Error ? error.message : String(error) });
      }
    }
    polls.push({ atMs: Number((performance.now() - startedAt).toFixed(2)), counts });
    emitProgress(config, { event: 'replication-poll', counts });
    if (counts.every((entry) => entry.count === plan.totalOperations)) {
      return {
        converged: true,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        polls,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  return {
    converged: false,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
    polls,
  };
}

async function collectMetadata(config, plan, baseline) {
  const byPort = new Map(baseline.map((entry) => [entry.port, entry]));
  const entries = [];
  for (const port of config.ports) {
    const before = byPort.get(port)?.publicStagedQuadsGlobal ?? 0;
    const after = await countGlobalMetaPredicate(port, config, plan, `${DKG_ONTOLOGY}publicStagedQuads`);
    const payloadCount = await countPayloads(port, config, plan);
    const rootEntities = await countRunRootEntities(port, config, plan);
    const shareOperationIds = await countRunMetaPredicate(port, config, plan, `${DKG_ONTOLOGY}shareOperationId`);
    const publicStagedQuadsForRun = await countRunPublicStagedQuads(port, config, plan);
    const publisherPeerIds = await countRunMetaPredicate(port, config, plan, `${DKG_ONTOLOGY}publisherPeerId`);
    const publishedAt = await countRunMetaPredicate(port, config, plan, `${DKG_ONTOLOGY}publishedAt`);
    const timestamps = await countRunMetaPredicate(port, config, plan, `${DKG_ONTOLOGY}timestamp`);
    const sampleBytes = await samplePayloadBytes(port, config, plan);
    entries.push({
      port,
      payloadCount,
      samplePayloadBytes: sampleBytes,
      publicStagedQuadsForRun,
      publicStagedQuadsGlobalBefore: before,
      publicStagedQuadsGlobalAfter: after,
      publicStagedQuadsGlobalDelta: after - before,
      shareOperationIds,
      rootEntities,
      publisherPeerIds,
      publishedAt,
      timestamps,
      ok: payloadCount === plan.totalOperations
        && sampleBytes === payloadBytesForChunk(plan, 1)
        && publicStagedQuadsForRun === 0
        && after - before === 0
        && shareOperationIds === plan.totalOperations
        && rootEntities === plan.totalOperations
        && publishedAt === plan.totalOperations,
    });
  }
  return entries;
}

function captureLogOffsets(devnetDir) {
  if (!devnetDir || !existsSync(devnetDir)) return [];
  return readdirSync(devnetDir)
    .filter((name) => /^node\d+$/.test(name))
    .map((name) => join(devnetDir, name, 'daemon.log'))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, offset: statSync(file).size }));
}

async function scanLogsFromOffsets(offsets) {
  const matches = [];
  for (const { file, offset } of offsets) {
    if (!existsSync(file)) continue;
    const stream = createReadStream(file, { start: offset, encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      for (const pattern of FAILURE_PATTERNS) {
        if (line.includes(pattern.text)) {
          matches.push({
            file,
            lineOffset: lineNumber,
            pattern: pattern.name,
            text: pattern.text,
            line: line.slice(0, 500),
          });
        }
      }
    }
  }
  return {
    scannedFiles: offsets.map((entry) => entry.file),
    matches,
    ok: matches.length === 0,
  };
}

function sanitizeConfig(config) {
  return {
    contextGraphId: config.contextGraphId,
    ports: config.ports,
    payloadMiBPerNode: config.payloadMiBPerNode,
    chunkMiB: config.chunkMiB,
    writeConcurrency: config.writeConcurrency,
    replicationTimeoutMs: config.replicationTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
    runId: config.runId,
    namespace: config.namespace,
    predicate: config.predicate,
    skipWrite: config.skipWrite,
    noAuth: config.noAuth,
    hasAuthToken: Boolean(config.authToken && !config.noAuth),
    devnetDir: config.devnetDir,
    scanLogs: config.scanLogs,
  };
}

async function runSwmLargePayloadBenchmark(config) {
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();
  const plan = buildBenchmarkPlan(config);
  const logOffsets = config.scanLogs ? captureLogOffsets(config.devnetDir) : [];
  emitProgress(config, {
    event: 'benchmark-start',
    runId: config.runId,
    nodes: config.ports.length,
    totalPayloadMiB: plan.totalPayloadMiB,
    totalOperations: plan.totalOperations,
    chunkMiB: config.chunkMiB,
  });

  const baseline = await collectPublicStagedQuadsBaseline(config, plan);
  const write = await runWrites(config, plan);
  const replication = await pollReplication(config, plan);
  const metadata = await collectMetadata(config, plan, baseline);
  const logScan = config.scanLogs ? await scanLogsFromOffsets(logOffsets) : undefined;
  const finishedAt = performance.now();

  const ok = replication.converged
    && metadata.every((entry) => entry.ok)
    && (logScan ? logScan.ok : true);

  return {
    benchmark: 'swm-large-payload',
    ok,
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    durationMs: Number((finishedAt - startedAt).toFixed(2)),
    config: sanitizeConfig(config),
    plan: {
      payloadBytesPerNode: plan.payloadBytesPerNode,
      chunkBytes: plan.chunkBytes,
      chunksPerNode: plan.chunksPerNode,
      totalOperations: plan.totalOperations,
      totalPayloadBytes: plan.totalPayloadBytes,
      totalPayloadMiB: plan.totalPayloadMiB,
      rootPrefix: plan.rootPrefix,
      metadataGraph: plan.metadataGraph,
    },
    baseline,
    write: {
      durationMs: write.durationMs,
      summary: write.summary,
    },
    replication,
    metadata,
    logScan,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseBenchmarkArgs(argv, env);
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (config.chunkMiB > 1) {
    emitProgress(config, {
      event: 'warning',
      message: 'chunkMiB is above 1 MiB; local GossipSub limits may reject very large single-message writes.',
    });
  }
  const result = await runSwmLargePayloadBenchmark(config);
  if (config.output) {
    mkdirSync(dirname(config.output), { recursive: true });
    writeFileSync(config.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRunMetaPredicateCountQuery,
  buildWriteTasks,
  buildBenchmarkPlan,
  makePayload,
  numericBinding,
  parseBenchmarkArgs,
  payloadBytesForChunk,
  runSwmLargePayloadBenchmark,
  usage,
};
