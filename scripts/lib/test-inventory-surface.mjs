import path from 'node:path';

/** Execution surface: JS/TS cases, Python tests/drivers, shell test drivers, and YAML test cases. */
export function isTestSurface(file) {
  if (/\.(?:test|spec|test-d)\.[cm]?[jt]sx?$/.test(file)) return true;
  if (file.endsWith('.py')) return /(?:^|\/)(?:test_[^/]*|[^/]*_test|run_all_tests)\.py$/.test(file);
  if (file.endsWith('.sh')) return /(?:^|[/_.-])(?:test|tests|e2e|smoke|soak|verify)(?:[/_.-]|$)/.test(file);
  if (/\.ya?ml$/.test(file)) return /(?:^|\/)(?:test|tests|cases)\//.test(file) || /\.test\.ya?ml$/.test(file);
  return false;
}

export function secondaryRoutes(files, registrations) {
  const result = new Map();
  for (const route of registrations) {
    if (!route.reason || !route.command || !route.cadence) throw new Error(`incomplete test route ${route.pattern}`);
    const matches = files.filter((file) => path.posix.matchesGlob(file, route.pattern));
    if (!matches.length) throw new Error(`stale test route: ${route.pattern}`);
    for (const file of matches) if (!result.has(file)) result.set(file, { ...route, command: route.command.replaceAll('{file}', file) });
  }
  return result;
}
