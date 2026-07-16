import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildKafkaStreamUrls,
  ensureContextGraph,
  fetchKaOnNode2,
  fetchListOnNode2,
  pollFinalized,
  resolveDemoDaemons,
  validateKafkaContextGraphConfig,
  verifyNode2Sync,
} from '../run.mjs';
test('run.mjs exposes pure helpers without executing the demo', () => {
  assert.equal(typeof buildKafkaStreamUrls, 'function');
});
test('resolveDemoDaemons lets only node1 honor DKG_API_PORT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kafka-streams-demo-run-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const node1Home = join(dir, 'node1');
  const node2Home = join(dir, 'node2');
  await Promise.all([mkdir(node1Home), mkdir(node2Home)]);
  await Promise.all([
    writeFile(join(node1Home, 'api.port'), '9301'),
    writeFile(join(node2Home, 'api.port'), '9503'),
    writeFile(join(node1Home, 'auth.token'), 't1'),
    writeFile(join(node2Home, 'auth.token'), 't2'),
  ]);
  const oldPort = process.env.DKG_API_PORT;
  process.env.DKG_API_PORT = '9402';
  try {
    const { node1, node2 } = await resolveDemoDaemons(node1Home, node2Home);
    assert.equal(node1.baseUrl, 'http://127.0.0.1:9402');
    assert.equal(node2.baseUrl, 'http://127.0.0.1:9503');
  } finally {
    if (oldPort === undefined) delete process.env.DKG_API_PORT;
    else process.env.DKG_API_PORT = oldPort;
  }
});
test('buildKafkaStreamUrls treats basePath as the full kafka streams mount root', () => {
  assert.deepEqual(
    buildKafkaStreamUrls('http://node1', '/custom/kafka/streams/', 'capture/1', 'did:dkg:31337:0xabc/9/0'),
    {
      register: 'http://node1/custom/kafka/streams/register',
      captureStatus: 'http://node1/custom/kafka/streams/register/capture%2F1',
      kaByUal: 'http://node1/custom/kafka/streams/did%3Adkg%3A31337%3A0xabc%2F9%2F0',
      list: 'http://node1/custom/kafka/streams',
    },
  );
});
test('ensureContextGraph registers on-chain after duplicate local create', async () => {
  const calls = [];
  await ensureContextGraph(
    { baseUrl: 'http://node1', token: 't' },
    'demo-cg',
    {
      httpJson: async (url, init) => {
        calls.push({ url, init });
        if (url === 'http://node1/api/context-graph/create') {
          return { status: 409, body: '{"error":"already exists"}', parsed: { error: 'already exists' } };
        }
        return { status: 200, body: '{"registered":"demo-cg"}', parsed: { registered: 'demo-cg' } };
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://node1/api/context-graph/register');
  assert.deepEqual(JSON.parse(calls[1].init.body), { id: 'demo-cg' });
});
test('ensureContextGraph accepts idempotent duplicate register responses with registered false', async () => {
  const calls = [];
  await ensureContextGraph({ baseUrl: 'http://node1', token: 't' }, 'demo-cg', {
    httpJson: async (url) => (calls.push(url) === 1
        ? { status: 200, body: '{"registered":false,"registerErrorStatus":409}', parsed: { registered: false, registerErrorStatus: 409 } }
        : { status: 409, body: '{"error":"already registered"}', parsed: { error: 'already registered' } }),
  });
  assert.equal(calls[1], 'http://node1/api/context-graph/register');
});
test('ensureContextGraph verifies on-chain registration after unclassified registered false', async () => {
  const calls = [];
  await ensureContextGraph({ baseUrl: 'http://node1', token: 't' }, 'demo-cg', {
    httpJson: async (url) => (calls.push(url) === 1
        ? { status: 200, body: '{"registered":false}', parsed: { registered: false } }
        : { status: 200, body: '{"registered":"demo-cg"}', parsed: { registered: 'demo-cg' } }),
  });
  assert.deepEqual(calls, [
    'http://node1/api/context-graph/create',
    'http://node1/api/context-graph/register',
  ]);
});
test('ensureContextGraph fails fast on non-idempotent register leg errors', async () => {
  await assert.rejects(
    ensureContextGraph({ baseUrl: 'http://node1', token: 't' }, 'demo-cg', {
      httpJson: async (url) => url.endsWith('/create')
        ? { status: 200, body: '{"registered":false}', parsed: { registered: false } }
        : { status: 403, body: '{"error":"denied"}', parsed: { error: 'denied' } },
    }),
    /register on node1 failed.*403/,
  );
});
async function writeNodeConfig(dkgHome, kafkaConfig) {
  await writeFile(
    join(dkgHome, 'config.json'),
    JSON.stringify({ kafka: kafkaConfig }, null, 2),
  );
}
async function writeNodeYamlConfig(dkgHome, contextGraphId) {
  await writeFile(
    join(dkgHome, 'config.yaml'),
    `kafka:\n  contextGraphId: ${contextGraphId}\n`,
  );
}
test('validateKafkaContextGraphConfig accepts matching kafka contextGraphId on both nodes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kafka-streams-demo-run-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const node1Home = join(dir, 'node1');
  const node2Home = join(dir, 'node2');
  await Promise.all([mkdir(node1Home), mkdir(node2Home)]);
  await writeNodeConfig(node1Home, { contextGraphId: 'demo-cg' });
  await writeNodeConfig(node2Home, { contextGraphId: 'demo-cg' });
  await validateKafkaContextGraphConfig([
    { label: 'node1', dkgHome: node1Home },
    { label: 'node2', dkgHome: node2Home },
  ], 'demo-cg');
  await writeNodeConfig(node2Home, undefined);
  await assert.rejects(
    validateKafkaContextGraphConfig([{ label: 'node2', dkgHome: node2Home }], 'demo-cg'),
    /node2.*missing.*demo-cg/,
  );
  await validateKafkaContextGraphConfig([{ label: 'node2', dkgHome: node2Home }], 'demo-cg', { allowFactoryContextGraph: true });
});
test('validateKafkaContextGraphConfig falls back from malformed config.json to config.yaml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kafka-streams-demo-run-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const node1Home = join(dir, 'node1');
  const node2Home = join(dir, 'node2');
  const node3Home = join(dir, 'node3');
  await Promise.all([mkdir(node1Home), mkdir(node2Home)]);
  await writeNodeYamlConfig(node1Home, 'demo-cg');
  await writeFile(join(node1Home, 'config.json'), '{');
  await writeNodeYamlConfig(node2Home, 'demo-cg');
  await validateKafkaContextGraphConfig([
    { label: 'node1', dkgHome: node1Home },
    { label: 'node2', dkgHome: node2Home },
  ], 'demo-cg');
  await mkdir(node3Home);
  await writeNodeConfig(node3Home, { contextGraphId: 'json-cg' });
  await writeNodeYamlConfig(node3Home, 'yaml-cg');
  await validateKafkaContextGraphConfig([{ label: 'node3', dkgHome: node3Home }], 'json-cg');
});
test('validateKafkaContextGraphConfig tolerates top-level routePlugins lists in config.yaml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kafka-streams-demo-run-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const node1Home = join(dir, 'node1');
  const node2Home = join(dir, 'node2');
  await Promise.all([mkdir(node1Home), mkdir(node2Home)]);
  const config = [
    'routePlugins:',
    '  - ./packages/kafka-plugin/dist/index.js',
    'kafka:',
    '  contextGraphId: demo-cg',
    '',
  ].join('\n');
  await writeFile(join(node1Home, 'config.yaml'), config);
  await writeFile(join(node2Home, 'config.yaml'), config);
  await validateKafkaContextGraphConfig([
    { label: 'node1', dkgHome: node1Home },
    { label: 'node2', dkgHome: node2Home },
  ], 'demo-cg');
});
test('validateKafkaContextGraphConfig rejects node1 and node2 kafka contextGraphId mismatches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kafka-streams-demo-run-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const node1Home = await mkdtemp(join(dir, 'node1-'));
  const node2Home = await mkdtemp(join(dir, 'node2-'));
  await writeNodeConfig(node1Home, { contextGraphId: 'wrong-node1' });
  await writeNodeConfig(node2Home, { contextGraphId: 'wrong-node2' });
  await assert.rejects(
    validateKafkaContextGraphConfig([
      { label: 'node1', dkgHome: node1Home },
      { label: 'node2', dkgHome: node2Home },
    ], 'demo-cg'),
    (err) => {
      assert.match(err.message, /node1.*wrong-node1/);
      assert.match(err.message, /node2.*wrong-node2/);
      assert.match(err.message, /demo-cg/);
      return true;
    },
  );
});
test('pollFinalized fails fast on capture-status client errors with status and body', async () => {
  let calls = 0;
  await assert.rejects(
    pollFinalized(
      { baseUrl: 'http://node1', token: 't' },
      'capture-1',
      {
        basePath: '/api/kafka/streams',
        intervalMs: 1,
        timeoutMs: 50,
        httpJson: async () => {
          calls += 1;
          return { status: 401, body: '{"error":"bad token"}', parsed: { error: 'bad token' } };
        },
      },
    ),
    /capture status.*401.*bad token/,
  );
  assert.equal(calls, 1);
});
test('pollFinalized retries transient capture-status HTTP responses', async () => {
  const responses = [
    { status: 503, body: 'warming up' },
    { status: 200, body: '{"state":"finalized","ual":"ual-1"}', parsed: { state: 'finalized', ual: 'ual-1' } },
  ];
  let calls = 0;
  const final = await pollFinalized(
    { baseUrl: 'http://node1', token: 't' },
    'capture-1',
    {
      basePath: '/api/kafka/streams',
      intervalMs: 1,
      timeoutMs: 1000,
      httpJson: async () => responses[calls++],
    },
  );
  assert.equal(calls, 2);
  assert.equal(final.ual, 'ual-1');
});
test('fetchListOnNode2 fails fast on non-transient list errors', async () => {
  for (const status of [401, 403, 404, 418]) {
    let calls = 0;
    await assert.rejects(
      fetchListOnNode2(
        { baseUrl: 'http://node2', token: 't' },
        'ual-1',
        {
          basePath: '/api/kafka/streams',
          deadlineMs: Date.now() + 1000,
          httpJson: async () => {
            calls += 1;
            return { status, body: `problem-${status}` };
          },
          sleep: async () => {
            throw new Error('should not sleep after non-transient list error');
          },
        },
      ),
      new RegExp(`node2 list.*${status}.*problem-${status}`),
    );
    assert.equal(calls, 1);
  }
});
test('fetchListOnNode2 retries transient list errors before finding the UAL', async () => {
  const responses = [
    { status: 503, body: 'not ready' },
    { status: 200, body: '{"items":[{"@id":"ual-1"}]}', parsed: { items: [{ '@id': 'ual-1' }] } },
  ];
  let calls = 0;
  let sleeps = 0;
  const list = await fetchListOnNode2(
    { baseUrl: 'http://node2', token: 't' },
    'ual-1',
    {
      basePath: '/api/kafka/streams',
      deadlineMs: Date.now() + 1000,
      intervalMs: 1,
      httpJson: async () => responses[calls++],
      sleep: async () => {
        sleeps += 1;
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.equal(list.items[0]['@id'], 'ual-1');
});
test('fetchKaOnNode2 keeps retrying 404 while waiting for cross-node gossip', async () => {
  const responses = [
    { status: 404, body: 'not gossiped yet' },
    { status: 200, body: '{"@id":"ual-1"}', parsed: { '@id': 'ual-1' } },
  ];
  let calls = 0;
  let sleeps = 0;
  const ka = await fetchKaOnNode2(
    { baseUrl: 'http://node2', token: 't' },
    'ual-1',
    {
      basePath: '/api/kafka/streams',
      deadlineMs: Date.now() + 1000,
      intervalMs: 1,
      httpJson: async () => responses[calls++],
      sleep: async () => {
        sleeps += 1;
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.equal(ka['@id'], 'ual-1');
});
test('verifyNode2Sync gives list verification a fresh sync timeout budget', async () => {
  const deadlines = [];
  const nowValues = [1000, 5000];
  await verifyNode2Sync({
    node2: { baseUrl: 'http://node2', token: 't' },
    ual: 'ual-1',
    body: {},
    syncTimeoutMs: 250,
    now: () => nowValues.shift(),
    fetchKa: async (_auth, _ual, options) => {
      deadlines.push(['ka', options.deadlineMs]);
      return { '@id': 'ual-1' };
    },
    fetchList: async (_auth, _ual, options) => {
      deadlines.push(['list', options.deadlineMs]);
      return { items: [{ '@id': 'ual-1' }] };
    },
    assertKa: () => {},
    assertList: () => {},
  });
  assert.deepEqual(deadlines, [
    ['ka', 1250],
    ['list', 5250],
  ]);
});
