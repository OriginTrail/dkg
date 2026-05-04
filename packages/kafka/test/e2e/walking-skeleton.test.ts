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

  it('registers a public Kafka endpoint into the named context graph and discovers it via SPARQL', async () => {
    // Registers with --public so the KA is wrapped in { public: KA } and
    // cleartext quads are stored. SPARQL query should return the endpoint row.
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
        '--public',
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
    // --public flag → response echoes Private: false
    expect(result.stdout).toContain('Private:        false');

    const row = await waitForEndpointRow(client, CONTEXT_GRAPH_ID, expectedUri);

    expect(stripQuotedLiteral(row.broker ?? '')).toBe(broker);
    expect(stripQuotedLiteral(row.topic ?? '')).toBe(topic);
    expect(stripQuotedLiteral(row.messageFormat ?? '')).toBe(messageFormat);
    expect(stripIriDelimiters(row.publisher ?? '')).toBe(`urn:dkg:agent:${owner}`);
    expect(stripIriDelimiters(row.endpointUrl ?? '')).toBe(`kafka://${broker}/${topic}`);
    expect(Number.isNaN(Date.parse(stripQuotedLiteral(row.issued ?? '')))).toBe(false);
  }, 90_000);

  it('registers a private (default) Kafka endpoint and confirms CLI reports Private: true', async () => {
    // Registers WITHOUT --public so the KA is wrapped in { private: KA } and
    // stored as encrypted data for CG participants.
    //
    // V10 private-KA semantics: on a single-node devnet the local participant
    // IS the publisher, so the node may decrypt the KA for itself and surface
    // it via SPARQL. On a multi-node network, other participants would need
    // decryption keys. We do NOT assert SPARQL content here because:
    //   1. Verifying encryption-to-CG-participants requires a full multi-node
    //      devnet with participant key management — beyond this single-node e2e.
    //   2. The route-adapter unit tests in daemon-routes-kafka.test.ts already
    //      confirm { private: KA } is the envelope sent to agent.publish().
    // This e2e test focuses on:
    //   (a) CLI stdout reports Private: true
    //   (b) the request was accepted (HTTP 200 → execFileAsync doesn't throw)
    const broker = 'kafka.e2e.private:9092';
    const topic = `walking-skeleton-private.${Date.now()}`;
    const messageFormat = 'application/cloudevents+json';

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
        // NO --public flag: default is private
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
    expect(result.stdout).toContain(CONTEXT_GRAPH_ID);
    // Default (no --public) → response echoes Private: true
    expect(result.stdout).toContain('Private:        true');
    // stdout does NOT say "Private:        false"
    expect(result.stdout).not.toContain('Private:        false');
  }, 90_000);
});
