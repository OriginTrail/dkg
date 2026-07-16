#!/usr/bin/env node

const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const entrypoint = join(__dirname, '..', 'dist', 'benchmark', 'publish-get', 'index.js');

if (!existsSync(entrypoint)) {
  console.error(
    'Benchmark runner is not built. Run `pnpm --filter @origintrail-official/dkg build` before benchmark:publish-async-get.',
  );
  process.exitCode = 1;
} else {
  import(pathToFileURL(entrypoint).href)
    .then((mod) => mod.main(process.argv.slice(2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
