import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../../../cli/src/api-client.js';
import { buildKafkaEndpointUri } from '../../src/uri.js';
import {
  startPlaintextKafka,
  type PlaintextKafka,
} from '../helpers/kafka-container.js';
import { createTopicAndProduce } from '../helpers/synthetic-producer.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js');
const DEVNET_NODE1_HOME =
  process.env.DKG_KAFKA_DEVNET_HOME ?? join(REPO_ROOT, '.devnet', 'node1');
const RUN_E2E =
  process.env.DKG_KAFKA_E2E === '1' || process.env.DKG_KAFKA_E2E === 'true';
const CONTEXT_GRAPH_ID = 'devnet-test';

function parseTokenFile(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#')) ?? '';
}

function stripQuotedLiteral(value: string): string {
  const typed = value.match(/^"(.*)"(?:\^\^<.*>)?$/s);
  return typed ? typed[1] : value;
}

function stripIriDelimiters(value: string): string {
  if (value.startsWith('<') && value.endsWith('>')) {
    return value.slice(1, -1);
  }
  return value;
}

function agentAddressFromUri(agentUri: string): string {
  if (agentUri.startsWith('urn:dkg:agent:')) {
    return agentUri.slice('urn:dkg:agent:'.length);
  }
  if (agentUri.startsWith('did:dkg:agent:')) {
    return agentUri.slice('did:dkg:agent:'.length);
  }
  throw new Error(`Unsupported agent URI: ${agentUri}`);
}

async function waitForEndpointRow(
  client: ApiClient,
  contextGraphId: string,
  uri: string,
): Promise<Record<string, string>> {
  // Endpoint triples land in a named graph (one per CG), so the WHERE
  // pattern must be wrapped in GRAPH ?g. Default-graph patterns return
  // empty bindings against this store — see daemon/routes/query.ts.
  const sparql = `
    PREFIX dcat: <http://www.w3.org/ns/dcat#>
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX dkg: <https://ontology.dkg.io/dkg#>
    SELECT ?broker ?topic ?messageFormat ?publisher ?endpointUrl ?issued
           ?verificationStatus ?verifiedAt ?securityProtocol
    WHERE {
      GRAPH ?g {
        BIND(<${uri}> AS ?endpoint)
        ?endpoint a dkg:KafkaTopicEndpoint, dcat:DataService ;
          dkg:broker ?broker ;
          dkg:topic ?topic ;
          dkg:messageFormat ?messageFormat ;
          dct:publisher ?publisher ;
          dct:issued ?issued ;
          dcat:endpointURL ?endpointUrl .
        OPTIONAL { ?endpoint dkg:verificationStatus ?verificationStatus }
        OPTIONAL { ?endpoint dkg:verifiedAt ?verifiedAt }
        OPTIONAL { ?endpoint dkg:securityProtocol ?securityProtocol }
      }
    }
  `;

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await client.query(sparql, contextGraphId);
    // Daemon's /api/query response is { result: { bindings: [...] } } — the
    // optional `type` discriminator on QueryResult is only set on a couple
    // of legacy paths and is absent here, so we key off `bindings` directly.
    const bindings = (response.result as { bindings?: Array<Record<string, string>> }).bindings;
    if (Array.isArray(bindings) && bindings.length > 0) {
      return bindings[0]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Kafka endpoint ${uri} was not queryable in ${contextGraphId} within 20s`);
}

describe('kafka walking skeleton e2e', () => {
  let devnetReachable = false;
  let port = 0;
  let token = '';
  let client: ApiClient;
  let owner = '';

  beforeAll(async () => {
    if (!RUN_E2E) return;

    try {
      await access(CLI_ENTRY, constants.F_OK);
    } catch {
      await execFileAsync('pnpm', ['--dir', 'packages/cli', 'build'], {
        cwd: REPO_ROOT,
      });
    }

    const [tokenRaw, portRaw] = await Promise.all([
      readFile(join(DEVNET_NODE1_HOME, 'auth.token'), 'utf8'),
      readFile(join(DEVNET_NODE1_HOME, 'api.port'), 'utf8'),
    ]);

    token = parseTokenFile(tokenRaw);
    port = parseInt(portRaw.trim(), 10);
    client = new ApiClient(port, token);

    try {
      const status = await client.status();
      devnetReachable = typeof status.peerId === 'string' && status.peerId.length > 0;
    } catch {
      devnetReachable = false;
    }

    if (!devnetReachable) return;

    const agents = await client.agents();
    const selfAgent = agents.agents.find((agent) => (agent as any).connectionStatus === 'self');
    const agentUri = selfAgent?.agentUri;
    const agentAddress = (selfAgent as any)?.agentAddress;
    if (!agentUri || (!agentAddress && !agentUri.startsWith('urn:dkg:agent:') && !agentUri.startsWith('did:dkg:agent:'))) {
      throw new Error(`Could not resolve publishing agent identity from /api/agents`);
    }
    owner = String(agentAddress ?? agentAddressFromUri(agentUri)).toLowerCase();
  }, 120_000);

  beforeEach(({ skip }) => {
    if (!RUN_E2E || !devnetReachable) skip();
  });

  it('registers a Kafka endpoint into the named context graph and discovers it via SPARQL', async () => {
    const broker = 'kafka.e2e.local:9092';
    const topic = `walking-skeleton.${Date.now()}`;
    const messageFormat = 'application/cloudevents+json';
    const expectedUri = buildKafkaEndpointUri({ owner, broker, topic });

    const result = await execFileAsync(
      'node',
      [
        CLI_ENTRY,
        'kafka',
        'endpoint',
        'register',
        '--cg',
        CONTEXT_GRAPH_ID,
        '--broker',
        broker,
        '--topic',
        topic,
        '--format',
        messageFormat,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DKG_HOME: DEVNET_NODE1_HOME,
          DKG_API_PORT: String(port),
        },
      },
    );

    expect(result.stdout).toContain('Kafka endpoint registered:');
    expect(result.stdout).toContain(expectedUri);
    expect(result.stdout).toContain(CONTEXT_GRAPH_ID);

    const row = await waitForEndpointRow(client, CONTEXT_GRAPH_ID, expectedUri);

    expect(stripQuotedLiteral(row.broker ?? '')).toBe(broker);
    expect(stripQuotedLiteral(row.topic ?? '')).toBe(topic);
    expect(stripQuotedLiteral(row.messageFormat ?? '')).toBe(messageFormat);
    expect(stripIriDelimiters(row.publisher ?? '')).toBe(`urn:dkg:agent:${owner}`);
    expect(stripIriDelimiters(row.endpointUrl ?? '')).toBe(`kafka://${broker}/${topic}`);
    expect(Number.isNaN(Date.parse(stripQuotedLiteral(row.issued ?? '')))).toBe(false);
    // Slice 04: with no creds, the KA records `verificationStatus =
    // "unattempted"` and carries neither verifiedAt nor securityProtocol.
    expect(stripQuotedLiteral(row.verificationStatus ?? '')).toBe('unattempted');
  }, 90_000);

  describe('live probe (slice 04)', () => {
    let kafka: PlaintextKafka | undefined;

    beforeAll(async () => {
      if (!RUN_E2E || !devnetReachable) return;
      kafka = await startPlaintextKafka();
    }, 180_000);

    afterAll(async () => {
      if (kafka) await kafka.stop();
    }, 60_000);

    it(
      'registers with creds + reachable topic → KA verified, verifiedAt within last minute',
      async () => {
        if (!kafka) throw new Error('kafka container should be up');
        // Create the synthetic topic the daemon's probe will look for.
        const topic = `walking-skeleton-probe.${Date.now()}`;
        await createTopicAndProduce({ bootstrap: kafka.bootstrap, topic });

        const broker = kafka.bootstrap;
        const messageFormat = 'application/cloudevents+json';
        const expectedUri = buildKafkaEndpointUri({ owner, broker, topic });

        const before = Date.now();
        const result = await execFileAsync(
          'node',
          [
            CLI_ENTRY,
            'kafka',
            'endpoint',
            'register',
            '--cg',
            CONTEXT_GRAPH_ID,
            '--broker',
            broker,
            '--topic',
            topic,
            '--format',
            messageFormat,
            '--security-protocol',
            'PLAINTEXT',
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              DKG_HOME: DEVNET_NODE1_HOME,
              DKG_API_PORT: String(port),
            },
          },
        );

        expect(result.stdout).toContain('Kafka endpoint registered:');
        expect(result.stdout).toContain('Verification status:  verified');

        const row = await waitForEndpointRow(client, CONTEXT_GRAPH_ID, expectedUri);
        expect(stripQuotedLiteral(row.verificationStatus ?? '')).toBe('verified');
        expect(stripQuotedLiteral(row.securityProtocol ?? '')).toBe('PLAINTEXT');

        const verifiedAt = stripQuotedLiteral(row.verifiedAt ?? '');
        const verifiedAtMs = Date.parse(verifiedAt);
        expect(Number.isNaN(verifiedAtMs)).toBe(false);
        // Within the last minute means: between (before - 1s) and (now + 1s)
        // for clock skew.
        expect(verifiedAtMs).toBeGreaterThanOrEqual(before - 1_000);
        expect(verifiedAtMs).toBeLessThanOrEqual(Date.now() + 1_000);
      },
      240_000,
    );
  });

  describe('lifecycle (slice 05)', () => {
    it(
      'register → revoke → list-active excludes → list-all includes → single-fetch returns revoked KA',
      async () => {
        const broker = `kafka.lifecycle.${Date.now()}.local:9092`;
        const topic = `lifecycle-revoke.${Date.now()}`;
        const messageFormat = 'application/cloudevents+json';
        const expectedUri = buildKafkaEndpointUri({ owner, broker, topic });

        // 1. register (no creds → status=unattempted; the lifecycle assertions
        //    don't depend on the probe — only on revoke/list/get behaviour).
        const registerResult = await client.registerKafkaEndpoint({
          contextGraphId: CONTEXT_GRAPH_ID,
          broker,
          topic,
          messageFormat,
        });
        expect(registerResult.uri).toBe(expectedUri);

        // Wait for the KA to be queryable in the data graph (the daemon
        // commits asynchronously after the chain ack).
        await waitForEndpointRow(client, CONTEXT_GRAPH_ID, expectedUri);

        // 2. soft-revoke. Mutate-by-add: dkg:status="revoked" + dkg:revokedAt
        //    are added; the existing properties survive.
        const revokeBefore = Date.now();
        const revokeResult = await client.revokeKafkaEndpoint({
          contextGraphId: CONTEXT_GRAPH_ID,
          uri: expectedUri,
        });
        expect(revokeResult.uri).toBe(expectedUri);
        expect(revokeResult.status).toBe('revoked');
        const revokedAtMs = Date.parse(revokeResult.revokedAt);
        expect(revokedAtMs).toBeGreaterThanOrEqual(revokeBefore - 1_000);
        expect(revokedAtMs).toBeLessThanOrEqual(Date.now() + 1_000);

        // Give the V10 update time to land in the data graph.
        await waitForRevokedRow(client, CONTEXT_GRAPH_ID, expectedUri);

        // 3. list with default (active) filter → revoked KA must be excluded.
        const activeListing = await client.listKafkaEndpoints({
          contextGraphId: CONTEXT_GRAPH_ID,
        });
        const activeUris = activeListing.endpoints.map((ep) => ep.uri);
        expect(activeUris).not.toContain(expectedUri);

        // 4. list with status=all → revoked KA must be present.
        const fullListing = await client.listKafkaEndpoints({
          contextGraphId: CONTEXT_GRAPH_ID,
          status: 'all',
        });
        const fullUris = fullListing.endpoints.map((ep) => ep.uri);
        expect(fullUris).toContain(expectedUri);
        const revokedRow = fullListing.endpoints.find((ep) => ep.uri === expectedUri);
        expect(revokedRow?.status).toBe('revoked');

        // 5. single-URI fetch must return the revoked KA.
        const single = await client.getKafkaEndpoint({
          contextGraphId: CONTEXT_GRAPH_ID,
          uri: expectedUri,
        });
        expect(single.uri).toBe(expectedUri);
        expect(single.status).toBe('revoked');
        expect(typeof single.revokedAt).toBe('string');
      },
      240_000,
    );
  });

  describe('re-verify lifecycle (slice 05)', () => {
    let kafka: PlaintextKafka | undefined;

    beforeAll(async () => {
      if (!RUN_E2E || !devnetReachable) return;
      kafka = await startPlaintextKafka();
    }, 180_000);

    afterAll(async () => {
      if (kafka) await kafka.stop();
    }, 60_000);

    it(
      'register with creds → re-verify with same creds → SPARQL confirms verifiedAt was updated',
      async () => {
        if (!kafka) throw new Error('kafka container should be up');
        const topic = `lifecycle-verify.${Date.now()}`;
        await createTopicAndProduce({ bootstrap: kafka.bootstrap, topic });
        const broker = kafka.bootstrap;
        const messageFormat = 'application/cloudevents+json';
        const expectedUri = buildKafkaEndpointUri({ owner, broker, topic });

        // 1. register with PLAINTEXT — captures the initial verifiedAt.
        await client.registerKafkaEndpoint({
          contextGraphId: CONTEXT_GRAPH_ID,
          broker,
          topic,
          messageFormat,
          securityProtocol: 'PLAINTEXT',
        });

        const initialRow = await waitForEndpointRow(
          client,
          CONTEXT_GRAPH_ID,
          expectedUri,
        );
        const initialVerifiedAtMs = Date.parse(
          stripQuotedLiteral(initialRow.verifiedAt ?? ''),
        );
        expect(Number.isNaN(initialVerifiedAtMs)).toBe(false);

        // Wait at least 1.1s so the new verifiedAt is observably later. The
        // probe stamps `new Date().toISOString()` synchronously after the
        // disconnect — without a sleep there's a real chance the new stamp
        // matches the old one to the millisecond.
        await new Promise((resolve) => setTimeout(resolve, 1_100));

        // 2. re-verify. Same creds (PLAINTEXT, no broker auth) → status
        //    "verified", new verifiedAt strictly later than the initial.
        const verifyResult = await client.verifyKafkaEndpoint({
          contextGraphId: CONTEXT_GRAPH_ID,
          uri: expectedUri,
          securityProtocol: 'PLAINTEXT',
        });
        expect(verifyResult.verificationStatus).toBe('verified');
        const newVerifiedAtMs = Date.parse(verifyResult.verifiedAt);
        expect(Number.isNaN(newVerifiedAtMs)).toBe(false);
        expect(newVerifiedAtMs).toBeGreaterThan(initialVerifiedAtMs);

        // 3. SPARQL-confirm the persisted verifiedAt matches the response.
        //    Wait for the V10 update to land before reading.
        const updatedRow = await waitForVerifiedAtAdvance(
          client,
          CONTEXT_GRAPH_ID,
          expectedUri,
          initialVerifiedAtMs,
        );
        const persistedVerifiedAtMs = Date.parse(
          stripQuotedLiteral(updatedRow.verifiedAt ?? ''),
        );
        expect(persistedVerifiedAtMs).toBeGreaterThan(initialVerifiedAtMs);
      },
      240_000,
    );
  });
});

async function waitForRevokedRow(
  client: ApiClient,
  contextGraphId: string,
  uri: string,
): Promise<void> {
  const sparql = `
    PREFIX dkg: <https://ontology.dkg.io/dkg#>
    SELECT ?status ?revokedAt WHERE {
      GRAPH ?g {
        <${uri}> dkg:status ?status ; dkg:revokedAt ?revokedAt .
      }
    }
  `;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await client.query(sparql, contextGraphId);
    const bindings = (response.result as { bindings?: Array<Record<string, string>> }).bindings;
    if (Array.isArray(bindings) && bindings.length > 0) {
      const status = stripQuotedLiteral(bindings[0]!.status ?? '');
      if (status === 'revoked') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Kafka endpoint ${uri} did not show dkg:status "revoked" within 30s`);
}

async function waitForVerifiedAtAdvance(
  client: ApiClient,
  contextGraphId: string,
  uri: string,
  initialVerifiedAtMs: number,
): Promise<Record<string, string>> {
  const sparql = `
    PREFIX dkg: <https://ontology.dkg.io/dkg#>
    SELECT ?verifiedAt WHERE {
      GRAPH ?g {
        <${uri}> dkg:verifiedAt ?verifiedAt .
      }
    }
  `;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await client.query(sparql, contextGraphId);
    const bindings = (response.result as { bindings?: Array<Record<string, string>> }).bindings;
    if (Array.isArray(bindings) && bindings.length > 0) {
      const verifiedAt = stripQuotedLiteral(bindings[0]!.verifiedAt ?? '');
      const verifiedAtMs = Date.parse(verifiedAt);
      if (!Number.isNaN(verifiedAtMs) && verifiedAtMs > initialVerifiedAtMs) {
        return bindings[0]!;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Kafka endpoint ${uri} dkg:verifiedAt did not advance past ${new Date(initialVerifiedAtMs).toISOString()} within 30s`,
  );
}

