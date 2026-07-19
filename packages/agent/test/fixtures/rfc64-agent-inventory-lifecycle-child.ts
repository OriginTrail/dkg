import { DKGAgent } from '../../src/dkg-agent.js';

const dataDirectory = process.env.DKG_RFC64_AGENT_INVENTORY_DATA_DIR;
if (!dataDirectory) {
  throw new Error('missing DKG_RFC64_AGENT_INVENTORY_DATA_DIR');
}

// Exercise the production DKGAgent-owned lifecycle without starting libp2p.
// The parent uses SIGTERM to invoke the real close path and SIGKILL to prove
// that the operating-system lease is recoverable without JavaScript cleanup.
const agent = Object.create(DKGAgent.prototype) as any;
Object.assign(agent, {
  config: { dataDir: dataDirectory },
  rfc64InventoryV1: undefined,
});

await agent.prepareRfc64InventoryV1();

let terminating = false;
process.once('SIGTERM', () => {
  if (terminating) return;
  terminating = true;
  void (async () => {
    try {
      await agent.closeRfc64InventoryV1();
      process.stdout.write('CLOSED\n', () => process.exit(0));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    }
  })();
});

process.stdout.write('READY\n');
setInterval(() => undefined, 60_000);
