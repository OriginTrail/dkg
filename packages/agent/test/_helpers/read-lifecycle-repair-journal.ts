import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NamedKaVmLifecycleSnapshots } from '../../src/named-ka-vm-lifecycle-snapshots.js';

export async function readLifecycleRepairJournalFile(path: string, dataDir = dirname(path)) {
  return new NamedKaVmLifecycleSnapshots(dataDir).decode(JSON.parse(await readFile(path, 'utf8')));
}
