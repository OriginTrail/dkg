/**
 * §4.7.3 Check: slot health / install layout (role-aware).
 *
 * **Core (`nodeRole === "core"`):**
 *   - `~/.dkg/releases/current` exists and is a valid symlink.
 *   - The symlink target (`a` or `b`) exists and contains a
 *     resolvable entry point.
 *   - The inactive slot is empty OR contains a complete prior
 *     release with its own resolvable entry point — partial state
 *     is a warning suggesting `dkg update --retry` or `dkg rollback`.
 *   - No `.git` inside either slot (post-rc.12 invariant).
 *
 * **Edge (`nodeRole === "edge"`):**
 *   - The daemon's resolved entry point MUST be inside the
 *     npm-global install path.
 *   - `~/.dkg/releases/` SHOULD NOT exist on Edge. If it does
 *     (pre-rc.12 layout), report it as cleanable legacy state.
 */
import { join } from 'node:path';
import type { DoctorDeps, Finding, StateSummary } from '../types.js';

function normalizePathForContainment(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** True when `child` is `parent` itself or nested under it. */
function isPathInside(child: string, parent: string): boolean {
  let c = normalizePathForContainment(child);
  let p = normalizePathForContainment(parent);
  // Windows paths are case-insensitive and the same absolute path can come
  // back with different drive-letter / segment casing. A case-sensitive
  // compare here would misclassify a live `releases/` runtime as "not
  // inside" and fall back to the dangerous "Safe to delete" advisory.
  if (process.platform === 'win32') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  return c === p || c.startsWith(p + '/');
}

async function slotEntryPointResolves(deps: DoctorDeps, slotDir: string): Promise<boolean> {
  // Mirrors `blueGreenSlotEntryPoint` semantics — git layout
  // (`packages/cli/dist/cli.js`) OR npm layout
  // (`node_modules/@origintrail-official/dkg/dist/cli.js`).
  const gitPath = join(slotDir, 'packages', 'cli', 'dist', 'cli.js');
  if (deps.exists(gitPath)) return true;
  const npmPath = join(slotDir, 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js');
  if (deps.exists(npmPath)) return true;
  return false;
}

export async function runInstallLayoutCheck(
  deps: DoctorDeps,
  state: StateSummary,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const releasesDir = join(deps.dkgHome, 'releases');
  const nodeRole = state.daemon.nodeRole ?? 'edge';

  if (nodeRole === 'core') {
    const currentLink = join(releasesDir, 'current');
    if (!deps.exists(currentLink)) {
      findings.push({
        check: 'install-layout',
        severity: 'error',
        message: `Core node missing blue-green 'current' symlink at ${currentLink}`,
        advisory: "Run 'dkg start' — on first boot the daemon materializes the slot tree.",
        subject: currentLink,
      });
      return findings;
    }

    const slotTarget = await deps.readlink(currentLink);
    if (!slotTarget) {
      findings.push({
        check: 'install-layout',
        severity: 'error',
        message: `'current' is not a valid symlink: ${currentLink}`,
        advisory: "Run 'dkg update --retry' to repair the symlink or 'dkg rollback' to restore the previous slot.",
        subject: currentLink,
      });
      return findings;
    }

    const activeSlotName = slotTarget === 'a' || slotTarget === 'b' ? slotTarget : null;
    if (!activeSlotName) {
      findings.push({
        check: 'install-layout',
        severity: 'error',
        message: `'current' symlink points at unexpected target: ${slotTarget}`,
        advisory: "Expected 'a' or 'b'. Run 'dkg update --retry' or 'dkg rollback' to restore a known-good slot.",
        subject: currentLink,
      });
      return findings;
    }

    const activeSlotDir = join(releasesDir, activeSlotName);
    if (!(await slotEntryPointResolves(deps, activeSlotDir))) {
      findings.push({
        check: 'install-layout',
        severity: 'error',
        message: `Active slot '${activeSlotName}' has no resolvable entry point at ${activeSlotDir}`,
        advisory: "Slot was promoted but install never completed. Run 'dkg update --retry' or 'dkg rollback'.",
        subject: activeSlotDir,
      });
    }

    // Inactive slot check — partial state is a warning, empty is fine.
    const inactiveSlotName = activeSlotName === 'a' ? 'b' : 'a';
    const inactiveSlotDir = join(releasesDir, inactiveSlotName);
    if (deps.exists(inactiveSlotDir)) {
      const entries = await deps.readdir(inactiveSlotDir);
      const populated = entries.length > 0;
      if (populated && !(await slotEntryPointResolves(deps, inactiveSlotDir))) {
        findings.push({
          check: 'install-layout',
          severity: 'warning',
          message: `Inactive slot '${inactiveSlotName}' has files but no resolvable entry point at ${inactiveSlotDir}`,
          advisory: "Likely a partial / interrupted update. Run 'dkg update --retry' to complete the swap, or 'dkg rollback' to restore the previous release.",
          subject: inactiveSlotDir,
        });
      }
    }

    // Post-rc.12 invariant: no `.git` inside either slot.
    for (const slotName of ['a', 'b'] as const) {
      const dotGit = join(releasesDir, slotName, '.git');
      if (deps.exists(dotGit)) {
        findings.push({
          check: 'install-layout',
          severity: 'warning',
          message: `Legacy '.git' directory found inside slot '${slotName}': ${dotGit}`,
          advisory: "Pre-rc.12 install.sh-era state survived the npm-only migration. The slot is fine to run from, but the '.git' is unused. Safe to delete after confirming with the operator.",
          subject: dotGit,
        });
      }
    }

    return findings;
  }

  // Edge branch.
  if (deps.exists(releasesDir)) {
    // A freshly-upgraded Edge node can still be *running* from
    // `~/.dkg/releases/current` until the next restart materializes the
    // npm-global entry point. In that state `rm -rf ~/.dkg/releases/`
    // would delete the live runtime, so only advise deletion when the
    // daemon's resolved entry point is NOT inside the releases tree.
    const runningFromReleases =
      !!state.daemon.entryPoint && isPathInside(state.daemon.entryPoint, releasesDir);
    findings.push(
      runningFromReleases
        ? {
            check: 'install-layout',
            severity: 'warning',
            message: `Edge daemon is still running from a legacy slot under the releases tree (${releasesDir}): ${state.daemon.entryPoint}`,
            advisory:
              `Edge nodes do not use blue-green slots under RFC-41, but this daemon is currently running from the legacy releases tree. Do NOT delete ${releasesDir} yet — that is the live runtime. Run 'dkg restart' (or re-install) so the daemon runs from the npm-global install, re-run 'dkg doctor' to confirm, and only then 'rm -rf ${releasesDir}'.`,
            subject: releasesDir,
            details: { entryPoint: state.daemon.entryPoint },
          }
        : {
            check: 'install-layout',
            severity: 'warning',
            message: `Legacy releases directory detected on an Edge node: ${releasesDir}`,
            advisory:
              `Edge nodes do not use blue-green slots under RFC-41. Safe to delete: 'rm -rf ${releasesDir}'. The daemon runs directly from the npm-global install.`,
            subject: releasesDir,
          },
    );
  }

  if (state.daemon.entryPoint && state.paths.npmGlobalDkg) {
    const insideNpmGlobal = isPathInside(state.daemon.entryPoint, state.paths.npmGlobalDkg);
    if (!insideNpmGlobal) {
      // Edge daemon is running from somewhere unexpected. Possible
      // causes: stale slot, contributor monorepo, manual override.
      // We report this as a warning so the operator + agent can
      // reason about it; `--json` consumers can branch on the
      // detail fields.
      findings.push({
        check: 'install-layout',
        severity: 'warning',
        message: 'Edge daemon entry point is not inside the npm-global install',
        advisory: "Expected the daemon to run from the npm-global install. Run 'dkg restart' if you recently re-installed; investigate $PATH and DKG_HOME if the mismatch persists.",
        subject: state.daemon.entryPoint,
        details: {
          entryPoint: state.daemon.entryPoint,
          npmGlobalDkg: state.paths.npmGlobalDkg,
        },
      });
    }
  }

  return findings;
}
