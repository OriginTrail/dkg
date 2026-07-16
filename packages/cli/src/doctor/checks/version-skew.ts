/**
 * §4.7.4 Check: version skew.
 *
 * Detects "your install isn't what the daemon is running" mismatches
 * that the slot indirection (Core) or supervisor lifecycle (Edge or
 * Core) can produce.
 *
 * **Edge:** compare `npm-global install version` with the daemon's
 * `/api/status` version. Different directions of skew produce
 * different advisories.
 *
 * **Core:** compare the active slot's
 * `node_modules/@origintrail-official/dkg/package.json#version` with
 * `/api/status` — slot swap completed but supervisor failed to
 * restart.
 */
import { join } from 'node:path';
import type { DoctorDeps, Finding, StateSummary } from '../types.js';

async function readPackageVersion(deps: DoctorDeps, packageJsonPath: string): Promise<string | null> {
  const raw = await deps.readFile(packageJsonPath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const v = (parsed as { version?: unknown }).version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function runVersionSkewCheck(
  deps: DoctorDeps,
  state: StateSummary,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  if (!state.daemon.version) {
    // Daemon unreachable — can't compare. Surfaced as part of the
    // state summary; no separate finding needed.
    return findings;
  }

  if (state.daemon.nodeRole === 'core') {
    if (!state.paths.activeSlot) return findings;
    const slotName = state.paths.activeSlot;
    const slotPkgPath = join(deps.dkgHome, 'releases', slotName, 'node_modules', '@origintrail-official', 'dkg', 'package.json');
    const slotVersion = await readPackageVersion(deps, slotPkgPath);
    if (!slotVersion) return findings;
    if (slotVersion !== state.daemon.version) {
      findings.push({
        check: 'version-skew',
        severity: 'warning',
        message: `Core slot version (${slotVersion}) differs from running daemon (${state.daemon.version})`,
        advisory: "Slot swap completed but supervisor failed to restart. Run 'dkg restart' to reload.",
        details: { slotVersion, daemonVersion: state.daemon.version, slot: slotName },
      });
    }
    return findings;
  }

  // Edge.
  if (!state.paths.npmGlobalDkg) return findings;
  const npmGlobalPkgPath = join(state.paths.npmGlobalDkg, 'package.json');
  const npmGlobalVersion = await readPackageVersion(deps, npmGlobalPkgPath);
  if (!npmGlobalVersion) return findings;
  if (npmGlobalVersion === state.daemon.version) return findings;

  const semverCompare = (a: string, b: string): number => {
    const norm = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10));
    const [a1, a2, a3] = norm(a).concat([0, 0, 0]);
    const [b1, b2, b3] = norm(b).concat([0, 0, 0]);
    if (a1 !== b1) return a1 - b1;
    if (a2 !== b2) return a2 - b2;
    return a3 - b3;
  };

  const order = semverCompare(npmGlobalVersion, state.daemon.version);
  if (order > 0) {
    findings.push({
      check: 'version-skew',
      severity: 'warning',
      message: `npm-global install is ahead of running daemon (${npmGlobalVersion} > ${state.daemon.version})`,
      advisory: "The daemon needs a restart to pick up the new install. Run 'dkg restart'.",
      details: { npmGlobalVersion, daemonVersion: state.daemon.version },
    });
  } else {
    findings.push({
      check: 'version-skew',
      severity: 'warning',
      message: `Running daemon is ahead of npm-global install (${state.daemon.version} > ${npmGlobalVersion})`,
      advisory: "Something is overriding the entry-point resolution. Check $PATH and any DKG_NO_BLUE_GREEN or DKG_HOME env vars.",
      details: { npmGlobalVersion, daemonVersion: state.daemon.version },
    });
  }

  return findings;
}
