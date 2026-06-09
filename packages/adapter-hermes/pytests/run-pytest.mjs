#!/usr/bin/env node
// Cross-platform pytest runner for the Hermes Python plugin tests, invoked from
// the package `test` script (after vitest) so `pnpm --filter ...adapter-hermes
// test` and the root `turbo test` / CI exercise the Python suite.
//
// Availability policy (Codex round-4):
//   - Local dev (DKG_REQUIRE_PYTEST unset): if no Python interpreter OR pytest is
//     not importable, SKIP GRACEFULLY — print a clear warning and exit 0 so a
//     clean contributor machine (no Python; `pnpm install` never provisions it)
//     can still `pnpm test` (vitest runs, this skips, the script passes).
//   - CI (DKG_REQUIRE_PYTEST=1): the Python suite is REQUIRED — a missing
//     interpreter / pytest is a hard FAILURE (exit non-zero), so CI never
//     silently skips coverage. The ci.yml adapter-hermes lane sets the flag and
//     provisions Python via actions/setup-python + the pinned requirements file.
//
// A REAL pytest failure (red tests / collection error) ALWAYS exits non-zero,
// independent of the flag — "missing" and "failing" are distinct.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const REQUIRED = process.env.DKG_REQUIRE_PYTEST === '1';

const candidates =
  process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

// A usable interpreter is one where `<py> -m pytest --version` succeeds — this
// also proves pytest itself is importable, not just that Python exists.
function pytestProbe(cmd, prefix) {
  const probe = spawnSync(cmd, [...prefix, '-m', 'pytest', '--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

let runner = null;
for (const [cmd, prefix] of candidates) {
  try {
    if (pytestProbe(cmd, prefix)) {
      runner = [cmd, prefix];
      break;
    }
  } catch {
    // interpreter not on PATH — keep looking
  }
}

if (!runner) {
  const msg =
    'Python pytest suite skipped — no Python interpreter with pytest was found. ' +
    'Install Python 3 and `pip install -r packages/adapter-hermes/pytests/requirements.txt` to run it.';
  if (REQUIRED) {
    console.error(
      `[adapter-hermes] ${msg}\n` +
        'DKG_REQUIRE_PYTEST=1 is set (CI) — the Python suite is REQUIRED, failing.',
    );
    process.exit(1);
  }
  console.warn(`[adapter-hermes] ${msg}`);
  process.exit(0);
}

const [cmd, prefix] = runner;
const result = spawnSync(cmd, [...prefix, '-m', 'pytest'], {
  cwd: pkgRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[adapter-hermes] Failed to launch pytest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
