// SPDX-License-Identifier: Apache-2.0
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { planDevnetShutdown, executeDevnetShutdown } from './lib/devnet-node-process-control.ts';
const [action, repoRoot, devnetDir, selected, ...entries] = process.argv.slice(2);
if (!['collect', 'stop'].includes(action) || !repoRoot || !devnetDir || (selected && !/^[1-9][0-9]*$/.test(selected)) || entries.length % 2)
  throw new Error('Invalid process-control arguments');
const nodeCliEntries = {};
for (let i = 0; i < entries.length; i += 2) {
  if (!/^[1-9][0-9]*$/.test(entries[i])) throw new Error('Invalid configured node entry');
  nodeCliEntries[Number(entries[i])] = entries[i + 1];
}
function nodeNumbers() {
  if (selected) return [Number(selected)];
  let names;
  try { names = readdirSync(devnetDir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.flatMap(name => /^node([1-9][0-9]*)$/.test(name) ? [Number(name.slice(4))] : []);
}
const paths = { repoRoot, devnetDir, nodeCliEntries };
const numbers = nodeNumbers();
const plan = planDevnetShutdown(paths, numbers);
if (action === 'collect') console.log([...plan.identities.keys()].join(' '));
else {
  await executeDevnetShutdown(plan, { removeUnparseable: true });
  for (const num of numbers) rmSync(join(devnetDir, `node${num}`, 'api.port'), { force: true });
}
