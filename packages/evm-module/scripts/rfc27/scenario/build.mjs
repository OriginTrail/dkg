// Bundles the scenario's driver into one file, cache/rfc27-scenario/driver.cjs,
// so a beacon needs no checkout and no install. The request formats come from
// test/helpers, whose hardhat imports serve only functions the driver never
// calls, so they are stubbed out here.
//
//   node scripts/rfc27/scenario/build.mjs      (from packages/evm-module)

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '../../..');
const repoRoot = path.resolve(moduleRoot, '../..');
const require = createRequire(import.meta.url);
const { build } = require(path.join(repoRoot, 'node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild'));

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^(hardhat(\/.*)?|@nomicfoundation\/.*)$|\/(account-stack|profile-helpers)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

const outfile = path.join(moduleRoot, 'cache/rfc27-scenario/driver.cjs');
await build({
  entryPoints: [path.join(here, 'driver.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  plugins: [stubs],
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(path.relative(moduleRoot, outfile));
