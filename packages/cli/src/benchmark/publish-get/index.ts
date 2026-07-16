import { createBenchmarkClient } from './api.js';
import { parseBenchmarkArgs, UsageError } from './config.js';
import { runPublishAsyncGetBenchmark } from './runner.js';
import { formatResult } from './stats.js';

export * from './api.js';
export * from './config.js';
export * from './payload.js';
export * from './runner.js';
export * from './stats.js';
export * from './types.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let config;
  try {
    config = parseBenchmarkArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.log(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  const client = await createBenchmarkClient(config);
  const result = await runPublishAsyncGetBenchmark(config, client);
  console.log(formatResult(result, config.outputFormat));
  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
