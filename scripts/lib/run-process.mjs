import { spawn } from 'node:child_process';

export function runProcess({
  args,
  command,
  cwd,
  env = process.env,
  failureLabel = `${command} ${args.join(' ')}`,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(
        `${failureLabel} failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`,
      ));
    });
  });
}
