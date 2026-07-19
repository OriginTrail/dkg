import { runReconciliationBenchmark } from '../benchmarks/scenario.js';

function integerArgument(name: string): number | undefined {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (argument === undefined) return undefined;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

const setSize = integerArgument('size');
if (setSize === undefined) throw new Error('--size is required');
const eachSideDifference = integerArgument('each-side-difference') ?? 16;
const warmupSize = Math.min(1_000, Math.max(eachSideDifference + 1, Math.floor(setSize / 10)));
runReconciliationBenchmark(warmupSize, Math.min(eachSideDifference, 4));
globalThis.gc?.();
const result = runReconciliationBenchmark(setSize, eachSideDifference);
process.stdout.write(`${JSON.stringify(result)}\n`);
