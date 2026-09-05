import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runBuildCommand } from '../../../scripts/lib/run-build-command.mjs';

export const CLI_PREREQUISITE_ROOTS = Object.freeze([
  '@origintrail-official/dkg-adapter-openclaw',
  '@origintrail-official/dkg-adapter-hermes',
  '@origintrail-official/dkg-adapter-prime-agent',
  '@origintrail-official/dkg-mcp',
  '@origintrail-official/dkg-local-llm',
  '@origintrail-official/dkg-okf',
]);

export function buildCliPrerequisites({
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  reportError = (message) => console.error(message),
} = {}) {
  const args = ['-r', ...CLI_PREREQUISITE_ROOTS.flatMap(name => ['--filter', `${name}...`]), 'run', 'build'];
  return runBuildCommand('pnpm', args, { spawn, platform, env, reportError, label: 'CLI prerequisites' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = buildCliPrerequisites();
}
