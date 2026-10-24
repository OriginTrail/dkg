import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function run(command, args, { cwd = ROOT_DIR, log, env = {}, shell = false, timeout = 30 * 60_000 } = {}) {
  const fd = log ? fs.openSync(log, 'a') : undefined;
  try {
    const result = spawnSync(command, args, {
      cwd, shell, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, ...env },
      ...(fd === undefined ? {} : { stdio: ['ignore', fd, fd] }),
    });
    if (result.error || result.status !== 0) throw new Error(`${command} failed (exit ${result.status ?? 'unavailable'}); ${log ? 'see retained log' : [result.stdout, result.stderr].filter(Boolean).join('\n')}`, { cause: result.error });
    return result.stdout?.trim();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
