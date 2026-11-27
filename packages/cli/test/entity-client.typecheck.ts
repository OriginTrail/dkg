import { createEntityClient } from '../src/entity-search/client.js';
import type { EntityIndexSpec } from '../src/entity-search/types.js';

declare const post: <T>(path: string, body: unknown, deadline: { timeoutMs: number }) => Promise<T>;
declare const spec: EntityIndexSpec;
async function consumeEntityClient() {
  const client = createEntityClient(post);
  const index = await client.index(spec);
  const count: number = index.indexedEntities;
  const complete: boolean = index.scanComplete;
  const ready: boolean = (await client.readiness({ contextGraphId: spec.contextGraphId, indexId: index.indexId })).ready;
  const hits = await client.search({ contextGraphId: spec.contextGraphId, indexId: index.indexId, query: 'topic' });
  const score: number | undefined = hits.entities[0]?.score;
  const uri: string | undefined = hits.entities[0]?.entityUri;
  return { count, complete, ready, score, uri };
}
void consumeEntityClient;
