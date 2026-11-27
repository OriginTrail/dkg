import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { DKGAgent } from '../src/dkg-agent.js';
import { checkpointAgentFixture } from './helpers/public-checkpoint-agent-fixture.js';
import { cg } from './helpers/bulk-graph-fixture.js';

it('prepares a nonempty checkpoint through the public API without changing its actual Edge store or subscriptions', async () => {
  const f = await checkpointAgentFixture();
  let edge: DKGAgent | undefined;
  try {
    edge = await DKGAgent.create(f.config); await edge.start();
    const rows = [{ subject: 'urn:private', predicate: 'urn:value', object: '"retained"', graph: 'urn:private-graph' },
      { subject: 'urn:community', predicate: 'urn:value', object: '"retained"', graph: 'urn:community-graph' }];
    await edge.store.insert(rows);
    const before = await edge.store.query('SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
    const subscriptions = [...edge.getSubscribedContextGraphs()];
    const result = await edge.preparePublicGraphCheckpoint(f.sync);
    expect(result).toMatchObject({ assets: 3, committed: 0, current: false, activeStoreChanged: false });
    expect(JSON.parse(await readFile(`${result.directory}/manifest.json`, 'utf8')).assets).toHaveLength(3);
    expect(await edge.store.query('SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o')).toEqual(before);
    expect([...edge.getSubscribedContextGraphs()]).toEqual(subscriptions);
    expect(edge.getSubscribedContextGraphs().has(cg)).toBe(false);
  } finally { await edge?.stop(); await f.core.stop(); }
}, 30_000);
