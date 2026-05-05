import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../../../cli/src/api-client.js';
import { buildKafkaEndpointUri } from '../../src/uri.js';

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
    expect(result.stdout).toContain('CG scope:       shared');

    const row = await waitForEndpointRow(client, CONTEXT_GRAPH_ID, expectedUri);

    expect(stripQuotedLiteral(row.broker ?? '')).toBe(broker);
    expect(stripQuotedLiteral(row.topic ?? '')).toBe(topic);
    expect(stripQuotedLiteral(row.messageFormat ?? '')).toBe(messageFormat);
    expect(stripIriDelimiters(row.publisher ?? '')).toBe(`urn:dkg:agent:${owner}`);
    expect(stripIriDelimiters(row.endpointUrl ?? '')).toBe(`kafka://${broker}/${topic}`);
    expect(Number.isNaN(Date.parse(stripQuotedLiteral(row.issued ?? '')))).toBe(false);
  }, 90_000);

  it('registers a Kafka endpoint into kafka-local-{peerId} with --local and discovers it via SPARQL', async () => {
    const broker = 'kafka.e2e.local:9092';
    const topic = `walking-skeleton-local.${Date.now()}`;
    const messageFormat = 'application/cloudevents+json';
    const expectedUri = buildKafkaEndpointUri({ owner, broker, topic });

    const result = await execFileAsync(
      'node',
      [
        CLI_ENTRY,
        'kafka',
        'endpoint',
        'register',
        '--local',
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
    expect(result.stdout).toContain('kafka-local');
    expect(result.stdout).toContain('CG scope:       local');

    // The daemon scopes the kafka-local CG id per-node as
    // `kafka-local-{peerId}`. Parse the resolved id from the CLI output and
    // SPARQL-query against THAT id so the test stays correct on any node.
    const cgLineMatch = result.stdout.match(/Context graph:\s+(\S+)/);
    expect(cgLineMatch?.[1]).toBeDefined();
    const resolvedCgId = cgLineMatch![1]!;
    expect(resolvedCgId.startsWith('kafka-local-')).toBe(true);

    const row = await waitForEndpointRow(client, resolvedCgId, expectedUri);

    expect(stripQuotedLiteral(row.broker ?? '')).toBe(broker);
    expect(stripQuotedLiteral(row.topic ?? '')).toBe(topic);
    expect(stripQuotedLiteral(row.messageFormat ?? '')).toBe(messageFormat);
    expect(stripIriDelimiters(row.publisher ?? '')).toBe(`urn:dkg:agent:${owner}`);
    expect(stripIriDelimiters(row.endpointUrl ?? '')).toBe(`kafka://${broker}/${topic}`);
    expect(Number.isNaN(Date.parse(stripQuotedLiteral(row.issued ?? '')))).toBe(false);
  }, 90_000);

  it('rejects a request with neither contextGraphId nor useLocalCg with a 4xx', async () => {
    const broker = 'kafka.e2e.local:9092';
    const topic = `walking-skeleton-bad-${Date.now()}`;
    const messageFormat = 'application/json';

    const response = await fetch(`http://127.0.0.1:${port}/api/kafka/endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ broker, topic, messageFormat }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error ?? '').toMatch(/contextGraphId/);
    expect(payload.error ?? '').toMatch(/useLocalCg/);
  }, 30_000);

  it('rejects a request with both contextGraphId and useLocalCg with a 4xx', async () => {
    const broker = 'kafka.e2e.local:9092';
    const topic = `walking-skeleton-bad-${Date.now()}`;
    const messageFormat = 'application/json';

    const response = await fetch(`http://127.0.0.1:${port}/api/kafka/endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        contextGraphId: CONTEXT_GRAPH_ID,
        useLocalCg: true,
        broker,
        topic,
        messageFormat,
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error ?? '').toMatch(/contextGraphId/);
    expect(payload.error ?? '').toMatch(/useLocalCg/);
  }, 30_000);
});
