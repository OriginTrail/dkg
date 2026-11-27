import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  encodeWorkspaceEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import { runBuildFixtureCli } from './build-fixture.js';
import { runCharacterizationCli } from './characterize.js';
import {
  assertLocalEndpoint,
  classifyProfileDisposition,
  collectPopulation,
  decodeSparqlResults,
  extractR27Fixture,
  rowToNQuad,
  valuesBatches,
  type SparqlTerm,
} from './extract-rdf.js';
import { characterizeFixtureV1 } from './model.js';

const ROOT = 'did:dkg:agent:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PEER = '12D3KooWDxBauQDeJjCmcvWiREFALfKsr5VfTzGUJbZJ6CUcc7aF';
const SECOND_PEER = '12D3KooWAbxJCdeDKf8dsFf14mWuSonPP1PoxCyPnFB7pdPic6w6';
const PUBLIC_KEY = encodeWorkspaceEncryptionKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const KEY_ID = workspaceAgentEncryptionKeyId(ROOT.slice('did:dkg:agent:'.length), Buffer.from(PUBLIC_KEY, 'base64url'));

test('extracts active roots through bounded POST queries and redacts exact timestamps', async () => {
  const queries: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const query = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('query') ?? '';
    queries.push(query);
    const bindings = query.includes('SELECT ?root ?peer ?seen')
      ? [populationRow()]
      : query.includes('SELECT ?root ?s ?p ?o')
        ? rootRows()
        : query.includes('SELECT ?s ?p ?o')
          ? nestedRows()
          : [];
    response.writeHead(200, { 'content-type': 'application/sparql-results+json' });
    response.end(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind TCP');
  const directory = await mkdtemp(join(tmpdir(), 'dkg-2052-extract-'));
  const systemSyncPath = join(directory, 'system-sync.json');
  await writeFile(
    systemSyncPath,
    JSON.stringify({
      schemaVersion: 1,
      captureStartedAt: '2026-08-04T11:00:00.000Z',
      captureEndedAt: '2026-08-04T13:00:00.000Z',
      diagnosticsArtifactSha256: `sha256:${'a'.repeat(64)}`,
      sourceUrls: ['https://github.com/OriginTrail/dkg/issues/2052'],
      observations: [],
    }),
    'utf8',
  );
  try {
    const fixture = await extractR27Fixture({
      endpoint: new URL(`http://127.0.0.1:${address.port}`),
      output: join(directory, 'fixture.json'),
      observationTime: '2026-08-04T13:00:00.000Z',
      sourceCommit: 'c297a7b6ffb6df82305c1f7eb76864a8b7a77c35',
      systemSyncPath,
    });
    assert.equal(fixture.profilePopulation.activeProfiles, 1);
    assert.equal(
      fixture.profiles[0].rootSubject,
      'did:dkg:agent:0x0000000000000000000000000000000000000001',
    );
    assert.equal(fixture.profiles[0].disposition, 'candidate');
    assert.equal(fixture.profiles[0].lastSeenAgeBucket, 'under-1h');
    assert.deepEqual(fixture.profiles[0].peerKeys, ['peer:0001']);
    assert.deepEqual(fixture.profiles[0].derivedSubjects, [
      `${fixture.profiles[0].rootSubject}#fixture-x25519-0001`,
    ]);
    assert.ok(fixture.profiles[0].quads.some((quad) => (
      quad.predicate === 'https://dkg.network/ontology#revokedBy'
      && quad.objectOwnedSubject === fixture.profiles[0].rootSubject
    )));
    assert.ok(!JSON.stringify(fixture).includes(PEER));
    assert.ok(!JSON.stringify(fixture).includes(ROOT));
    assert.ok(!JSON.stringify(fixture).includes('2026-08-04T12:30:00'));
    assert.ok(queries.every((query) => !query.includes('FILTER(STR(?seen)')));
    assert.ok(queries.every((query) => query.length < 16_384));
    assert.deepEqual(characterizeFixtureV1(fixture).invalidOwnedSubjects, []);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects blank nodes at the evidence boundary', () => {
  assert.throws(() => rowToNQuad({
    root: uri(ROOT),
    s: uri(ROOT),
    p: uri('https://schema.org/name'),
    o: { type: 'bnode', value: 'untrusted' },
  }), /object must not be a blank node/);
  assert.throws(() => rowToNQuad({
    root: uri(ROOT),
    s: { type: 'bnode', value: 'untrusted' },
    p: uri('https://schema.org/name'),
    o: literal('value'),
  }), /subject must be an IRI/);
});

test('decodes SPARQL JSON at one validated boundary', () => {
  assert.deepEqual(
    decodeSparqlResults({ results: { bindings: [{ root: uri(ROOT) }] } }),
    [{ root: uri(ROOT) }],
  );
  assert.throws(
    () => decodeSparqlResults({
      results: { bindings: [{ root: { type: 'uri', value: 123 } }] },
    }),
    /SPARQL term is malformed/,
  );
});

test('accepts only unauthenticated localhost HTTP extraction endpoints', () => {
  assert.doesNotThrow(() => assertLocalEndpoint(new URL('http://127.0.0.1:17880')));
  assert.doesNotThrow(() => assertLocalEndpoint(new URL('http://localhost:17880')));
  assert.throws(
    () => assertLocalEndpoint(new URL('http://192.0.2.10:17880')),
    /local HTTP endpoint/,
  );
  assert.throws(
    () => assertLocalEndpoint(new URL('https://localhost:17880')),
    /local HTTP endpoint/,
  );
  assert.throws(
    () => assertLocalEndpoint(new URL('http://user:secret@localhost:17880')),
    /local HTTP endpoint/,
  );
});

test('does not follow a localhost SPARQL redirect', async () => {
  let redirectedRequests = 0;
  const captureServer = createServer((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => captureServer.listen(0, '127.0.0.1', resolve));
  const captureAddress = captureServer.address();
  if (!captureAddress || typeof captureAddress === 'string') {
    throw new Error('capture server did not bind TCP');
  }
  const redirectServer = createServer((_request, response) => {
    response.writeHead(307, {
      location: `http://127.0.0.1:${captureAddress.port}/capture`,
    }).end();
  });
  await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
  const redirectAddress = redirectServer.address();
  if (!redirectAddress || typeof redirectAddress === 'string') {
    throw new Error('redirect server did not bind TCP');
  }
  try {
    await assert.rejects(() => extractR27Fixture({
      endpoint: new URL(`http://127.0.0.1:${redirectAddress.port}`),
      output: '/tmp/dkg-2052-redirect-must-not-write.json',
      observationTime: '2026-08-04T13:00:00.000Z',
      sourceCommit: 'c297a7b6ffb6df82305c1f7eb76864a8b7a77c35',
      systemSyncPath: '/tmp/dkg-2052-redirect-must-not-read.json',
    }));
    assert.equal(redirectedRequests, 0);
  } finally {
    redirectServer.close();
    captureServer.close();
  }
});

test('rejects secret-bearing subject paths and predicates before fixture serialization', async () => {
  const secret = '12D3KooW-secret-token-abc123';
  let maliciousRow: Record<string, unknown> = {
    s: uri(`${ROOT}/.well-known/${secret}`),
    p: uri('https://schema.org/name'),
    o: literal('hidden'),
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const query = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('query') ?? '';
    const bindings = query.includes('SELECT ?root ?peer ?seen')
      ? [populationRow()]
      : query.includes('SELECT ?root ?s ?p ?o')
        ? rootRows()
        : query.includes('SELECT ?s ?p ?o')
          ? [maliciousRow]
          : [];
    response.writeHead(200, { 'content-type': 'application/sparql-results+json' });
    response.end(JSON.stringify({ head: { vars: [] }, results: { bindings } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind TCP');
  const directory = await mkdtemp(join(tmpdir(), 'dkg-2052-redaction-'));
  const systemSyncPath = join(directory, 'system-sync.json');
  await writeFile(systemSyncPath, JSON.stringify({
    schemaVersion: 1,
    captureStartedAt: '2026-08-04T11:00:00.000Z',
    captureEndedAt: '2026-08-04T13:00:00.000Z',
    diagnosticsArtifactSha256: `sha256:${'a'.repeat(64)}`,
    sourceUrls: ['https://github.com/OriginTrail/dkg/issues/2052'],
    observations: [],
  }), 'utf8');
  const extract = () => extractR27Fixture({
    endpoint: new URL(`http://127.0.0.1:${address.port}`),
    output: join(directory, 'fixture.json'),
    observationTime: '2026-08-04T13:00:00.000Z',
    sourceCommit: 'c297a7b6ffb6df82305c1f7eb76864a8b7a77c35',
    systemSyncPath,
  });
  try {
    await assert.rejects(extract, (error: Error) => {
      assert.match(error.message, /outside the frozen owned grammar/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
    maliciousRow = {
      s: uri(`${ROOT}/.well-known/genid/hosting`),
      p: uri(`https://example.invalid/${secret}`),
      o: literal('hidden'),
    };
    await assert.rejects(extract, (error: Error) => {
      assert.match(error.message, /outside the frozen allowlist/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('models missing/multiple peer identities and bounded root batches', () => {
  const missing = collectPopulation([{
    root: uri(`${ROOT.slice(0, -1)}2`),
    seen: literal('malformed'),
  }]).values().next().value;
  assert.ok(missing);
  assert.equal(missing.peers.size, 0);
  assert.equal(missing.lastSeen.length, 0);
  assert.equal(classifyProfileDisposition(missing, new Map()), 'missing-peer');

  const multiple = collectPopulation([
    { root: uri(ROOT), peer: literal(PEER), seen: literal('2026-08-04T12:00:00+00:00') },
    { root: uri(ROOT), peer: literal(SECOND_PEER), seen: literal('2026-08-04T12:00:00Z') },
  ]).get(ROOT);
  assert.ok(multiple);
  assert.equal(classifyProfileDisposition(multiple, new Map()), 'multi-peer-root');

  const onePeer = { root: ROOT, peers: new Set([PEER]), lastSeen: [] };
  assert.equal(
    classifyProfileDisposition(onePeer, new Map([[PEER, new Set([ROOT, `${ROOT}:other`])]])),
    'peer-multi-root',
  );
  assert.deepEqual(valuesBatches(Array.from({ length: 257 }, (_, index) => index), 256).map((v) => v.length), [256, 1]);
});

test('rejects malformed peer terms before they become record identities', () => {
  for (const peer of [
    uri('https://example.invalid/not-a-peer'),
    { type: 'bnode', value: 'peer-node' } as SparqlTerm,
    literal('not-a-libp2p-peer-id'),
  ]) {
    assert.throws(
      () => collectPopulation([{ root: uri(ROOT), peer }]),
      /canonical libp2p literal/,
    );
  }
});

test('the CLI names and enforces only the load-envelope sub-gate', async () => {
  const output: string[] = [];
  assert.equal(await runCharacterizationCli(['--fixture', 'r27'], output.push.bind(output)), 0);
  assert.match(output.join(''), /Load envelope:/);
  assert.equal(
    await runCharacterizationCli(['--fixture', 'r27', '--require-load-envelope'], () => undefined),
    1,
  );
  await assert.rejects(
    runCharacterizationCli(['--fixture', 'r27', '--require-activation'], () => undefined),
    /unknown argument/,
  );
});

test('the fixture check fails closed when committed evidence drifts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-2052-fixture-drift-'));
  const output = join(directory, 'drifted-fixture.json');
  await writeFile(output, '{}\n', 'utf8');
  try {
    assert.equal(
      await runBuildFixtureCli([
        '--source',
        join(import.meta.dirname, 'inputs/r27-redacted-source-v1.json'),
        '--output',
        output,
        '--check',
      ]),
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the committed sanitized source rebuilds the committed fixture byte for byte', async () => {
  assert.equal(
    await runBuildFixtureCli([
      '--source',
      join(import.meta.dirname, 'inputs/r27-redacted-source-v1.json'),
      '--output',
      join(import.meta.dirname, 'fixtures/r27-v1.json'),
      '--check',
    ]),
    0,
  );
});

function populationRow(): Record<string, unknown> {
  return {
    root: uri(ROOT),
    peer: literal(PEER),
    seen: literal('2026-08-04T12:30:00+00:00', 'http://www.w3.org/2001/XMLSchema#dateTime'),
  };
}

function rootRows(): Array<Record<string, unknown>> {
  return [
    row(ROOT, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', uri('https://dkg.network/ontology#Agent')),
    row(ROOT, 'https://dkg.network/ontology#peerId', literal(PEER)),
    row(ROOT, 'https://dkg.network/ontology#lastSeen', literal('2026-08-04T12:30:00+00:00')),
    row(ROOT, 'https://dkg.network/ontology#publicEncryptionKey', literal(PUBLIC_KEY)),
    row(ROOT, 'http://www.w3.org/ns/prov#wasGeneratedBy', uri(`${ROOT}/.well-known/genid/registration`)),
  ];
}

function nestedRows(): Array<Record<string, unknown>> {
  return [
    {
      s: uri(`${ROOT}/.well-known/genid/registration`),
      p: uri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      o: uri('http://www.w3.org/ns/prov#Activity'),
    },
    {
      s: uri(KEY_ID),
      p: uri('https://dkg.network/ontology#revokedAt'),
      o: literal('2026-08-04T12:00:00.000Z'),
    },
    {
      s: uri(KEY_ID),
      p: uri('https://dkg.network/ontology#revokedBy'),
      o: uri(ROOT),
    },
  ];
}

function row(subject: string, predicate: string, object: unknown): Record<string, unknown> {
  return { root: uri(ROOT), s: uri(subject), p: uri(predicate), o: object };
}

function uri(value: string): SparqlTerm {
  return { type: 'uri', value };
}

function literal(value: string, datatype?: string): SparqlTerm {
  return datatype ? { type: 'literal', value, datatype } : { type: 'literal', value };
}
