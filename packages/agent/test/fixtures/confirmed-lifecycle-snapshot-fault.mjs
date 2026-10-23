// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.promises.open;
fs.promises.open = async (...args) => {
  if (String(args[0]).startsWith(process.env.DKG_TEST_SNAPSHOT_PATH) && args[1] === 'w'
    && fs.existsSync(process.env.DKG_TEST_SNAPSHOT_FAULT)) throw Object.assign(new Error('snapshot held before crash'), { code: 'EIO' });
  return open(...args);
};
syncBuiltinESMExports();
