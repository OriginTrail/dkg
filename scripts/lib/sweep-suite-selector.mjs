import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ALWAYS_REPEATABLE_SUITE = 'v10-end-to-end';

function requireSuiteList(manifest, key) {
  const suites = manifest?.[key];
  if (!Array.isArray(suites) || suites.some((suite) => typeof suite !== 'string' || !suite)) {
    throw new TypeError(`sweep manifest ${key} must be an array of non-empty suite names`);
  }
  return suites;
}

function overrideSuites(stabilityOverride) {
  if (typeof stabilityOverride !== 'string' || stabilityOverride.trim() === '') return undefined;
  return stabilityOverride.trim().split(/\s+/);
}

/**
 * Canonical sweep policy. An explicit stability override is authoritative;
 * baselineOnly filtering applies only to the default stability selection.
 */
export function selectSweepSuites(manifest, stabilityOverride) {
  const prCoverage = requireSuiteList(manifest, 'prCoverage');
  const baselineOnly = requireSuiteList(manifest, 'baselineOnly');
  const baselineOnlySet = new Set(baselineOnly);
  const explicitStability = overrideSuites(stabilityOverride);

  return {
    baseline: [...prCoverage, ALWAYS_REPEATABLE_SUITE],
    stability: explicitStability ?? [
      ...prCoverage.filter((suite) => !baselineOnlySet.has(suite)),
      ALWAYS_REPEATABLE_SUITE,
    ],
  };
}

/** Return the exact records consumed by one operational sweep phase. */
export function scheduleSweepPhase(selection, phase, round = 0) {
  if (phase !== 'baseline' && phase !== 'stability') {
    throw new TypeError(`unknown sweep phase: ${phase}`);
  }
  if (phase === 'stability' && (!Number.isInteger(round) || round < 1)) {
    throw new TypeError('stability round must be a positive integer');
  }

  const suites = phase === 'baseline' ? selection.baseline : selection.stability;
  return suites.map((suite) => ({
    phase,
    round,
    suite,
    logTag: phase === 'baseline' ? `P1-${suite}` : `P2-r${round}-${suite}`,
  }));
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeCliOutput(manifestPath, mode, roundArg, stabilityOverride) {
  const manifest = readManifest(manifestPath);
  const selection = selectSweepSuites(manifest, stabilityOverride);

  if (mode === 'selection') {
    const nodeCount = manifest?.sharedSweep?.nodeCount;
    if (!Number.isInteger(nodeCount) || nodeCount < 1) {
      throw new TypeError('sweep manifest sharedSweep.nodeCount must be a positive integer');
    }
    process.stdout.write([
      selection.baseline.join(' '),
      selection.stability.join(' '),
      String(nodeCount),
      String(manifest.prCoverage.length),
    ].join('\t'));
    return;
  }

  const round = mode === 'stability' ? Number(roundArg) : 0;
  const records = scheduleSweepPhase(selection, mode, round);
  process.stdout.write(records.map(({ logTag, suite }) => `${logTag}\t${suite}`).join('\n'));
  if (records.length > 0) process.stdout.write('\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  try {
    const [, , manifestPath, mode, roundArg = '0', stabilityOverride] = process.argv;
    if (!manifestPath || !mode) {
      throw new TypeError(
        'usage: node sweep-suite-selector.mjs <manifest> <selection|baseline|stability> [round] [stability override]',
      );
    }
    writeCliOutput(manifestPath, mode, roundArg, stabilityOverride);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
