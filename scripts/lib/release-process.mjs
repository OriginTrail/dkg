import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function runCapture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT_DIR,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, ...options.env },
    // Needed to resolve `npm`/`npm.cmd` on Windows; harmless on POSIX.
    shell: options.shell ?? false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${result.status}${details ? `\n${details}` : ''}`);
  }
  return result.stdout.trim();
}

export function run(command, args, { cwd, log, env = {}, timeout = 30 * 60_000 } = {}) {
  const fd = log ? fs.openSync(log, 'a') : undefined;
  try {
    const result = spawnSync(command, args, {
      cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, ...env },
      ...(fd === undefined ? {} : { stdio: ['ignore', fd, fd] }),
    });
    if (result.error || result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? 'unavailable'}); ${log ? 'see retained log' : result.stderr ?? ''}`, { cause: result.error });
    return result.stdout?.trim();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
