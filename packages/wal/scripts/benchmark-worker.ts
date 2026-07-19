import {
  runReconciliationBenchmark,
  type ReconciliationMappingCandidate
} from '../benchmarks/scenario.js';

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
const mappingArgument = process.argv.find((value) => value.startsWith('--mapping='))?.slice('--mapping='.length)
  ?? 'floating-point';
if (mappingArgument !== 'floating-point' && mappingArgument !== 'integer-only') {
  throw new Error('--mapping must be floating-point or integer-only');
}
const mappingCandidate = mappingArgument as ReconciliationMappingCandidate;
const warmupSize = Math.min(1_000, Math.max(eachSideDifference + 1, Math.floor(setSize / 10)));
runReconciliationBenchmark(warmupSize, Math.min(eachSideDifference, 4), 4_096, mappingCandidate);
globalThis.gc?.();
const result = runReconciliationBenchmark(setSize, eachSideDifference, 4_096, mappingCandidate);
process.stdout.write(`${JSON.stringify(result)}\n`);
