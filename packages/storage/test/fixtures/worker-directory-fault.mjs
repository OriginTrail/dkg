// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.promises.open;
fs.promises.open = async (...args) => {
  const handle = await open(...args);
  if (String(args[0]) === process.env.DKG_TEST_SNAPSHOT_DIRECTORY
    && args[1] === 'r' && fs.existsSync(process.env.DKG_TEST_DIRECTORY_FAULT)) {
    handle.sync = async () => { throw Object.assign(new Error('worker snapshot directory EIO'), { code: 'EIO' }); };
  }
  return handle;
};
syncBuiltinESMExports();

await import('./worker-disable-background-flush.mjs');
