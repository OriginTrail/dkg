import { createDKG } from '../src/index.js';

async function main() {
  const dkg = createDKG({
    baseUrl: process.env.DKG_BASE_URL ?? 'http://127.0.0.1:9200',
    token: process.env.DKG_TOKEN,
  });

  const status = await dkg.node.status();
  console.log('peerId:', status.peerId);

  const paranets = await dkg.paranet.list();
  console.log('paranet count:', paranets.paranets.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
