#!/usr/bin/env node
// Cross-platform pytest runner for the Hermes Python plugin tests, invoked from
// the package `test` script (after vitest) so `pnpm --filter ...adapter-hermes
// test` and the root `turbo test` / CI exercise the Python suite.
//
// Availability policy (Codex round-4 + final round):
//   - Local dev (DKG_REQUIRE_PYTEST unset): if no Python interpreter OR the full
//     dep set (pytest + eth_utils + requests) is not importable, SKIP GRACEFULLY
//     — print a clear warning and exit 0 so a clean contributor machine (no
//     Python, or partial deps; `pnpm install` never provisions them) can still
//     `pnpm test` (vitest runs, this skips, the script passes).
//   - CI (DKG_REQUIRE_PYTEST=1): the Python suite is REQUIRED — a missing
//     interpreter / dep is a hard FAILURE (exit non-zero), so CI never silently
//     skips coverage. The ci.yml adapter-hermes lane sets the flag and provisions
//     Python via actions/setup-python + the pinned requirements file.
//
// A REAL pytest failure (red tests / collection error) ALWAYS exits non-zero,
// independent of the flag — "missing" and "failing" are distinct.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const COVERAGE = process.argv.includes('--coverage') || process.env.DKG_CI_COVERAGE === '1';
const REQUIRED = COVERAGE || process.env.DKG_REQUIRE_PYTEST === '1';

const candidates =
  process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

// A usable interpreter is one where the FULL import set the suite needs is
// importable — pytest AND the pinned runtime deps (eth_utils, requests). Probing
// only `pytest --version` would mark a machine with global pytest but without
// eth_utils/requests as "runnable", so pytest would run and fail on the missing
// import instead of skipping. Keep this in sync with pytests/requirements.txt.
//
// Also EXERCISE eth_utils.to_checksum_address: it needs an eth-hash keccak
// backend (pycryptodome) that imports fine but only RAISES at call time when
// absent — without this call the probe would pass on a backend-less machine and
// the suite would silently produce lowercase addresses (the CI finalize-checksum
// failure). Calling it here makes a missing backend a clean skip, not a red test.
function pytestProbe(cmd, prefix) {
  const probe = spawnSync(
    cmd,
    [
      ...prefix,
      '-c',
      (COVERAGE ? 'import pytest_cov; ' : '') + 'import pytest, requests, click; from eth_utils import to_checksum_address; '
        + "assert to_checksum_address('0x52908400098527886e0f7030069857d2e4169ee7')"
        + " == '0x52908400098527886E0F7030069857D2E4169EE7'",
    ],
    { stdio: 'ignore' },
  );
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
    'Python pytest suite skipped — no Python interpreter with the required deps ' +
    '(pytest, eth_utils, requests, click; pytest-cov for coverage) was found. Install Python 3 and ' +
    '`pip install -r packages/adapter-hermes/pytests/requirements.txt` to run it.';
  if (REQUIRED) {
    console.error(
      `[adapter-hermes] ${msg}\n` +
        'CI or coverage requires the Python suite; failing.',
    );
    process.exit(1);
  }
  console.warn(`[adapter-hermes] ${msg}`);
  process.exit(0);
}

const [cmd, prefix] = runner;
mkdirSync(resolve(pkgRoot, 'test-results'), { recursive: true });
rmSync(resolve(pkgRoot, 'test-results/hermes-python.xml'), { force: true });
if (COVERAGE) rmSync(resolve(pkgRoot, 'coverage-python'), { recursive: true, force: true });
const result = spawnSync(cmd, [...prefix, '-m', 'pytest', '--junitxml=test-results/hermes-python.xml', ...(COVERAGE ? [
  '--cov=hermes-plugin', '--cov-branch', '--cov-report=term', '--cov-report=json:coverage-python/coverage.json', '--cov-report=xml:coverage-python/coverage.xml', '--cov-fail-under=34',
] : [])], {
  cwd: pkgRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[adapter-hermes] Failed to launch pytest: ${result.error.message}`);
  process.exit(1);
}
if (result.status === 0 && COVERAGE) {
  const report = JSON.parse(readFileSync(resolve(pkgRoot, 'coverage-python/coverage.json'), 'utf8'));
  const expected = readdirSync(resolve(pkgRoot, 'hermes-plugin')).filter((file) => file.endsWith('.py')).map((file) => `hermes-plugin/${file}`).sort();
  const actual = Object.keys(report.files).map((file) => file.replaceAll('\\', '/')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || report.totals.num_statements <= 0) {
    throw new Error('Python coverage omitted production files or included non-production files');
  }
  if (report.files['hermes-plugin/cli.py'].summary.percent_covered < 97) throw new Error('Hermes CLI coverage regressed below 97%');
}
process.exit(result.status ?? 1);
