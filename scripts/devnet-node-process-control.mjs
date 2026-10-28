// SPDX-License-Identifier: Apache-2.0
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectDevnetNodePids, stopNodeProcesses } from './lib/devnet-node-process-control.ts';
const [action, repoRoot, devnetDir, selected] = process.argv.slice(2);
if (!['collect', 'stop'].includes(action) || !repoRoot || !devnetDir || (selected && !/^[1-9][0-9]*$/.test(selected))) throw new Error('Invalid process-control arguments');
const paths = { repoRoot, devnetDir };
const numbers = selected ? [Number(selected)] : readdirSync(devnetDir).flatMap(name => /^node([1-9][0-9]*)$/.test(name) ? [Number(name.slice(4))] : []);
// Refuse every wrong live PID file before stopping any node.
const groups = numbers.map(num => ({ num, pids: collectDevnetNodePids(paths, num) }));
if (action === 'collect') console.log([...new Set(groups.flatMap(group => group.pids))].join(' '));
else for (const { num } of groups) {
  await stopNodeProcesses(paths, num, { removeUnparseable: true });
  rmSync(join(devnetDir, `node${num}`, 'api.port'), { force: true });
}
