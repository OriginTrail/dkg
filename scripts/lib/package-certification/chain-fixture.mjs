// Host control plane only. This source and its workspace imports are never
// mounted in the installed-product container.
import fs from 'node:fs';
import { spawnHardhatEnv, killHardhat } from '../../../packages/chain/test/hardhat-harness.ts';

const context = await spawnHardhatEnv();
fs.writeFileSync(process.argv[2], JSON.stringify({ rpcUrl: context.rpcUrl, hubAddress: context.hubAddress }));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await killHardhat(context);
  process.exit(0);
});
