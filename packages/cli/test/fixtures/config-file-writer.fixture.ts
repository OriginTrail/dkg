// Child-process writer for the cross-process config update test: signals it
// is loaded, waits for the start file, then applies `count` edits that each
// add one key of its own.
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DkgHomeFiles, configValues, type DkgConfig } from '../../src/config.js';

const [home, writer, count, startFile] = process.argv.slice(2);
const files = new DkgHomeFiles(home);
writeFileSync(`${startFile}.${writer}.ready`, '');
while (!existsSync(startFile)) await sleep(2);
for (let i = 0; i < Number(count); i += 1) {
  // A key of its own, which the config type does not declare.
  await files.updateConfigFile(configValues({ [`${writer}-${i}`]: i } as Partial<DkgConfig>));
}
