// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
createRequire(import.meta.url)('oxigraph');
Object.defineProperty(process, 'platform', { value:'win32', configurable:true });
const open = fs.promises.open;
fs.promises.open = async (...args) => {
  fs.appendFileSync(process.env.DKG_TEST_OPEN_TRACE, JSON.stringify([String(args[0]), args[1]])+'\n');
  if (String(args[0]) === process.env.DKG_TEST_SNAPSHOT_DIRECTORY && args[1] === 'r') {
    throw Object.assign(new Error('Windows directory handle refused'), { code:'EACCES' });
  }
  const handle = await open(...args), sync = handle.sync.bind(handle);
  handle.sync = async () => { await sync(); fs.appendFileSync(process.env.DKG_TEST_OPEN_TRACE, JSON.stringify(['sync', String(args[0]), args[1]])+'\n'); };
  return handle;
};
syncBuiltinESMExports();

await import('./worker-disable-background-flush.mjs');
