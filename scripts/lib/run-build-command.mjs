import { spawnSync } from 'node:child_process';

/** Shared subprocess contract for the root and standalone package build paths. */
export function runBuildCommand(command, args, {
  spawn = spawnSync,
  platform = process.platform,
  env,
  label = `${command} ${args.join(' ')}`,
  reportError = (message) => console.error(message),
} = {}) {
  const result = spawn(command, args, {
    stdio: 'inherit',
    shell: platform === 'win32',
    ...(env === undefined ? {} : { env }),
  });
  if (result.error) {
    reportError(result.error.message);
    return 1;
  }
  if (typeof result.status === 'number') return result.status;
  reportError(result.signal ? `${label} exited via ${result.signal}` : `${label} exited without a status`);
  return 1;
}
