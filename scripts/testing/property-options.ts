/** Fixed PR seed; nightly jobs supply a recorded seed and a larger run budget. */
export function propertyOptions() {
  const seed = Number(process.env.DKG_PROPERTY_SEED ?? '640905');
  const numRuns = Number(process.env.DKG_PROPERTY_RUNS ?? '100');
  if (!Number.isInteger(seed) || !Number.isInteger(numRuns) || numRuns < 1 || numRuns > 100_000) {
    throw new Error('invalid property-test seed or run budget');
  }
  return { seed, numRuns, ...(process.env.DKG_PROPERTY_PATH ? { path: process.env.DKG_PROPERTY_PATH } : {}) };
}
