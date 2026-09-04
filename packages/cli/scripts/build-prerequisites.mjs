import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  const result = spawn('pnpm', args, { stdio: 'inherit', shell: platform === 'win32', env });
  if (result.error) {
    reportError(result.error.message);
    return 1;
  }
  if (typeof result.status === 'number') return result.status;
  reportError(result.signal ? `CLI prerequisites exited via ${result.signal}` : 'CLI prerequisites exited without a status');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = buildCliPrerequisites();
}
