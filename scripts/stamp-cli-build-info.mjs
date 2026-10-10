#!/usr/bin/env node
// Compile-time identity, never the checkout a running daemon happens to see.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  writeBuildMetadata, captureSourceBuildIdentity, certifyCapturedBuildIdentity,
  captureDevnetBuild, devnetBuildCacheMatchesCheckout, ensureDevnetBuildInfo,
} from './lib/build-info.mjs';

export function stampCliBuildInfo(rootDir = resolve(import.meta.dirname, '..'), distTag = 'monorepo', compile = false) {
  let identity = captureSourceBuildIdentity(rootDir);
  if (compile) {
    const result = spawnSync('tsc', ['--noEmitOnError'], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error || result.status !== 0) {
      throw Object.assign(result.error ?? new Error(`CLI compilation failed with exit code ${result.status}`),
        { exitCode: result.status ?? 1 });
    }
    identity = certifyCapturedBuildIdentity(rootDir, identity);
  }
  return writeBuildMetadata({ rootDir, distTag, ...identity }).payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, rootDir, before] = process.argv.slice(2);
    if (operation === '--compile') stampCliBuildInfo(undefined, undefined, true);
    else if (operation === '--capture-devnet') console.log(JSON.stringify(captureDevnetBuild(rootDir)));
    else if (operation === '--check-devnet-cache') process.exitCode = devnetBuildCacheMatchesCheckout(rootDir) ? 0 : 1;
    else if (operation === '--ensure-devnet') ensureDevnetBuildInfo(rootDir, before ? JSON.parse(before) : undefined);
    else stampCliBuildInfo(operation, rootDir);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
