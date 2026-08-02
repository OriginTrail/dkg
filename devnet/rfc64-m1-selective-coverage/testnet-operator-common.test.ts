import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRfc64SemanticSnapshot } from '../_bootstrap/rfc64-evidence.ts';
import {
  TESTNET_OPERATOR_CONFIG_SCHEMA,
  observeGraph,
  readTestnetOperatorConfig,
  type TestnetOperatorConfigV1,
  type TestnetOperatorGraphV1,
  type TestnetOperatorRoleV1,
} from './testnet-operator-common.ts';

const graph = (index: number): TestnetOperatorGraphV1 => ({
  contextGraphId: `cg-${index}`,
  accessPolicy: index > 3 ? 1 : 0,
  publishPolicy: index % 2 as 0 | 1,
  edgePolicy: index === 1 ? 'on-demand' : index === 2 ? 'always-on' : 'unselected',
  assets: [
    { name: `selected-${index}`, subject: `urn:test:g${index}:selected`, ual: `did:dkg:test/0x${'1'.repeat(40)}/${index}`, wave: 'selected' },
    { name: `final-${index}`, subject: `urn:test:g${index}:final`, ual: `did:dkg:test/0x${'2'.repeat(40)}/${index}`, wave: 'final' },
  ],
});

function config(apiUrl = 'http://127.0.0.1:9999'): TestnetOperatorConfigV1 {
  const role: TestnetOperatorRoleV1 = {
    transport: 'local',
    apiUrl,
    repoRoot: '/tmp/repo',
    dataDir: '/tmp/data',
    command: ['node', 'daemon.js'],
    environment: {},
  };
  return {
    schema: TESTNET_OPERATOR_CONFIG_SCHEMA,
    roles: { publisher: role, edge: role, core: role },
    graphs: [1, 2, 3, 4, 5].map(graph),
    pollIntervalMs: 10,
    operationTimeoutMs: 100,
  };
}

test('operator config decoder accepts the closed five-graph plan and rejects unknown input', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'rfc64-m1-operator-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.json');
  writeFileSync(path, JSON.stringify(config()));
  const decoded = readTestnetOperatorConfig(path);
  assert.equal(decoded.graphs.length, 5);
  assert.equal(Object.isFrozen(decoded.graphs), true);

  writeFileSync(path, JSON.stringify({ ...config(), typoThatWouldOtherwiseBeIgnored: true }));
  assert.throws(() => readTestnetOperatorConfig(path), /operator config has an invalid key set/u);
});

test('exact graph observation derives VM and SWM evidence from scoped data and metadata queries', async (context) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const sparql = String(body['sparql']);
      const bindings = sparql.includes('COUNT(*)')
        ? [{ count: { type: 'literal', value: '7', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }]
        : [
            { s: { type: 'uri', value: 'urn:test:g1:selected' }, p: { type: 'uri', value: 'urn:test:p:1' }, o: { type: 'literal', value: 'alpha' } },
            { s: '<urn:test:g1:selected>', p: '<urn:test:p:2>', o: '<urn:test:o:2>' },
          ];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: { bindings } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  const role = config(`http://127.0.0.1:${address.port}`).roles.publisher;
  const plan = graph(1);

  const observed = await observeGraph(role, plan);
  const expected = await createRfc64SemanticSnapshot([{
    ual: plan.assets[0]!.ual,
    semanticNQuads: [
      `<${plan.assets[0]!.subject}> <urn:test:p:1> "alpha" .`,
      `<${plan.assets[0]!.subject}> <urn:test:p:2> <urn:test:o:2> .`,
    ],
  }]);
  for (const plane of [observed.vm, observed.swm]) {
    assert.equal(plane.reportedComplete, true);
    assert.equal(plane.headDigest, expected.ualsSha256);
    assert.equal(plane.inventoryDigest, expected.semanticNQuadsSha256);
    assert.equal(plane.assetCount, 1);
    assert.equal(plane.dataTripleCount, 2);
    assert.equal(plane.metadataTripleCount, 7);
  }
  assert.equal(requests.length, 4);
  assert.equal(requests.filter((body) => body['includeContextGraphPartitions'] === true).length, 2);
  assert.deepEqual(
    new Set(requests.filter((body) => body['view']).map((body) => body['view'])),
    new Set(['verifiable-memory', 'shared-working-memory']),
  );
});

test('exact graph observation rejects unplanned payload anywhere in the scoped plane', async (context) => {
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const bindings = String(body['sparql']).includes('COUNT(*)')
        ? [{ count: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }]
        : [{ s: '<urn:test:unexpected>', p: '<urn:test:p>', o: '"extra"' }];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: { bindings } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  const role = config(`http://127.0.0.1:${address.port}`).roles.publisher;

  await assert.rejects(
    observeGraph(role, graph(1)),
    /contains an unplanned subject/u,
  );
});
