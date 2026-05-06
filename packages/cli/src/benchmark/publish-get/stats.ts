import {
  OPERATIONS,
  type BenchmarkFailure,
  type BenchmarkOperation,
  type BenchmarkResult,
  type OperationSummary,
  type OperationTiming,
  type OutputFormat,
} from './types.js';

export function summarizeOperations(operations: OperationTiming[]): Record<BenchmarkOperation, OperationSummary> {
  const summaries = {} as Record<BenchmarkOperation, OperationSummary>;
  for (const operation of OPERATIONS) {
    const measured = operations.filter((op) => op.operation === operation && !op.warmup);
    const successes = measured.filter((op) => op.success).map((op) => op.durationMs);
    summaries[operation] = {
      count: measured.length,
      successCount: successes.length,
      failureCount: measured.length - successes.length,
      minMs: successes.length ? roundMs(Math.min(...successes)) : null,
      maxMs: successes.length ? roundMs(Math.max(...successes)) : null,
      meanMs: successes.length ? roundMs(successes.reduce((sum, value) => sum + value, 0) / successes.length) : null,
      medianMs: successes.length ? percentile(successes, 50) : null,
      p50Ms: successes.length ? percentile(successes, 50) : null,
      p95Ms: successes.length ? percentile(successes, 95) : null,
    };
  }
  return summaries;
}

export function extractFailures(operations: OperationTiming[]): BenchmarkFailure[] {
  return operations
    .filter((op) => !op.success && !op.warmup)
    .map((op) => ({
      operation: op.operation,
      iteration: op.iteration,
      error: op.error ?? 'unknown error',
      context: op.context,
    }));
}

export function formatResult(result: BenchmarkResult, outputFormat: OutputFormat): string {
  if (outputFormat === 'json') {
    return JSON.stringify(result, null, 2);
  }

  const lines = result.operations.map((operation) => JSON.stringify({ type: 'operation', ...operation }));
  lines.push(JSON.stringify({
    type: 'summary',
    benchmark: result.benchmark,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    config: result.config,
    summaries: result.summaries,
    failures: result.failures,
  }));
  return lines.join('\n');
}

export function createFailureRecord(
  operation: BenchmarkOperation,
  iteration: number,
  error: unknown,
  context: Record<string, unknown>,
  warmup = false,
  durationMs = 0,
): OperationTiming {
  return {
    operation,
    iteration,
    warmup,
    success: false,
    durationMs: roundMs(durationMs),
    error: errorMessage(error),
    context,
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return roundMs(sorted[index]);
}

export function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
