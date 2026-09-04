import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runBuildCommand } from '../../../scripts/lib/run-build-command.mjs';

const prerequisiteRoots = [
  '@origintrail-official/dkg-adapter-openclaw',
  '@origintrail-official/dkg-adapter-hermes',
  '@origintrail-official/dkg-adapter-prime-agent',
  '@origintrail-official/dkg-mcp',
  '@origintrail-official/dkg-local-llm',
  '@origintrail-official/dkg-okf',
];

export function buildCliPrerequisites({
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  reportError = (message) => console.error(message),
} = {}) {
  // Only the checked root runtime plan sets this marker. A direct CLI build
  // keeps its dependency preparation, including clean adapter asset builds.
  if (env.DKG_RUNTIME_BUILD_TOPOLOGICAL === '1') return 0;
  const args = ['-r', ...prerequisiteRoots.flatMap(name => ['--filter', `${name}...`]), 'run', 'build'];
  return runBuildCommand('pnpm', args, { spawn, platform, env, reportError, label: 'CLI prerequisites' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = buildCliPrerequisites();
}
