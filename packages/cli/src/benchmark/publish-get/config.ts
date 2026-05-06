import {
  DEFAULT_PAYLOAD_SIZE_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REPEAT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WARMUPS,
  type BenchmarkConfig,
  type FixtureName,
  type GetView,
  type OutputFormat,
} from './types.js';

export class UsageError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

export function parseBenchmarkArgs(argv = process.argv.slice(2), env = process.env): BenchmarkConfig {
  const config: Partial<BenchmarkConfig> = {
    contextGraphId: env.DKG_BENCH_CONTEXT_GRAPH_ID,
    repeat: parseOptionalPositiveInt(env.DKG_BENCH_REPEAT, 'DKG_BENCH_REPEAT') ?? DEFAULT_REPEAT,
    warmups: parseOptionalNonNegativeInt(env.DKG_BENCH_WARMUPS, 'DKG_BENCH_WARMUPS') ?? DEFAULT_WARMUPS,
    timeoutMs: parseOptionalPositiveInt(env.DKG_BENCH_TIMEOUT_MS, 'DKG_BENCH_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS,
    payloadSizeBytes:
      parseOptionalPositiveInt(env.DKG_BENCH_PAYLOAD_SIZE, 'DKG_BENCH_PAYLOAD_SIZE') ?? DEFAULT_PAYLOAD_SIZE_BYTES,
    fixture: parseFixture(env.DKG_BENCH_FIXTURE ?? 'generated'),
    outputFormat: parseOutputFormat(env.DKG_BENCH_OUTPUT_FORMAT ?? 'json'),
    namespace: env.DKG_BENCH_NAMESPACE ?? 'benchmark',
    scope: env.DKG_BENCH_SCOPE ?? 'publish-async-get',
    authorityProofRef: env.DKG_BENCH_AUTHORITY_PROOF_REF ?? 'proof:benchmark-local',
    pollIntervalMs:
      parseOptionalPositiveInt(env.DKG_BENCH_POLL_INTERVAL_MS, 'DKG_BENCH_POLL_INTERVAL_MS') ?? DEFAULT_POLL_INTERVAL_MS,
    asyncSuccessStatuses: parseStatusList(env.DKG_BENCH_ASYNC_SUCCESS_STATUS ?? 'finalized'),
    getView: parseGetView(env.DKG_BENCH_GET_VIEW ?? 'verified-memory'),
    apiPort: parseOptionalPositiveInt(env.DKG_API_PORT, 'DKG_API_PORT'),
    apiUrl: env.DKG_API_URL,
    authToken: env.DKG_AUTH_TOKEN,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const { name, inlineValue } = splitArg(argv[i]);
    const value = () => inlineValue ?? readNextValue(argv, ++i, name);

    switch (name) {
      case '--':
        break;
      case '--help':
      case '-h':
        throw new UsageError(formatUsage(), 0);
      case '--context-graph-id':
      case '--context-graph':
        config.contextGraphId = value();
        break;
      case '--repeat':
      case '--iterations':
        config.repeat = parsePositiveInt(value(), name);
        break;
      case '--warmups':
        config.warmups = parseNonNegativeInt(value(), name);
        break;
      case '--timeout':
      case '--timeout-ms':
        config.timeoutMs = parsePositiveInt(value(), name);
        break;
      case '--payload-size':
      case '--payload-size-bytes':
        config.payloadSizeBytes = parsePositiveInt(value(), name);
        break;
      case '--fixture':
        config.fixture = parseFixture(value());
        break;
      case '--output-format':
        config.outputFormat = parseOutputFormat(value());
        break;
      case '--namespace':
        config.namespace = value();
        break;
      case '--scope':
        config.scope = value();
        break;
      case '--authority-proof-ref':
        config.authorityProofRef = value();
        break;
      case '--poll-interval':
      case '--poll-interval-ms':
        config.pollIntervalMs = parsePositiveInt(value(), name);
        break;
      case '--async-success-status':
        config.asyncSuccessStatuses = parseStatusList(value());
        break;
      case '--get-view':
        config.getView = parseGetView(value());
        break;
      case '--api-port':
        config.apiPort = parsePositiveInt(value(), name);
        break;
      case '--api-url':
        config.apiUrl = value();
        break;
      case '--auth-token':
        config.authToken = value();
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  if (!config.contextGraphId?.trim()) {
    throw new Error('Missing context graph. Pass --context-graph-id or set DKG_BENCH_CONTEXT_GRAPH_ID.');
  }
  if (!config.namespace?.trim()) throw new Error('Missing namespace');
  if (!config.scope?.trim()) throw new Error('Missing scope');
  if (!config.authorityProofRef?.trim()) throw new Error('Missing authority proof reference');

  return config as BenchmarkConfig;
}

export function sanitizeConfig(config: BenchmarkConfig): Omit<BenchmarkConfig, 'authToken'> {
  const { authToken: _authToken, ...safe } = config;
  return safe;
}

function splitArg(raw: string): { name: string; inlineValue?: string } {
  const eq = raw.indexOf('=');
  if (eq === -1) return { name: raw };
  return { name: raw.slice(0, eq), inlineValue: raw.slice(eq + 1) };
}

function readNextValue(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function parseOptionalPositiveInt(value: string | undefined, name: string): number | undefined {
  return value === undefined || value === '' ? undefined : parsePositiveInt(value, name);
}

function parseOptionalNonNegativeInt(value: string | undefined, name: string): number | undefined {
  return value === undefined || value === '' ? undefined : parseNonNegativeInt(value, name);
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseOutputFormat(value: string): OutputFormat {
  if (value === 'json' || value === 'ndjson') return value;
  throw new Error(`Invalid output format "${value}". Expected json or ndjson.`);
}

function parseFixture(value: string): FixtureName {
  if (value === 'generated' || value === 'minimal') return value;
  throw new Error(`Invalid fixture "${value}". Expected generated or minimal.`);
}

function parseGetView(value: string): GetView {
  if (value === 'working-memory' || value === 'shared-working-memory' || value === 'verified-memory') return value;
  throw new Error(`Invalid get view "${value}". Expected working-memory, shared-working-memory, or verified-memory.`);
}

function parseStatusList(value: string): string[] {
  const statuses = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (statuses.length === 0) {
    throw new Error('At least one async success status is required');
  }
  return statuses;
}

export function formatUsage(): string {
  return `Usage: pnpm --filter @origintrail-official/dkg benchmark:publish-async-get -- --context-graph-id <id> [options]

Options:
  --context-graph-id <id>        Context graph to publish/query (or DKG_BENCH_CONTEXT_GRAPH_ID)
  --repeat <n>                   Measured iterations (default ${DEFAULT_REPEAT})
  --warmups <n>                  Warmup iterations excluded from summaries (default ${DEFAULT_WARMUPS})
  --timeout-ms <ms>              Per-operation timeout (default ${DEFAULT_TIMEOUT_MS})
  --payload-size <bytes>         Generated text payload size target (default ${DEFAULT_PAYLOAD_SIZE_BYTES})
  --fixture <generated|minimal>  Payload fixture (default generated)
  --output-format <json|ndjson>  Output format (default json)
  --poll-interval-ms <ms>        Async publisher job polling interval (default ${DEFAULT_POLL_INTERVAL_MS})
  --get-view <view>              Query view for get validation (default verified-memory)
  --api-url <url>                Local loopback API URL or remote URL with --auth-token
  --api-port <port>              Local daemon API port; loads auth token from DKG_HOME
  --auth-token <token>           Explicit API bearer token
`;
}
