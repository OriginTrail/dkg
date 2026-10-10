#!/usr/bin/env node
// Compile-time identity, never the checkout a running daemon happens to see.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBuildCommand } from './lib/run-build-command.mjs';
import {
  writeBuildMetadata, captureSourceBuildIdentity, certifyCapturedBuildIdentity,
  captureDevnetBuild, devnetBuildCacheMatchesCheckout, ensureDevnetBuildInfo,
} from './lib/build-info.mjs';

export function compileAndStampCliBuildInfo(rootDir = resolve(import.meta.dirname, '..'), distTag = 'monorepo') {
  const captured = captureSourceBuildIdentity(rootDir);
  const status = runBuildCommand('tsc', ['--noEmitOnError']);
  if (status === 0) writeBuildMetadata({ rootDir, distTag, ...certifyCapturedBuildIdentity(rootDir, captured) });
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, rootDir, before] = process.argv.slice(2);
    if (operation === '--compile') process.exitCode = compileAndStampCliBuildInfo();
    else if (operation === '--capture-devnet') console.log(JSON.stringify(captureDevnetBuild(rootDir)));
    else if (operation === '--check-devnet-cache') process.exitCode = devnetBuildCacheMatchesCheckout(rootDir) ? 0 : 1;
    else if (operation === '--ensure-devnet') ensureDevnetBuildInfo(rootDir, before ? JSON.parse(before) : undefined);
    else throw new Error(`Unsupported build identity operation: ${operation ?? '<missing>'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
