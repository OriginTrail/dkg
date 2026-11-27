import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: unknown };

if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
  throw new Error('DKG CLI package version is unavailable');
}

/** Version of the installed CLI package, sourced from its package manifest. */
export const DKG_CLI_PACKAGE_VERSION = packageJson.version;
