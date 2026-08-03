#!/usr/bin/env node
// Execute the GENERATED worker-pressure flamegraph and heatmap queries against
// the repository's pinned Loki. Structural JSON checks cannot catch valid
// LogQL that silently returns no rows (for example a misspelled JSON age
// field), and a parser cannot prove the scheduler/lane/operation labels or
// peak values. This fixture covers both, plus the Loki 3 resource contract for
// the fixed-window instant flamegraph.
//
// The caller owns the disposable Loki process:
//   LOKI_URL=http://127.0.0.1:13100 node verify-backpressure-logql.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKPRESSURE_FLAME_LOOKBACK } from './lib/queries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOKI = (process.env.LOKI_URL ?? 'http://127.0.0.1:13100').replace(/\/$/, '');
const MAX_SPLITS = 0;
const MAX_QUEUE_TIME_SECONDS = 2;

const fail = (message) => { throw new Error(`backpressure LogQL verify: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (endpoint, { json, params } = {}) => {
  const response = await fetch(`${LOKI}${endpoint}`, json ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  } : {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  if (!response.ok) fail(`${endpoint} returned HTTP ${response.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : null;
};

const node = `logql-contract-${Date.now()}`;
const nowMs = Date.now();
const ns = (offsetMs) => String(BigInt(nowMs + offsetMs) * 1_000_000n);
const line = (payload) => `[backpressure] ${JSON.stringify(payload)}`;

const records = [
  [-300_000, {
    scheduler: 'sync-global', lane: 'durable', oldestActiveAgeMs: 1800, oldestQueuedAgeMs: 3400,
    activeOperations: [
      { operation: 'catchup-foreground', oldestAgeMs: 1800 },
      { operation: 'reconcile', oldestAgeMs: 1500 },
    ],
    queuedOperations: [
      { operation: 'on-connect', oldestAgeMs: 3400 },
      {},
    ],
  }],
  [-120_000, {
    scheduler: 'sync-global', lane: 'durable', oldestActiveAgeMs: 2400, oldestQueuedAgeMs: 3000,
    // Both named operations moved slots; the empty object proves unused slots
    // are ignored rather than becoming an unlabeled zero-valued series.
    activeOperations: [
      { operation: 'reconcile', oldestAgeMs: 1100 },
      { operation: 'catchup-foreground', oldestAgeMs: 2400 },
    ],
    queuedOperations: [
      {},
      { operation: 'on-connect', oldestAgeMs: 3000 },
    ],
  }],
  [-60_000, {
    scheduler: 'sync-global', lane: 'durable', oldestActiveAgeMs: 2100, oldestQueuedAgeMs: 0,
    activeOperations: [{}, { operation: 'catchup-foreground', oldestAgeMs: 2100 }],
    queuedOperations: [{}],
  }],
];

await request('/loki/api/v1/push', {
  json: {
    streams: [{
      stream: { service_name: 'dkg-node', service_instance_id: node },
      values: records.map(([offset, payload]) => [ns(offset), line(payload)]),
    }],
  },
});

const dashboard = JSON.parse(fs.readFileSync(path.join(HERE, 'grafana-dashboard-dkg-node-logs.json'), 'utf8'));
const flame = dashboard.panels.find((panel) => panel.type === 'flamegraph' && panel.title?.startsWith('Worker queue pressure'));
assert(flame, 'generated worker-pressure flamegraph is missing');
assert(flame.title.includes('last 1 hour'), `flamegraph title does not disclose its fixed scope: ${flame.title}`);
assert((flame.targets ?? []).map((target) => target.refId).join('') === 'ABCDE', 'flamegraph target order must remain ABCDE');

const fixedWindow = `[${BACKPRESSURE_FLAME_LOOKBACK}]`;
for (const target of flame.targets) {
  assert(!target.expr.includes('$__range'), `target ${target.refId} still inherits the selected Grafana range`);
  assert(target.expr.includes(fixedWindow), `target ${target.refId} does not contain fixed lookback ${fixedWindow}`);
  assert(target.instant === true && target.queryType === 'instant', `target ${target.refId} is no longer an instant flamegraph row`);
}

const queryInstant = async (query) => request('/loki/api/v1/query', {
  params: { query, time: String(nowMs * 1_000_000) },
});
const queryRange = async (query) => request('/loki/api/v1/query_range', {
  params: {
    query,
    start: String((nowMs - 10 * 60_000) * 1_000_000),
    end: String(nowMs * 1_000_000),
    step: '30',
  },
});
const withNode = (expr) => expr.replaceAll('$node', node);

let instantResults;
for (let attempt = 0; attempt < 20; attempt++) {
  instantResults = [];
  for (const target of flame.targets) instantResults.push([target, await queryInstant(withNode(target.expr))]);
  if (instantResults.find(([target]) => target.refId === 'C')[1].data.result.length) break;
  await sleep(250);
}

const byRef = Object.fromEntries(instantResults.map(([target, result]) => [target.refId, result]));
for (const [refId, response] of Object.entries(byRef)) {
  assert(response.status === 'success' && response.data.resultType === 'vector', `target ${refId} did not return a successful vector`);
  const summary = response.data.stats?.summary;
  assert(summary, `target ${refId} response omitted Loki query statistics`);
  const splits = Number(summary.splits);
  const queueTime = Number(summary.queueTime);
  assert(Number.isFinite(splits) && splits <= MAX_SPLITS,
    `target ${refId} used ${splits} internal splits (maximum ${MAX_SPLITS})`);
  assert(Number.isFinite(queueTime) && queueTime <= MAX_QUEUE_TIME_SECONDS,
    `target ${refId} used ${queueTime}s aggregate queue time (maximum ${MAX_QUEUE_TIME_SECONDS}s)`);
}

const scalar = (refId) => {
  const result = byRef[refId].data.result;
  assert(result.length === 1, `target ${refId} returned ${result.length} samples, want one`);
  return Number(result[0].value[1]);
};
assert(scalar('A') === 7300, `root width is ${scalar('A')}, want 7300`);
assert(scalar('B') === 3900, `active parent width is ${scalar('B')}, want 3900`);
assert(scalar('D') === 3400, `queued parent width is ${scalar('D')}, want 3400`);

const leafMap = (refId) => new Map(byRef[refId].data.result.map(({ metric, value }) => [
  [metric.scheduler, metric.lane, metric.phase, metric.operation].join('|'),
  Number(value[1]),
]));
const active = leafMap('C');
const queued = leafMap('E');
assert(active.size === 2, `active leaves=${active.size}, want 2 (empty slots must not leak)`);
assert(active.get('sync-global|durable|active|catchup-foreground') === 2400, 'active catchup-foreground peak is not 2400 ms');
assert(active.get('sync-global|durable|active|reconcile') === 1500, 'active reconcile peak is not 1500 ms after moving slots');
assert(queued.size === 1, `queued leaves=${queued.size}, want 1 (empty slots must not leak)`);
assert(queued.get('sync-global|durable|queued|on-connect') === 3400, 'queued on-connect peak is not 3400 ms after moving slots');

const heatmaps = dashboard.panels.filter((panel) => panel.type === 'heatmap'
  && (panel.title?.startsWith('Active / admitted') || panel.title?.startsWith('Queued / waiting')));
assert(heatmaps.length === 2, `worker-pressure heatmaps=${heatmaps.length}, want 2`);
for (const panel of heatmaps) {
  const target = panel.targets?.[0];
  assert(target?.queryType === 'range', `${panel.title} is not a range query`);
  const response = await queryRange(withNode(target.expr).replaceAll('$__auto', '5m'));
  assert(response.status === 'success' && response.data.resultType === 'matrix', `${panel.title} did not return a successful matrix`);
  assert(response.data.result.length === 1, `${panel.title} returned ${response.data.result.length} series, want one scheduler/lane series`);
  const [{ metric, values }] = response.data.result;
  assert(metric.scheduler === 'sync-global' && metric.lane === 'durable', `${panel.title} lost scheduler/lane grouping`);
  const peak = Math.max(...values.map(([, value]) => Number(value)));
  const expected = panel.title.startsWith('Active') ? 2400 : 3400;
  assert(peak === expected, `${panel.title} peak=${peak}, want ${expected}`);
}

const maxQueue = Math.max(...Object.values(byRef).map((response) => Number(response.data.stats.summary.queueTime)));
console.log(`backpressure LogQL verify OK: 5 flame targets + 2 heatmaps; fixed=${fixedWindow}; max_splits=0; max_queue=${maxQueue.toFixed(6)}s`);
