import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStoreBenchmark } from '../benchmarks/store-scenario.js';

function integerArgument(name: string, fallback?: number): number | undefined {
  const prefix = `--${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  if (argument === undefined) return fallback;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

const objectCount = integerArgument('size');
if (objectCount === undefined) throw new Error('--size is required');
const root = await mkdtemp(join(tmpdir(), `dkg-wal-packed-benchmark-${objectCount}-`));
let result;
let cleanupMs = 0;
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  cleanupPromise ??= rm(root, { recursive: true, force: true });
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); });
}
try {
  result = await runStoreBenchmark({
    root,
    objectCount,
    operationSamples: integerArgument('operation-samples', 10_000),
    readSamples: integerArgument('read-samples', 1_000),
    admissionSamples: integerArgument('admission-samples', 16),
    largePayloadBytes: integerArgument('large-payload-bytes', 8 * 1_048_576),
  });
} finally {
  const started = performance.now();
  await cleanup();
  cleanupMs = performance.now() - started;
}
process.stdout.write(`${JSON.stringify({ ...result, cleanupMs })}\n`);
