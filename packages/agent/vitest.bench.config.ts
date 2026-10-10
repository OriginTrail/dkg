import { defineConfig } from "vitest/config";

// Offline measurements, never part of a CI lane: `pnpm run benchmark:catalog-placement`.
// CATALOG_PLACEMENT_BENCH_CPU_PROFILE_DIR writes a V8 CPU profile of the run there.
const cpuProfileDir = process.env.CATALOG_PLACEMENT_BENCH_CPU_PROFILE_DIR;

export default defineConfig({
  test: {
    allowOnly: false,
    include: ["test/benchmarks/**/*.bench.ts"],
    testTimeout: 0,
    hookTimeout: 0,
    maxWorkers: 1,
    pool: "forks",
    execArgv: [
      "--experimental-sqlite",
      "--no-warnings=ExperimentalWarning",
      // The measure mode reports what stays in memory after a full collection.
      "--expose-gc",
      ...(cpuProfileDir === undefined
        ? []
        : ["--cpu-prof", `--cpu-prof-dir=${cpuProfileDir}`]),
    ],
  },
});
