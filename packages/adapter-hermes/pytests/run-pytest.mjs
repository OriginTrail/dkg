#!/usr/bin/env node
// Cross-platform pytest runner for the Hermes Python plugin tests, invoked from
// the package `test` script (after vitest) so `pnpm --filter ...adapter-hermes
// test` and the root `turbo test` / CI both exercise the Python suite.
//
// Resolves a Python interpreter (python3 / python / py -3), then runs
// `-m pytest` against this package. A REAL pytest failure (red tests / collection
// error) exits non-zero and fails the build. If NO interpreter is found, this
// exits non-zero with a clear message — CI provisions Python via
// actions/setup-python in the kosava-supporting job, and local dev needs Python
// + `pip install pytest eth-utils requests` (see pytests/README or CONTRIBUTING).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const candidates =
  process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

function hasInterpreter(cmd, prefix) {
  const probe = spawnSync(cmd, [...prefix, '--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

const found = candidates.find(([cmd, prefix]) => {
  try {
    return hasInterpreter(cmd, prefix);
  } catch {
    return false;
  }
});

if (!found) {
  console.error(
    '[adapter-hermes] No Python interpreter found — cannot run the Hermes plugin pytest suite.\n' +
      'Install Python 3 and `pip install pytest eth-utils requests`. CI provisions this via ' +
      'actions/setup-python in the kosava-supporting job.',
  );
  process.exit(1);
}

const [cmd, prefix] = found;
const result = spawnSync(cmd, [...prefix, '-m', 'pytest'], {
  cwd: pkgRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[adapter-hermes] Failed to launch pytest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
