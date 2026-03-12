import { createDKG, DKGSDKError } from '../src/index.js';

async function main() {
  const dkg = createDKG({
    baseUrl: process.env.DKG_BASE_URL ?? 'http://127.0.0.1:9200',
    token: process.env.DKG_TOKEN,
    timeoutMs: 30_000,
    headers: {
      'X-Request-Source': 'sdk-auth-example',
    },
  });

  try {
    const status = await dkg.node.status();
    console.log('connected as:', status.peerId);
  } catch (err) {
    if (err instanceof DKGSDKError) {
      console.error('SDK error:', err.message, 'status:', err.status, 'code:', err.code);
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
