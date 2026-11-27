import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: unknown };

if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
  throw new Error('Prime Agent adapter package version is unavailable');
}

/** Version of the installed adapter package, kept in one runtime source. */
export const PRIME_AGENT_ADAPTER_VERSION = packageJson.version;
