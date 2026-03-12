import { createDKG } from '../src/index.js';

async function main() {
  const dkg = createDKG({
    baseUrl: process.env.DKG_BASE_URL ?? 'http://127.0.0.1:9200',
    token: process.env.DKG_TOKEN,
  });

  const paranetId = process.env.DKG_PARANET_ID ?? 'dev-coordination';
  const graph = `did:dkg:paranet:${paranetId}`;

  const publishResult = await dkg.publish.quads({
    paranetId,
    quads: [
      {
        subject: 'urn:entity:sdk:flow:1',
        predicate: 'http://schema.org/name',
        object: '"SDK Publish Query Example"',
        graph,
      },
    ],
  });

  console.log('published kcId:', publishResult.kcId, 'status:', publishResult.status);

  const queryResult = await dkg.query.sparql(
    'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name } LIMIT 10',
    { paranetId },
  );

  console.log('query result:', queryResult.result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
