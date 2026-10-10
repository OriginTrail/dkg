#!/usr/bin/env node
// Compile-time identity, never the checkout a running daemon happens to see.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeBuildMetadata } from './lib/build-info.mjs';

export function stampCliBuildInfo(rootDir = resolve(import.meta.dirname, '..'), distTag = 'monorepo', compile = false) {
  const git = args => {
    const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Build checkout identity is unavailable');
    return result.stdout.trim();
  };
  let commit = 'unknown';
  let dirty = null;
  try {
    const head = git(['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error('Invalid Git commit');
    dirty = git(['status', '--porcelain', '--untracked-files=normal']) !== '';
    // Exact-build gates comparing full SHAs must refuse uncertified dirty builds.
    commit = head + (dirty ? '-dirty' : '');
  } catch { /* Missing Git/evidence is explicitly unknown, never live-HEAD fallback. */ }
  if (compile) {
    const result = spawnSync('tsc', ['--noEmitOnError'], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error || result.status !== 0) {
      throw Object.assign(result.error ?? new Error(`CLI compilation failed with exit code ${result.status}`),
        { exitCode: result.status ?? 1 });
    }
    // A checkout changed during compilation cannot certify the captured clean SHA.
    if (dirty === false) {
      try {
        if (git(['rev-parse', 'HEAD']) !== commit
          || git(['status', '--porcelain', '--untracked-files=normal']) !== '') {
          dirty = true;
          commit += '-dirty';
        }
      } catch { commit = 'unknown'; dirty = null; }
    }
  }
  return writeBuildMetadata({ rootDir, distTag, commit, dirty }).payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--compile') stampCliBuildInfo(undefined, undefined, true);
    else stampCliBuildInfo(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
