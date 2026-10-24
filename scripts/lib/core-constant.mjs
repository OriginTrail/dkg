#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CORE_MODULE_URL = new URL('../../packages/core/dist/index.js', import.meta.url);

export function requireStringExport(moduleNamespace, exportName) {
  if (!Object.prototype.hasOwnProperty.call(moduleNamespace, exportName)) {
    throw new Error(`Core export ${exportName} is unavailable`);
  }
  const value = moduleNamespace[exportName];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Core export ${exportName} must be a non-empty string`);
  }
  return value;
}

export async function resolveCoreStringConstant(
  exportName,
  moduleUrl = DEFAULT_CORE_MODULE_URL,
) {
  const moduleNamespace = await import(moduleUrl.href);
  return requireStringExport(moduleNamespace, exportName);
}

async function main() {
  const exportName = process.argv[2];
  if (!exportName) {
    throw new Error('Usage: core-constant.mjs <export-name>');
  }
  process.stdout.write(await resolveCoreStringConstant(exportName));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[core-constant] ${message}`);
    process.exitCode = 1;
  });
}
