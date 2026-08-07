import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTEGER_ONLY_V1_CANDIDATE,
  PAPER_BASELINE_V0,
  createMappingCursor,
  nextMappingIndex
} from '@origintrail-official/dkg-wal/reconciliation';

const U64_MASK = 0xffff_ffff_ffff_ffffn;
const SEED_INCREMENT = 0x9e37_79b9_7f4a_7c15n;

function integerArgument(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (argument === undefined) return fallback;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

const seedCount = integerArgument('seeds', 100_000);
const stepsPerSeed = integerArgument('steps', 32);
const symbolBounds = [64, 4_096, 1_048_576];
let seed = 0n;
let divergentSeeds = 0;
let divergentSteps = 0;
let maximumAbsoluteIndexDelta = 0;
const firstDivergenceByStep = Array.from({ length: stepsPerSeed }, () => 0);
const divergentSeedsWithinSymbolBound = Object.fromEntries(symbolBounds.map((bound) => [String(bound), 0]));
const startedAt = performance.now();

for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
  seed = (seed + SEED_INCREMENT) & U64_MASK;
  const floatingCursor = createMappingCursor(seed);
  const integerCursor = createMappingCursor(seed);
  let firstDivergence = -1;
  const divergedWithinBound = new Set<number>();
  for (let step = 0; step < stepsPerSeed; step += 1) {
    const floatingIndex = nextMappingIndex(floatingCursor, PAPER_BASELINE_V0.algorithm.mapping);
    const integerIndex = nextMappingIndex(integerCursor, INTEGER_ONLY_V1_CANDIDATE.algorithm.mapping);
    if (floatingIndex === integerIndex) continue;
    divergentSteps += 1;
    if (firstDivergence < 0) firstDivergence = step;
    maximumAbsoluteIndexDelta = Math.max(maximumAbsoluteIndexDelta, Math.abs(floatingIndex - integerIndex));
    for (const bound of symbolBounds) {
      if (floatingIndex <= bound || integerIndex <= bound) divergedWithinBound.add(bound);
    }
  }
  if (firstDivergence >= 0) {
    divergentSeeds += 1;
    firstDivergenceByStep[firstDivergence] += 1;
  }
  for (const bound of divergedWithinBound) divergentSeedsWithinSymbolBound[String(bound)] += 1;
}

const report = {
  schema: 'dkg-wal-iblt-mapping-schedule-agreement-v1',
  recordedAt: new Date().toISOString(),
  seedGeneration: 'seed[n+1] = seed[n] + 0x9e3779b97f4a7c15 mod 2^64',
  seedCount,
  stepsPerSeed,
  comparedSteps: seedCount * stepsPerSeed,
  divergentSeeds,
  divergentSeedRatio: divergentSeeds / seedCount,
  divergentSteps,
  divergentStepRatio: divergentSteps / (seedCount * stepsPerSeed),
  maximumAbsoluteIndexDelta,
  divergentSeedsWithinSymbolBound,
  firstDivergenceByStep,
  elapsedMs: performance.now() - startedAt
};

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../results/mapping-schedule-agreement.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, ...report }, null, 2)}\n`);
