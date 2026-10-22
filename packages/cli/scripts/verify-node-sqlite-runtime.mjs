#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CLI_PACKAGE_JSON = path.resolve(path.dirname(SCRIPT_PATH), '..', 'package.json');

export function inspectInstallNodeRuntime(runtime = process) {
  const getBuiltinModule = runtime.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    return {
      nodeVersion: runtime.version,
      nodeSqliteAvailable: false,
      probe: 'unavailable',
    };
  }
  try {
    return {
      nodeVersion: runtime.version,
      nodeSqliteAvailable: Boolean(getBuiltinModule.call(runtime, 'node:sqlite')),
      probe: 'getBuiltinModule',
    };
  } catch {
    return {
      nodeVersion: runtime.version,
      nodeSqliteAvailable: false,
      probe: 'getBuiltinModule',
    };
  }
}

export function declaredNodeRuntimeRange(packageJsonPath = CLI_PACKAGE_JSON) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const range = packageJson?.engines?.node;
    return typeof range === 'string' && range.trim().length > 0
      ? range.trim()
      : '<missing engines.node>';
  } catch {
    return '<unreadable package metadata>';
  }
}

export function installNodeRuntimeFailureMessage(
  runtime = process,
  packageJsonPath = CLI_PACKAGE_JSON,
) {
  const status = inspectInstallNodeRuntime(runtime);
  if (status.nodeSqliteAvailable) return null;
  return (
    `Refusing to install DKG: node:sqlite is unavailable in Node.js ${status.nodeVersion}. `
    + `This release requires Node.js ${declaredNodeRuntimeRange(packageJsonPath)} and will not boot `
    + 'without the builtin. Upgrade Node.js, or set NODE_OPTIONS=--experimental-sqlite on a runtime that provides it.'
  );
}

export function runInstallNodeRuntimeGuard({
  runtime = process,
  packageJsonPath = CLI_PACKAGE_JSON,
  error = (message) => console.error(message),
} = {}) {
  const failure = installNodeRuntimeFailureMessage(runtime, packageJsonPath);
  if (failure === null) return true;
  error(failure);
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  if (!runInstallNodeRuntimeGuard()) process.exitCode = 1;
}
