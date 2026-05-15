#!/usr/bin/env node

const { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { dirname, isAbsolute, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { createInterface } = require('node:readline');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = resolve(__dirname, '../../..');
const DEFAULT_CONTEXT_GRAPH_ID = 'devnet-test';
const DEFAULT_NAMESPACE = 'swm-triple-volume';
const DEFAULT_PREDICATE_BASE = 'urn:dkg:benchmark:swm-triple-volume:p';
const DKG_ONTOLOGY = 'http://dkg.io/ontology/';
const INVOCATION_CWD = process.env.INIT_CWD || process.cwd();
const FAILURE_PATTERNS = [
  { name: 'oxigraphWasmUnreachable', text: 'RuntimeError: unreachable' },
  { name: 'oxigraphTableIndexOutOfBounds', text: 'table index is out of bounds' },
  { name: 'gossipsubInvalidDataLength', text: 'InvalidDataLengthError' },
  { name: 'gossipsubMessageTooLong', text: 'Message length too long' },
  { name: 'heapOutOfMemory', text: 'JavaScript heap out of memory' },
];
const DIAGNOSTIC_LOG_PATTERNS = [
  ...FAILURE_PATTERNS,
  { name: 'sharedMemoryWritesStarted', text: 'quads to SWM' },
  { name: 'sharedMemoryWritesCompleted', text: 'Shared memory write complete' },
  { name: 'replicatedWritesStored', text: 'Stored SWM write' },
  { name: 'queryAllContextGraph', text: 'Query on contextGraph="all"' },
  { name: 'syncingFromPeer', text: 'Syncing from peer' },
  { name: 'syncTimeout', text: 'Sync timeout' },
  { name: 'syncFailed', text: 'Sync from ' },
  { name: 'protocolSyncSend', text: 'send /dkg/10.0.0/sync' },
  { name: 'skippedSwmSync', text: 'Skipping shared memory sync' },
  { name: 'rsTick', text: '[rs.tick' },
  { name: 'rsLoopError', text: '[rs.loop.tick-threw]' },
  { name: 'socketHangUp', text: 'socket hang up' },
  { name: 'shuttingDown', text: 'Shutting down' },
];

function usage() {
  return `Usage: pnpm --filter @origintrail-official/dkg benchmark:swm-triple-volume -- [options]

Writes many small public SWM triples to a running multi-node devnet and verifies
that every node can count the replicated triple volume. This stresses Oxigraph
triple/index volume rather than large literal byte externalization.

Options:
  --ports <list>                    Comma-separated daemon API ports. Default derives from --api-port-base and --nodes.
  --api-port-base <port>            First daemon API port when --ports is omitted. Default: 9201.
  --nodes <count>                   Node count when --ports is omitted. Default: 5.
  --context-graph-id <id>           Context graph to write/query. Default: devnet-test.
  --target-mib-per-node <MiB>       Approximate serialized N-Quad bytes to write per node. Default: 1024.
  --target-gib-per-node <GiB>       Same target in GiB; overrides --target-mib-per-node.
  --triples-per-write <count>       Small triples per /api/shared-memory/write request. Default: 1000.
  --object-bytes <bytes>            Lexical bytes for generated literal objects. Default: 64.
  --predicate-count <count>         Number of predicates to rotate through. Default: 8.
  --write-concurrency <count>       Concurrent write requests. Default: 1.
  --replication-timeout-ms <ms>     Time to wait for every node to see every triple. Default: 1800000.
  --poll-interval-ms <ms>           Replication polling interval. Default: 10000.
  --request-timeout-ms <ms>         Per-request timeout. Default: 180000.
  --query-timeout-ms <ms>           Per-query timeout. Default: 180000.
  --auth-token <token>              Bearer token. Also reads DKG_BENCH_AUTH_TOKEN, DKG_AUTH_TOKEN, DKG_TOKEN, DEVNET_TOKEN, or DKG_AUTH.
  --auth-token-file <path>          File containing bearer token. Defaults to DEVNET_DIR/node1/auth.token, if present.
  --no-auth                         Send requests without Authorization.
  --run-id <id>                     Stable run id. Default: timestamp + random suffix.
  --namespace <name>                Subject namespace segment. Default: swm-triple-volume.
  --predicate-base <iri>            Predicate IRI prefix. Default: ${DEFAULT_PREDICATE_BASE}.
  --progress-every <count>          Emit a progress line every N writes. Default: 25.
  --max-writes <count>              Stop after N total writes, useful for diagnostic runs.
  --diagnostic-interval-ms <ms>     Collect process/store/log diagnostics every N ms. Default: 30000.
  --no-diagnostics                  Disable diagnostic snapshots during the write phase.
  --output <path>                   Write the final JSON result to a file.
  --analysis-output <path>          Write a Markdown throughput analysis. Default: <output>.analysis.md.
  --skip-write                      Only verify an existing run id.
  --devnet-dir <path>               Devnet directory for appended log scanning. Default: DEVNET_DIR or repo .devnet.
  --scan-logs / --no-scan-logs      Scan appended daemon logs for known failure signatures. Default: scan when devnet dir exists.
  --quiet                           Suppress progress events on stderr.
  -h, --help                        Show this help.

Example 1 GiB per node:
  pnpm bench:swm-triple-volume -- \\
    --ports 20101,20102,20103,20104,20105 \\
    --target-gib-per-node 1 \\
    --triples-per-write 1000 \\
    --write-concurrency 5 \\
    --output bench/results/swm-triple-volume-1gib-per-node.json`;
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
  return ports.length > 0 ? ports : undefined;
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
  if (tokenFile && existsSync(tokenFile)) return readAuthTokenFile(tokenFile);
  return undefined;
}

function parseBenchmarkArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--') continue;
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
    if (raw === '--no-diagnostics') {
      options.diagnostics = false;
      continue;
    }
    if (!raw.startsWith('--')) throw new Error(`Unexpected argument ${JSON.stringify(raw)}`);

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
      case 'target-mib-per-node':
        options.targetMiBPerNode = parsePositiveNumber('--target-mib-per-node', value);
        break;
      case 'target-gib-per-node':
        options.targetMiBPerNode = parsePositiveNumber('--target-gib-per-node', value) * 1024;
        break;
      case 'triples-per-write':
        options.triplesPerWrite = parsePositiveInteger('--triples-per-write', value);
        break;
      case 'object-bytes':
        options.objectBytes = parsePositiveInteger('--object-bytes', value);
        break;
      case 'predicate-count':
        options.predicateCount = parsePositiveInteger('--predicate-count', value);
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
      case 'predicate-base':
        options.predicateBase = value;
        break;
      case 'progress-every':
        options.progressEvery = parsePositiveInteger('--progress-every', value);
        break;
      case 'max-writes':
        options.maxWrites = parsePositiveInteger('--max-writes', value);
        break;
      case 'diagnostic-interval-ms':
        options.diagnosticIntervalMs = parsePositiveInteger('--diagnostic-interval-ms', value);
        break;
      case 'output':
        options.output = resolveInputPath(value);
        break;
      case 'analysis-output':
        options.analysisOutput = resolveInputPath(value);
        break;
      case 'devnet-dir':
        options.devnetDir = resolveInputPath(value);
        break;
      default:
        throw new Error(`Unknown option --${name}`);
    }
  }

  const envPorts = parsePorts(env.DKG_BENCH_SWM_TRIPLES_PORTS ?? env.DKG_BENCH_SWM_PORTS);
  const devnetDir = options.devnetDir
    ?? (env.DKG_BENCH_SWM_TRIPLES_DEVNET_DIR ? resolveInputPath(env.DKG_BENCH_SWM_TRIPLES_DEVNET_DIR) : undefined)
    ?? (env.DKG_BENCH_SWM_DEVNET_DIR ? resolveInputPath(env.DKG_BENCH_SWM_DEVNET_DIR) : undefined)
    ?? (env.DEVNET_DIR ? resolveInputPath(env.DEVNET_DIR) : undefined)
    ?? join(REPO_ROOT, '.devnet');
  const nodes = options.nodes
    ?? (env.DKG_BENCH_SWM_TRIPLES_NODES
      ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_NODES', env.DKG_BENCH_SWM_TRIPLES_NODES)
      : (env.DKG_BENCH_SWM_NODES ? parsePositiveInteger('DKG_BENCH_SWM_NODES', env.DKG_BENCH_SWM_NODES) : 5));
  const apiPortBase = options.apiPortBase
    ?? (env.DKG_BENCH_SWM_TRIPLES_API_PORT_BASE
      ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_API_PORT_BASE', env.DKG_BENCH_SWM_TRIPLES_API_PORT_BASE)
      : (env.DKG_BENCH_SWM_API_PORT_BASE
        ? parsePositiveInteger('DKG_BENCH_SWM_API_PORT_BASE', env.DKG_BENCH_SWM_API_PORT_BASE)
        : (env.API_PORT_BASE ? parsePositiveInteger('API_PORT_BASE', env.API_PORT_BASE) : 9201)));
  const ports = options.ports ?? envPorts ?? Array.from({ length: nodes }, (_, index) => apiPortBase + index);
  const noAuth = options.noAuth ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_NO_AUTH ?? env.DKG_BENCH_SWM_NO_AUTH ?? env.DEVNET_NO_AUTH, false);
  const targetMiBPerNode = options.targetMiBPerNode
    ?? (env.DKG_BENCH_SWM_TRIPLES_TARGET_GIB_PER_NODE
      ? parsePositiveNumber('DKG_BENCH_SWM_TRIPLES_TARGET_GIB_PER_NODE', env.DKG_BENCH_SWM_TRIPLES_TARGET_GIB_PER_NODE) * 1024
      : (env.DKG_BENCH_SWM_TRIPLES_TARGET_MIB_PER_NODE
        ? parsePositiveNumber('DKG_BENCH_SWM_TRIPLES_TARGET_MIB_PER_NODE', env.DKG_BENCH_SWM_TRIPLES_TARGET_MIB_PER_NODE)
        : 1024));

  const config = {
    help: Boolean(options.help),
    contextGraphId: options.contextGraphId ?? env.DKG_BENCH_SWM_TRIPLES_CONTEXT_GRAPH_ID ?? env.DKG_BENCH_SWM_CONTEXT_GRAPH_ID ?? DEFAULT_CONTEXT_GRAPH_ID,
    ports,
    nodes: ports.length,
    apiPortBase,
    targetMiBPerNode,
    triplesPerWrite: options.triplesPerWrite
      ?? (env.DKG_BENCH_SWM_TRIPLES_PER_WRITE ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_PER_WRITE', env.DKG_BENCH_SWM_TRIPLES_PER_WRITE) : 1000),
    objectBytes: options.objectBytes
      ?? (env.DKG_BENCH_SWM_TRIPLES_OBJECT_BYTES ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_OBJECT_BYTES', env.DKG_BENCH_SWM_TRIPLES_OBJECT_BYTES) : 64),
    predicateCount: options.predicateCount
      ?? (env.DKG_BENCH_SWM_TRIPLES_PREDICATE_COUNT ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_PREDICATE_COUNT', env.DKG_BENCH_SWM_TRIPLES_PREDICATE_COUNT) : 8),
    writeConcurrency: options.writeConcurrency
      ?? (env.DKG_BENCH_SWM_TRIPLES_WRITE_CONCURRENCY
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_WRITE_CONCURRENCY', env.DKG_BENCH_SWM_TRIPLES_WRITE_CONCURRENCY)
        : 1),
    replicationTimeoutMs: options.replicationTimeoutMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_REPLICATION_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_REPLICATION_TIMEOUT_MS', env.DKG_BENCH_SWM_TRIPLES_REPLICATION_TIMEOUT_MS)
        : 1_800_000),
    pollIntervalMs: options.pollIntervalMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_POLL_INTERVAL_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_POLL_INTERVAL_MS', env.DKG_BENCH_SWM_TRIPLES_POLL_INTERVAL_MS)
        : 10_000),
    requestTimeoutMs: options.requestTimeoutMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_REQUEST_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_REQUEST_TIMEOUT_MS', env.DKG_BENCH_SWM_TRIPLES_REQUEST_TIMEOUT_MS)
        : 180_000),
    queryTimeoutMs: options.queryTimeoutMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_QUERY_TIMEOUT_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_QUERY_TIMEOUT_MS', env.DKG_BENCH_SWM_TRIPLES_QUERY_TIMEOUT_MS)
        : 180_000),
    runId: options.runId ?? env.DKG_BENCH_SWM_TRIPLES_RUN_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    namespace: options.namespace ?? env.DKG_BENCH_SWM_TRIPLES_NAMESPACE ?? DEFAULT_NAMESPACE,
    predicateBase: options.predicateBase ?? env.DKG_BENCH_SWM_TRIPLES_PREDICATE_BASE ?? DEFAULT_PREDICATE_BASE,
    progressEvery: options.progressEvery
      ?? (env.DKG_BENCH_SWM_TRIPLES_PROGRESS_EVERY ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_PROGRESS_EVERY', env.DKG_BENCH_SWM_TRIPLES_PROGRESS_EVERY) : 25),
    maxWrites: options.maxWrites
      ?? (env.DKG_BENCH_SWM_TRIPLES_MAX_WRITES ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_MAX_WRITES', env.DKG_BENCH_SWM_TRIPLES_MAX_WRITES) : undefined),
    diagnosticIntervalMs: options.diagnosticIntervalMs
      ?? (env.DKG_BENCH_SWM_TRIPLES_DIAGNOSTIC_INTERVAL_MS
        ? parsePositiveInteger('DKG_BENCH_SWM_TRIPLES_DIAGNOSTIC_INTERVAL_MS', env.DKG_BENCH_SWM_TRIPLES_DIAGNOSTIC_INTERVAL_MS)
        : 30_000),
    output: options.output ?? (env.DKG_BENCH_SWM_TRIPLES_OUTPUT ? resolveInputPath(env.DKG_BENCH_SWM_TRIPLES_OUTPUT) : undefined),
    analysisOutput: options.analysisOutput ?? (env.DKG_BENCH_SWM_TRIPLES_ANALYSIS_OUTPUT ? resolveInputPath(env.DKG_BENCH_SWM_TRIPLES_ANALYSIS_OUTPUT) : undefined),
    skipWrite: options.skipWrite ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_SKIP_WRITE, false),
    noAuth,
    devnetDir,
    scanLogs: options.scanLogs ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_SCAN_LOGS ?? env.DKG_BENCH_SWM_SCAN_LOGS, existsSync(devnetDir)),
    diagnostics: options.diagnostics ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_DIAGNOSTICS, true),
    quiet: options.quiet ?? parseBoolean(env.DKG_BENCH_SWM_TRIPLES_QUIET ?? env.DKG_BENCH_SWM_QUIET, false),
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

function makeObjectLexical(runId, nodeNumber, writeNumber, tripleIndex, objectBytes) {
  const prefix = `r=${runId};n=${nodeNumber};w=${writeNumber};t=${tripleIndex};`;
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  if (prefixBytes > objectBytes) {
    throw new Error(`Object prefix is ${prefixBytes} bytes, larger than requested ${objectBytes} bytes`);
  }
  const fillChar = String.fromCharCode(97 + ((nodeNumber + writeNumber + tripleIndex) % 26));
  return prefix + fillChar.repeat(objectBytes - prefixBytes);
}

function makeQuads(config, plan, nodeNumber, writeNumber, tripleCount = config.triplesPerWrite) {
  const root = `${plan.rootPrefix}node:${nodeNumber}:write:${writeNumber}`;
  const quads = [{
    subject: root,
    predicate: `${config.predicateBase}:root`,
    object: JSON.stringify(`root run=${config.runId} node=${nodeNumber} write=${writeNumber} triples=${tripleCount}`),
    graph: '',
  }];

  for (let index = 1; index < tripleCount; index += 1) {
    quads.push({
      subject: `${root}/.well-known/genid/t${index}`,
      predicate: `${config.predicateBase}:${index % config.predicateCount}`,
      object: JSON.stringify(makeObjectLexical(config.runId, nodeNumber, writeNumber, index, config.objectBytes)),
      graph: '',
    });
  }

  return quads;
}

function estimateQuadNQuadBytes(quad) {
  const object = quad.object.startsWith('"') ? quad.object : `<${quad.object}>`;
  return Buffer.byteLength(`<${quad.subject}> <${quad.predicate}> ${object} .\n`, 'utf8');
}

function estimateQuadsNQuadBytes(quads) {
  return quads.reduce((sum, quad) => sum + estimateQuadNQuadBytes(quad), 0);
}

function buildBenchmarkPlan(config) {
  const targetBytesPerNode = bytesFromMiB(config.targetMiBPerNode);
  const sampleQuads = makeQuads(config, { rootPrefix: `urn:dkg:benchmark:${config.namespace}:sample:` }, 1, 1);
  const estimatedBytesPerWrite = estimateQuadsNQuadBytes(sampleQuads);
  const writesPerNode = Math.ceil(targetBytesPerNode / estimatedBytesPerWrite);
  const totalWrites = writesPerNode * config.ports.length;
  const triplesPerNode = writesPerNode * config.triplesPerWrite;
  const totalTriples = triplesPerNode * config.ports.length;
  const estimatedBytesPerNode = estimatedBytesPerWrite * writesPerNode;
  const totalEstimatedBytes = estimatedBytesPerNode * config.ports.length;
  const rootPrefix = `urn:dkg:benchmark:${config.namespace}:${config.runId}:`;
  const metadataGraph = `did:dkg:context-graph:${config.contextGraphId}/_shared_memory_meta`;
  return Object.freeze({
    targetBytesPerNode,
    targetMiBPerNode: Number((targetBytesPerNode / 1024 / 1024).toFixed(3)),
    estimatedBytesPerWrite,
    writesPerNode,
    totalWrites,
    triplesPerNode,
    totalTriples,
    estimatedBytesPerNode,
    estimatedMiBPerNode: Number((estimatedBytesPerNode / 1024 / 1024).toFixed(3)),
    totalEstimatedBytes,
    totalEstimatedMiB: Number((totalEstimatedBytes / 1024 / 1024).toFixed(3)),
    rootPrefix,
    metadataGraph,
  });
}

function buildWriteTasks(config, plan) {
  const tasks = [];
  for (let writeNumber = 1; writeNumber <= plan.writesPerNode; writeNumber += 1) {
    for (let nodeIndex = 0; nodeIndex < config.ports.length; nodeIndex += 1) {
      tasks.push({ nodeIndex, writeNumber });
      if (config.maxWrites && tasks.length >= config.maxWrites) {
        return tasks;
      }
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

async function postJson(port, path, body, config, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
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
  } catch (error) {
    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    const cause = error?.cause;
    const causeCode = cause?.code ? ` cause=${cause.code}` : '';
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`${path} on port ${port} failed after ${durationMs}ms: ${message}${causeCode}`);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

async function query(port, sparql, config, options = {}) {
  const response = await postJson(port, '/api/query', { sparql, ...options }, config, config.queryTimeoutMs);
  return response.result ?? response;
}

async function writeBatch(config, plan, nodeIndex, writeNumber) {
  const port = config.ports[nodeIndex];
  const nodeNumber = nodeIndex + 1;
  const quads = makeQuads(config, plan, nodeNumber, writeNumber);
  const estimatedNQuadBytes = estimateQuadsNQuadBytes(quads);
  const startedAt = performance.now();
  const response = await postJson(port, '/api/shared-memory/write', {
    contextGraphId: config.contextGraphId,
    quads,
  }, config, config.requestTimeoutMs);
  const durationMs = performance.now() - startedAt;
  return {
    port,
    nodeNumber,
    writeNumber,
    root: quads[0].subject,
    triples: quads.length,
    estimatedNQuadBytes,
    durationMs: Number(durationMs.toFixed(2)),
    operationId: response.operationId ?? response.shareOperationId,
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function durationSummary(values) {
  if (values.length === 0) {
    return {
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
    };
  }
  return {
    minMs: Number(Math.min(...values).toFixed(2)),
    maxMs: Number(Math.max(...values).toFixed(2)),
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    p50Ms: Number(percentile(values, 50).toFixed(2)),
    p95Ms: Number(percentile(values, 95).toFixed(2)),
  };
}

function summarizeWrites(records, config) {
  const durations = records.map((record) => record.durationMs);
  const perNode = config.ports.map((port) => {
    const nodeRecords = records.filter((record) => record.port === port);
    const nodeDurations = nodeRecords.map((record) => record.durationMs);
    const estimatedBytes = nodeRecords.reduce((sum, record) => sum + record.estimatedNQuadBytes, 0);
    const triples = nodeRecords.reduce((sum, record) => sum + record.triples, 0);
    return {
      port,
      writes: nodeRecords.length,
      triples,
      estimatedMiB: Number((estimatedBytes / 1024 / 1024).toFixed(3)),
      ...durationSummary(nodeDurations),
    };
  });
  return {
    writes: records.length,
    triples: records.reduce((sum, record) => sum + record.triples, 0),
    estimatedMiB: Number((records.reduce((sum, record) => sum + record.estimatedNQuadBytes, 0) / 1024 / 1024).toFixed(3)),
    ...durationSummary(durations),
    perNode,
  };
}

function emitProgress(config, event) {
  if (!config.quiet) process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function errorRecord(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    cause: error?.cause instanceof Error ? error.cause.message : undefined,
  };
}

function safeFileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function directoryStats(path) {
  const totals = { files: 0, bytes: 0 };
  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        totals.files += 1;
        totals.bytes += safeFileSize(child);
      }
    }
  }
  visit(path);
  totals.mib = Number((totals.bytes / 1024 / 1024).toFixed(3));
  return totals;
}

function readPid(path) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parsePsRows() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid,ppid,stat,etime,rss,pcpu,command'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const lines = out.trimEnd().split(/\r?\n/).slice(1);
    return lines.map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
      if (!match) return undefined;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        stat: match[3],
        etime: match[4],
        rssKiB: Number(match[5]),
        cpuPercent: Number(match[6]),
        command: match[7],
      };
    }).filter(Boolean);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function processTreeStats(rootPid, psRows) {
  if (!rootPid || !Array.isArray(psRows)) return undefined;
  const byParent = new Map();
  for (const row of psRows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const rows = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = psRows.find((candidate) => candidate.pid === pid);
    if (row) rows.push(row);
    for (const child of byParent.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }
  if (rows.length === 0) return undefined;
  const rssKiB = rows.reduce((sum, row) => sum + row.rssKiB, 0);
  const cpuPercent = rows.reduce((sum, row) => sum + row.cpuPercent, 0);
  return {
    rootPid,
    processes: rows.length,
    rssMiB: Number((rssKiB / 1024).toFixed(2)),
    cpuPercent: Number(cpuPercent.toFixed(1)),
    commands: rows.slice(0, 5).map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      stat: row.stat,
      etime: row.etime,
      rssMiB: Number((row.rssKiB / 1024).toFixed(2)),
      cpuPercent: row.cpuPercent,
      command: row.command.slice(0, 160),
    })),
  };
}

async function countLogPatternsFromOffsets(offsets, patterns = DIAGNOSTIC_LOG_PATTERNS, options = {}) {
  const byNode = [];
  for (const entry of offsets) {
    const counts = Object.fromEntries(patterns.map((pattern) => [pattern.name, 0]));
    let bytes = 0;
    if (existsSync(entry.file)) {
      const end = safeFileSize(entry.file);
      bytes = Math.max(0, end - entry.offset);
      if (bytes > 0) {
        const stream = createReadStream(entry.file, {
          encoding: 'utf8',
          start: entry.offset,
        });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          for (const pattern of patterns) {
            if (line.includes(pattern.text)) counts[pattern.name] += 1;
          }
        }
      }
      if (options.updateOffsets) entry.offset = end;
    }
    byNode.push({ nodeName: entry.nodeName, bytes, counts });
  }
  const totals = Object.fromEntries(patterns.map((pattern) => [pattern.name, 0]));
  for (const entry of byNode) {
    for (const [key, value] of Object.entries(entry.counts)) {
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return { totals, byNode };
}

function emptyLogTotals(patterns = DIAGNOSTIC_LOG_PATTERNS) {
  return Object.fromEntries(patterns.map((pattern) => [pattern.name, 0]));
}

function addLogTotals(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

async function collectDiagnosticSnapshot(config, state, logOffsets, cumulativeLogTotals) {
  if (!config.diagnostics || !config.devnetDir || !existsSync(config.devnetDir)) return undefined;
  const psRows = parsePsRows();
  const logCounters = await countLogPatternsFromOffsets(logOffsets, DIAGNOSTIC_LOG_PATTERNS, {
    updateOffsets: Boolean(cumulativeLogTotals),
  });
  if (cumulativeLogTotals) {
    addLogTotals(cumulativeLogTotals, logCounters.totals);
    logCounters.deltaTotals = logCounters.totals;
    logCounters.totals = { ...cumulativeLogTotals };
  }
  const nodes = config.ports.map((port, index) => {
    const nodeName = `node${index + 1}`;
    const nodeDir = join(config.devnetDir, nodeName);
    const rootPid = readPid(join(nodeDir, 'daemon.pid')) ?? readPid(join(nodeDir, 'devnet.pid'));
    const storePath = join(nodeDir, 'store.nq');
    const snapshotDir = join(nodeDir, 'swm-public-snapshots');
    return {
      nodeName,
      port,
      pid: rootPid,
      process: processTreeStats(rootPid, psRows),
      storeNqMiB: Number((safeFileSize(storePath) / 1024 / 1024).toFixed(3)),
      publicSnapshotStore: directoryStats(snapshotDir),
      daemonLogMiB: Number((safeFileSize(join(nodeDir, 'daemon.log')) / 1024 / 1024).toFixed(3)),
    };
  });
  return {
    atMs: Number((performance.now() - state.startedAt).toFixed(2)),
    completed: state.completed,
    estimatedMiBWritten: Number((state.estimatedBytes / 1024 / 1024).toFixed(3)),
    nodes,
    logCounters,
    psError: psRows.error,
  };
}

async function runWrites(config, plan, logOffsets = []) {
  if (config.skipWrite) {
    return {
      ok: true,
      durationMs: 0,
      attemptedWrites: 0,
      completedWrites: 0,
      records: [],
      intervals: [],
      diagnostics: [],
      summary: undefined,
    };
  }

  const tasks = buildWriteTasks(config, plan);
  const records = [];
  const intervals = [];
  const diagnostics = [];
  let nextTask = 0;
  let completed = 0;
  let estimatedBytes = 0;
  let failedError;
  const startedAt = performance.now();
  let lastProgressAt = startedAt;
  let lastProgressCompleted = 0;
  let lastProgressBytes = 0;
  let lastProgressRecordIndex = 0;
  const state = { startedAt, completed, estimatedBytes };
  const diagnosticLogOffsets = logOffsets.map((entry) => ({ ...entry }));
  const cumulativeLogTotals = emptyLogTotals();
  let diagnosticInFlight = Promise.resolve();

  function queueDiagnosticSnapshot() {
    if (!config.diagnostics) return;
    diagnosticInFlight = diagnosticInFlight
      .catch(() => {})
      .then(async () => {
        const snapshot = await collectDiagnosticSnapshot(config, state, diagnosticLogOffsets, cumulativeLogTotals);
        if (snapshot) diagnostics.push(snapshot);
      });
  }

  const diagnosticTimer = config.diagnostics
    ? setInterval(queueDiagnosticSnapshot, config.diagnosticIntervalMs)
    : undefined;
  if (diagnosticTimer?.unref) diagnosticTimer.unref();

  async function worker() {
    while (nextTask < tasks.length) {
      if (failedError) return;
      const task = tasks[nextTask];
      nextTask += 1;
      let record;
      try {
        record = await writeBatch(config, plan, task.nodeIndex, task.writeNumber);
      } catch (error) {
        failedError = error;
        emitProgress(config, {
          event: 'write-error',
          completed,
          total: tasks.length,
          nodeIndex: task.nodeIndex,
          port: config.ports[task.nodeIndex],
          writeNumber: task.writeNumber,
          error: errorRecord(error).message,
        });
        return;
      }
      records.push(record);
      completed += 1;
      estimatedBytes += record.estimatedNQuadBytes;
      state.completed = completed;
      state.estimatedBytes = estimatedBytes;
      if (completed === 1 || completed === tasks.length || completed % config.progressEvery === 0) {
        const now = performance.now();
        const intervalRecords = records.slice(lastProgressRecordIndex);
        const intervalMs = now - lastProgressAt;
        const intervalWrites = completed - lastProgressCompleted;
        const intervalBytes = estimatedBytes - lastProgressBytes;
        const intervalDurations = intervalRecords.map((entry) => entry.durationMs);
        const progress = {
          atMs: Number((now - startedAt).toFixed(2)),
          completed,
          total: tasks.length,
          intervalWrites,
          intervalMs: Number(intervalMs.toFixed(2)),
          writesPerSec: Number((intervalWrites / Math.max(1, intervalMs / 1000)).toFixed(3)),
          miBPerSec: Number((intervalBytes / 1024 / 1024 / Math.max(1, intervalMs / 1000)).toFixed(3)),
          estimatedMiBWritten: Number((estimatedBytes / 1024 / 1024).toFixed(3)),
          latencyMs: {
            mean: Number((intervalDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, intervalDurations.length)).toFixed(2)),
            p50: Number(percentile(intervalDurations, 50).toFixed(2)),
            p95: Number(percentile(intervalDurations, 95).toFixed(2)),
            max: Number(Math.max(...intervalDurations, 0).toFixed(2)),
          },
          perPortWrites: Object.fromEntries(config.ports.map((port) => [
            port,
            intervalRecords.filter((entry) => entry.port === port).length,
          ])),
        };
        intervals.push(progress);
        emitProgress(config, {
          event: 'write-progress',
          completed,
          total: tasks.length,
          port: record.port,
          triples: record.triples,
          estimatedMiB: Number((record.estimatedNQuadBytes / 1024 / 1024).toFixed(3)),
          durationMs: record.durationMs,
          writesPerSec: progress.writesPerSec,
          miBPerSec: progress.miBPerSec,
          p95Ms: progress.latencyMs.p95,
        });
        lastProgressAt = now;
        lastProgressCompleted = completed;
        lastProgressBytes = estimatedBytes;
        lastProgressRecordIndex = records.length;
      }
    }
  }

  const workers = Array.from({ length: Math.min(config.writeConcurrency, tasks.length) }, () => worker());
  try {
    await Promise.all(workers);
  } finally {
    if (diagnosticTimer) clearInterval(diagnosticTimer);
    queueDiagnosticSnapshot();
    await diagnosticInFlight.catch(() => {});
  }
  const durationMs = performance.now() - startedAt;
  return {
    ok: !failedError && completed === tasks.length,
    durationMs: Number(durationMs.toFixed(2)),
    attemptedWrites: tasks.length,
    completedWrites: completed,
    records,
    intervals,
    diagnostics,
    error: failedError ? errorRecord(failedError) : undefined,
    summary: records.length > 0 ? summarizeWrites(records, config) : undefined,
  };
}

async function countTriples(port, config, plan) {
  const result = await query(
    port,
    `SELECT (COUNT(?s) AS ?count) WHERE {
       ?s ?p ?o .
       FILTER(STRSTARTS(STR(?s), ${sparqlString(plan.rootPrefix)}))
     }`,
    config,
    { contextGraphId: config.contextGraphId, view: 'shared-working-memory' },
  );
  return numericBinding(result, 'count');
}

async function sampleTriple(port, config, plan) {
  const result = await query(
    port,
    `SELECT ?s ?p ?o WHERE {
       ?s ?p ?o .
       FILTER(STRSTARTS(STR(?s), ${sparqlString(plan.rootPrefix)}))
     } ORDER BY ?s ?p LIMIT 1`,
    config,
    { contextGraphId: config.contextGraphId, view: 'shared-working-memory' },
  );
  return result?.bindings?.[0] ?? undefined;
}

async function countRunMetaPredicate(port, config, plan, predicate, rootPredicates = [`${DKG_ONTOLOGY}rootEntity`]) {
  const rootClauses = rootPredicates
    .map((rootPredicate) => `{ ?op <${rootPredicate}> ?root . }`)
    .join('\n           UNION\n           ');
  const result = await query(
    port,
    `SELECT (COUNT(?value) AS ?count) WHERE {
       {
         SELECT DISTINCT ?op ?value WHERE {
           GRAPH <${plan.metadataGraph}> {
             ?op <${predicate}> ?value .
             ${rootClauses}
             FILTER(STRSTARTS(STR(?root), ${sparqlString(plan.rootPrefix)}))
           }
         }
       }
     }`,
    config,
  );
  return numericBinding(result, 'count');
}

async function collectMetadata(config, plan, expectedWrites = plan.totalWrites) {
  const entries = [];
  for (const port of config.ports) {
    const publicStagedQuads = await countRunMetaPredicate(
      port,
      config,
      plan,
      `${DKG_ONTOLOGY}publicStagedQuads`,
      [`${DKG_ONTOLOGY}rootEntity`, `${DKG_ONTOLOGY}publicSliceRootEntity`],
    );
    const publicSnapshotGraphs = await countRunMetaPredicate(
      port,
      config,
      plan,
      `${DKG_ONTOLOGY}publicSnapshotGraph`,
      [`${DKG_ONTOLOGY}rootEntity`, `${DKG_ONTOLOGY}publicSliceRootEntity`],
    );
    const publicSnapshotRefs = await countRunMetaPredicate(
      port,
      config,
      plan,
      `${DKG_ONTOLOGY}publicSnapshotRef`,
      [`${DKG_ONTOLOGY}rootEntity`, `${DKG_ONTOLOGY}publicSliceRootEntity`],
    );
    entries.push({
      port,
      publicStagedQuads,
      publicSnapshotGraphs,
      publicSnapshotRefs,
      ok: publicStagedQuads === 0
        && publicSnapshotGraphs === 0
        && publicSnapshotRefs === expectedWrites,
    });
  }
  return entries;
}

async function pollReplication(config, plan, expectedTriples = plan.totalTriples) {
  const startedAt = performance.now();
  const polls = [];
  while (performance.now() - startedAt <= config.replicationTimeoutMs) {
    const counts = [];
    for (const port of config.ports) {
      try {
        counts.push({ port, count: await countTriples(port, config, plan) });
      } catch (error) {
        counts.push({ port, error: error instanceof Error ? error.message : String(error) });
      }
    }
    polls.push({ atMs: Number((performance.now() - startedAt).toFixed(2)), counts });
    emitProgress(config, { event: 'replication-poll', counts });
    if (counts.every((entry) => entry.count === expectedTriples)) {
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

async function collectSamples(config, plan, expectedTriples = plan.totalTriples) {
  const entries = [];
  for (const port of config.ports) {
    const count = await countTriples(port, config, plan);
    const sample = await sampleTriple(port, config, plan);
    entries.push({
      port,
      count,
      sample,
      ok: count === expectedTriples && Boolean(sample),
    });
  }
  return entries;
}

function captureLogOffsets(devnetDir) {
  if (!devnetDir || !existsSync(devnetDir)) return [];
  return readdirSync(devnetDir)
    .filter((name) => /^node\d+$/.test(name))
    .map((nodeName) => {
      const file = join(devnetDir, nodeName, 'daemon.log');
      return existsSync(file) ? { nodeName, file, offset: statSync(file).size } : undefined;
    })
    .filter(Boolean);
}

async function scanLogsFromOffsets(offsets) {
  const matches = [];
  for (const entry of offsets) {
    if (!existsSync(entry.file)) continue;
    const stream = createReadStream(entry.file, {
      encoding: 'utf8',
      start: entry.offset,
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber += 1;
      for (const pattern of FAILURE_PATTERNS) {
        if (line.includes(pattern.text)) {
          matches.push({
            nodeName: entry.nodeName,
            file: entry.file,
            lineOffset: lineNumber,
            pattern: pattern.name,
            text: line.slice(0, 500),
          });
        }
      }
    }
  }
  return { scannedFiles: offsets.map((entry) => entry.file), matches, ok: matches.length === 0 };
}

function sanitizeConfig(config) {
  return {
    contextGraphId: config.contextGraphId,
    ports: config.ports,
    targetMiBPerNode: config.targetMiBPerNode,
    triplesPerWrite: config.triplesPerWrite,
    objectBytes: config.objectBytes,
    predicateCount: config.predicateCount,
    writeConcurrency: config.writeConcurrency,
    replicationTimeoutMs: config.replicationTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
    progressEvery: config.progressEvery,
    maxWrites: config.maxWrites,
    diagnosticIntervalMs: config.diagnosticIntervalMs,
    diagnostics: config.diagnostics,
    runId: config.runId,
    namespace: config.namespace,
    predicateBase: config.predicateBase,
    skipWrite: config.skipWrite,
    noAuth: config.noAuth,
    hasAuthToken: Boolean(config.authToken),
    devnetDir: config.devnetDir,
    scanLogs: config.scanLogs,
  };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function summarizeInterval(interval) {
  if (!interval) return undefined;
  return {
    atMs: finiteNumber(interval.atMs),
    completed: finiteNumber(interval.completed),
    writesPerSec: finiteNumber(interval.writesPerSec),
    miBPerSec: finiteNumber(interval.miBPerSec),
    p95Ms: finiteNumber(interval.latencyMs?.p95),
    maxMs: finiteNumber(interval.latencyMs?.max),
  };
}

function latestDiagnosticWithNodes(diagnostics) {
  if (!Array.isArray(diagnostics)) return undefined;
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    if (Array.isArray(diagnostics[index]?.nodes)) return diagnostics[index];
  }
  return diagnostics.at(-1);
}

function analyzeThroughput(result) {
  const write = result?.write ?? {};
  const intervals = Array.isArray(write.intervals)
    ? write.intervals.filter((interval) => Number.isFinite(Number(interval.writesPerSec)))
    : [];
  const first = intervals[0];
  const peak = intervals.reduce((best, interval) => (
    finiteNumber(interval.writesPerSec) > finiteNumber(best?.writesPerSec) ? interval : best
  ), undefined);
  const final = intervals.at(-1);
  const peakRate = finiteNumber(peak?.writesPerSec);
  const finalRate = finiteNumber(final?.writesPerSec);
  const dropFromPeak = peakRate > 0 ? Number(((peakRate - finalRate) / peakRate).toFixed(3)) : 0;
  const halfPeakAt = peakRate > 0
    ? intervals.find((interval) => (
      finiteNumber(interval.atMs) > finiteNumber(peak?.atMs)
        && finiteNumber(interval.writesPerSec) <= peakRate / 2
    ))
    : undefined;
  const latestDiagnostic = latestDiagnosticWithNodes(write.diagnostics);
  const logTotals = latestDiagnostic?.logCounters?.totals
    ?? result?.logScan?.diagnosticCounts?.totals
    ?? {};
  const nodeStorage = Array.isArray(latestDiagnostic?.nodes)
    ? latestDiagnostic.nodes.map((node) => ({
      nodeName: node.nodeName,
      port: node.port,
      storeNqMiB: finiteNumber(node.storeNqMiB),
      snapshotMiB: finiteNumber(node.publicSnapshotStore?.mib),
      snapshotFiles: finiteNumber(node.publicSnapshotStore?.files),
      daemonLogMiB: finiteNumber(node.daemonLogMiB),
      rssMiB: finiteNumber(node.process?.rssMiB),
      cpuPercent: finiteNumber(node.process?.cpuPercent),
      processes: finiteNumber(node.process?.processes),
    }))
    : [];

  const signals = [];
  if (write.error) {
    signals.push({
      name: 'write-failure',
      severity: 'high',
      detail: write.error.message,
    });
  }
  if (dropFromPeak >= 0.5 && intervals.length >= 2) {
    signals.push({
      name: 'throughput-drop',
      severity: 'high',
      detail: `Final interval is ${(dropFromPeak * 100).toFixed(1)}% below peak throughput.`,
    });
  }
  const syncSignals = ['syncTimeout', 'syncFailed', 'syncingFromPeer', 'protocolSyncSend']
    .reduce((sum, key) => sum + finiteNumber(logTotals[key]), 0);
  if (syncSignals > 0) {
    signals.push({
      name: 'sync-backpressure',
      severity: 'medium',
      detail: `Observed ${syncSignals} durable-sync or catch-up log events during the measured window.`,
    });
  }
  if (finiteNumber(logTotals.queryAllContextGraph) > 0) {
    signals.push({
      name: 'status-query-load',
      severity: 'medium',
      detail: `Observed ${finiteNumber(logTotals.queryAllContextGraph)} all-context query log events during the measured window.`,
    });
  }
  const rpcSignals = ['rsLoopError', 'socketHangUp']
    .reduce((sum, key) => sum + finiteNumber(logTotals[key]), 0);
  if (rpcSignals > 0) {
    signals.push({
      name: 'rpc-instability',
      severity: 'high',
      detail: `Observed ${rpcSignals} RPC loop or socket hang-up events during the measured window.`,
    });
  }
  const storageMiB = nodeStorage.reduce((sum, node) => sum + node.storeNqMiB, 0);
  if (storageMiB > 0) {
    signals.push({
      name: 'store-growth',
      severity: 'info',
      detail: `Latest sampled store.nq total is ${storageMiB.toFixed(1)} MiB across ${nodeStorage.length} nodes.`,
    });
  }

  return {
    attemptedWrites: finiteNumber(write.attemptedWrites),
    completedWrites: finiteNumber(write.completedWrites),
    intervalCount: intervals.length,
    firstInterval: summarizeInterval(first),
    peakInterval: summarizeInterval(peak),
    finalInterval: summarizeInterval(final),
    dropFromPeak,
    halfPeakAt: summarizeInterval(halfPeakAt),
    slowestIntervals: [...intervals]
      .sort((a, b) => finiteNumber(a.writesPerSec) - finiteNumber(b.writesPerSec))
      .slice(0, 5)
      .map(summarizeInterval),
    latestDiagnosticsAtMs: finiteNumber(latestDiagnostic?.atMs),
    nodeStorage,
    logTotals,
    signals,
  };
}

function tableOrPlaceholder(headers, rows) {
  if (rows.length === 0) return '_No samples captured._';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function renderAnalysisMarkdown(result) {
  const analysis = result.analysis ?? analyzeThroughput(result);
  const signals = Array.isArray(analysis.signals) ? analysis.signals : [];
  const slowestIntervals = Array.isArray(analysis.slowestIntervals) ? analysis.slowestIntervals : [];
  const nodeStorage = Array.isArray(analysis.nodeStorage) ? analysis.nodeStorage : [];
  const lines = [
    '# SWM Triple-Volume Throughput Analysis',
    '',
    `- Status: ${result.ok ? 'pass' : 'fail'}`,
    `- Run id: ${result.config?.runId ?? 'unknown'}`,
    `- Completed writes: ${analysis.completedWrites}/${analysis.attemptedWrites}`,
    `- Peak throughput: ${analysis.peakInterval?.writesPerSec ?? 0} writes/sec (${analysis.peakInterval?.miBPerSec ?? 0} MiB/sec)`,
    `- Final throughput: ${analysis.finalInterval?.writesPerSec ?? 0} writes/sec (${analysis.finalInterval?.miBPerSec ?? 0} MiB/sec)`,
    `- Drop from peak: ${(finiteNumber(analysis.dropFromPeak) * 100).toFixed(1)}%`,
    '',
    '## Signals',
    '',
  ];

  if (signals.length === 0) {
    lines.push('_No throughput-drop signal was detected in the captured intervals._');
  } else {
    for (const signal of signals) {
      lines.push(`- ${signal.severity}: ${signal.name} - ${signal.detail}`);
    }
  }

  lines.push(
    '',
    '## Slowest Intervals',
    '',
    tableOrPlaceholder(
      ['at ms', 'completed', 'writes/sec', 'MiB/sec', 'p95 ms', 'max ms'],
      slowestIntervals.map((interval) => [
        interval.atMs,
        interval.completed,
        interval.writesPerSec,
        interval.miBPerSec,
        interval.p95Ms,
        interval.maxMs,
      ]),
    ),
    '',
    '## Latest Node Snapshot',
    '',
    tableOrPlaceholder(
      ['node', 'port', 'store MiB', 'snap MiB', 'snap files', 'rss MiB', 'cpu %', 'log MiB'],
      nodeStorage.map((node) => [
        node.nodeName,
        node.port,
        node.storeNqMiB,
        node.snapshotMiB,
        node.snapshotFiles,
        node.rssMiB,
        node.cpuPercent,
        node.daemonLogMiB,
      ]),
    ),
    '',
    '## Diagnostic Log Counters',
    '',
    '```json',
    JSON.stringify(analysis.logTotals ?? {}, null, 2),
    '```',
    '',
    '## Interpretation',
    '',
    'This benchmark measures write-path throughput while SWM gossip, durable sync, status queries, and Oxigraph persistence are active. A throughput drop with sync-backpressure or all-context query counters points at runtime load around replication/catch-up and query traffic, not large literal externalization. A drop without those counters points more directly at local RDF store/index growth or daemon resource pressure.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

function defaultAnalysisOutput(output) {
  if (!output) return undefined;
  return output.endsWith('.json')
    ? `${output.slice(0, -'.json'.length)}.analysis.md`
    : `${output}.analysis.md`;
}

async function runSwmTripleVolumeBenchmark(config) {
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  const logOffsets = config.scanLogs ? captureLogOffsets(config.devnetDir) : [];
  const plan = buildBenchmarkPlan(config);

  emitProgress(config, {
    event: 'plan',
    nodes: config.ports.length,
    targetMiBPerNode: plan.targetMiBPerNode,
    estimatedMiBPerNode: plan.estimatedMiBPerNode,
    triplesPerWrite: config.triplesPerWrite,
    writesPerNode: plan.writesPerNode,
    triplesPerNode: plan.triplesPerNode,
    totalTriples: plan.totalTriples,
  });

  const write = await runWrites(config, plan, logOffsets);
  const expectedWrites = config.skipWrite ? plan.totalWrites : write.completedWrites;
  const expectedTriples = expectedWrites * config.triplesPerWrite;
  let replication = {
    skipped: true,
    reason: write.ok ? 'not run' : 'write phase failed',
    converged: false,
    polls: [],
  };
  let samples = [];
  let metadata = [];
  let verificationError;
  if (write.ok) {
    try {
      replication = await pollReplication(config, plan, expectedTriples);
      samples = await collectSamples(config, plan, expectedTriples);
      metadata = await collectMetadata(config, plan, expectedWrites);
    } catch (error) {
      verificationError = errorRecord(error);
      replication = {
        skipped: false,
        converged: false,
        polls: replication.polls ?? [],
        error: verificationError,
      };
      emitProgress(config, {
        event: 'verification-error',
        error: verificationError.message,
      });
    }
  } else {
    emitProgress(config, {
      event: 'verification-skipped',
      reason: 'write phase failed',
      completedWrites: write.completedWrites,
      attemptedWrites: write.attemptedWrites,
    });
  }
  const diagnosticCounts = config.scanLogs ? await countLogPatternsFromOffsets(logOffsets) : undefined;
  const logScan = config.scanLogs ? await scanLogsFromOffsets(logOffsets) : undefined;
  if (logScan && diagnosticCounts) logScan.diagnosticCounts = diagnosticCounts;
  const finishedAt = performance.now();
  const ok = write.ok
    && !verificationError
    && replication.converged
    && samples.every((entry) => entry.ok)
    && metadata.every((entry) => entry.ok)
    && (logScan ? logScan.ok : true);
  const result = {
    benchmark: 'swm-triple-volume',
    ok,
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    durationMs: Number((finishedAt - startedAt).toFixed(2)),
    config: sanitizeConfig(config),
    plan,
    metadata,
    write: {
      ok: write.ok,
      durationMs: write.durationMs,
      attemptedWrites: write.attemptedWrites,
      completedWrites: write.completedWrites,
      summary: write.summary,
      intervals: write.intervals,
      diagnostics: write.diagnostics,
      error: write.error,
    },
    replication,
    samples,
    logScan,
    error: verificationError,
  };
  result.analysis = analyzeThroughput(result);
  return result;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseBenchmarkArgs(argv, env);
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runSwmTripleVolumeBenchmark(config);
  if (config.output) {
    mkdirSync(dirname(config.output), { recursive: true });
    writeFileSync(config.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  const analysisOutput = config.analysisOutput ?? defaultAnalysisOutput(config.output);
  if (analysisOutput) {
    mkdirSync(dirname(analysisOutput), { recursive: true });
    writeFileSync(analysisOutput, renderAnalysisMarkdown(result));
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
  buildBenchmarkPlan,
  buildWriteTasks,
  defaultAnalysisOutput,
  estimateQuadNQuadBytes,
  estimateQuadsNQuadBytes,
  makeObjectLexical,
  makeQuads,
  analyzeThroughput,
  parseBenchmarkArgs,
  renderAnalysisMarkdown,
  runSwmTripleVolumeBenchmark,
  usage,
};
