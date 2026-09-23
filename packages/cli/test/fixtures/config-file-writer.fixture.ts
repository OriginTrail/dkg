// Child-process writer for the cross-process config update test: signals it
// is loaded, waits for the start file, then applies `count` patches that each
// add one key of its own.
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DkgHomeFiles } from '../../src/config.js';

const [home, writer, count, startFile] = process.argv.slice(2);
const files = new DkgHomeFiles(home);
writeFileSync(`${startFile}.${writer}.ready`, '');
while (!existsSync(startFile)) await sleep(2);
for (let i = 0; i < Number(count); i += 1) {
  await files.updateConfigFile((config) => {
    (config as Record<string, unknown>)[`${writer}-${i}`] = i;
  });
}
