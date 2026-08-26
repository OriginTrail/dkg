import { execFileSync } from 'node:child_process';

import { readCleanRepositoryHead } from '../../../../devnet/rfc64-persistence-lifecycle/evidence.ts';
import {
  assertGate2RuntimeManifestEqualV1,
  buildGate2RuntimeManifestV1,
  runGate2CleanRuntimeBuildV1,
  type Gate2RuntimeManifestV1,
} from '../../../../devnet/rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';
import { runRfc64PrivateGateArtifactLifecycleV1 } from './gate-artifact.mjs';

interface Rfc64PrivateGateCleanLaunchDependenciesV1 {
  readonly buildRuntimeManifest:
    (repoRoot: string, sourceRevision: string) => Readonly<Gate2RuntimeManifestV1>;
  readonly readCleanSourceRevision: (repoRoot: string) => string;
  readonly resolveSourceRevision: (repoRoot: string) => string;
  readonly runCleanRuntimeBuild: (repoRoot: string) => void;
}

const DEFAULT_DEPENDENCIES: Rfc64PrivateGateCleanLaunchDependenciesV1 = Object.freeze({
  buildRuntimeManifest: buildGate2RuntimeManifestV1,
  readCleanSourceRevision: readCleanRepositoryHead,
  resolveSourceRevision: (repoRoot) => execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim(),
  runCleanRuntimeBuild: runGate2CleanRuntimeBuildV1,
});

/**
 * Invalidate stale evidence first, then bind one live run to clean source and
 * runtime snapshots checked both before and after child execution.
 */
export async function runRfc64PrivateGateFromCleanBuildV1(input: {
  readonly artifactPath: string;
  readonly dependencies?: Partial<Rfc64PrivateGateCleanLaunchDependenciesV1>;
  readonly execute: (input: {
    readonly runtimeManifest: Readonly<Gate2RuntimeManifestV1>;
    readonly sourceRevision: string;
  }) => Promise<Record<string, unknown>>;
  readonly repoRoot: string;
}): Promise<Record<string, unknown>> {
  const dependencies = Object.freeze({
    ...DEFAULT_DEPENDENCIES,
    ...input.dependencies,
  });
  // Resolving HEAD does not require cleanliness, so the lifecycle can replace
  // any prior PASS before its execute phase checks the tracked tree.
  const sourceRevision = dependencies.resolveSourceRevision(input.repoRoot);
  return runRfc64PrivateGateArtifactLifecycleV1({
    artifactPath: input.artifactPath,
    sourceRevision,
    execute: async () => {
      assertExactSourceRevision(
        sourceRevision,
        dependencies.readCleanSourceRevision(input.repoRoot),
      );
      dependencies.runCleanRuntimeBuild(input.repoRoot);
      assertExactSourceRevision(
        sourceRevision,
        dependencies.readCleanSourceRevision(input.repoRoot),
      );
      const runtimeManifest = dependencies.buildRuntimeManifest(
        input.repoRoot,
        sourceRevision,
      );
      const artifact = await input.execute({ runtimeManifest, sourceRevision });
      assertExactSourceRevision(
        sourceRevision,
        dependencies.readCleanSourceRevision(input.repoRoot),
      );
      assertGate2RuntimeManifestEqualV1(
        dependencies.buildRuntimeManifest(input.repoRoot, sourceRevision),
        runtimeManifest,
      );
      return artifact;
    },
  });
}

function assertExactSourceRevision(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new Error('RFC-64 private gate source HEAD changed during the live run');
  }
}
