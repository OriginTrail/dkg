import { execFileSync } from 'node:child_process';

import { readCleanRepositoryHead } from '../../../../devnet/rfc64-persistence-lifecycle/evidence.ts';
import {
  GATE2_RUNTIME_PACKAGE_CLOSURE,
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
  readCleanSourceRevision: readCleanRuntimeBuildSourceRevisionV1,
  resolveSourceRevision: (repoRoot) => execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim(),
  runCleanRuntimeBuild: runGate2CleanRuntimeBuildV1,
});

const RUNTIME_BUILD_INPUT_PATHS = Object.freeze([
  ...GATE2_RUNTIME_PACKAGE_CLOSURE.map(({ path }) => (
    path.endsWith('/dist') ? path.slice(0, -'/dist'.length) : path
  )),
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
]);

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
  return runRfc64PrivateGateArtifactLifecycleV1({
    artifactPath: input.artifactPath,
    resolveSourceRevision: () => dependencies.resolveSourceRevision(input.repoRoot),
    execute: async ({ sourceRevision }: { sourceRevision: string | null }) => {
      if (sourceRevision === null) {
        throw new Error('RFC-64 private gate requires an exact source revision');
      }
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

/** Reject compiler inputs that cannot be reproduced from the claimed commit. */
function readCleanRuntimeBuildSourceRevisionV1(repoRoot: string): string {
  const sourceRevision = readCleanRepositoryHead(repoRoot);
  const untrackedBuildInputs = execFileSync('git', [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...RUNTIME_BUILD_INPUT_PATHS,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (untrackedBuildInputs !== '') {
    throw new Error(
      'RFC-64 private gate refuses untracked runtime build inputs:\n'
      + untrackedBuildInputs,
    );
  }
  return sourceRevision;
}
