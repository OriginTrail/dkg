import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DKGAgent } from '../src/index.js';

const SWM_GRAPH = 'did:dkg:context-graph:test/_shared_memory';

describe('DKGAgent large literal storage defaults', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('externalizes large SWM literals for the default persistent dataDir store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-agent-large-literal-'));
    tempDirs.push(dataDir);
    const largeLiteral = `"${'agent-large-literal'.repeat(8)}"`;
    const hash = createHash('sha256').update(largeLiteral, 'utf8').digest('hex');

    const agent = await DKGAgent.create({
      name: 'LargeLiteralStorageAgent',
      dataDir,
      listenHost: '127.0.0.1',
      largeLiteralStorage: { thresholdBytes: 20 },
    });

    try {
      await agent.store.insert([{
        subject: 'urn:test:agent-large-literal',
        predicate: 'http://schema.org/value',
        object: largeLiteral,
        graph: SWM_GRAPH,
      }]);
      await agent.store.flush?.();

      const storeNq = await readFile(join(dataDir, 'store.nq'), 'utf8');
      expect(storeNq).toContain(`"sha256:${hash}"^^<http://dkg.io/ontology/externalLiteralRef>`);
      expect(storeNq).not.toContain('agent-large-literalagent-large-literalagent-large-literal');
      expect(await readFile(join(dataDir, 'literal-blobs', hash), 'utf8')).toBe(largeLiteral);

      const result = await agent.store.query(
        `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <urn:test:agent-large-literal> <http://schema.org/value> ?o } }`,
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        expect(result.bindings).toEqual([{ o: largeLiteral }]);
      }
    } finally {
      await agent.stop().catch(() => {});
      await agent.store.close().catch(() => {});
    }
  });

  it('also wraps explicit local Oxigraph store configs when dataDir is available', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-agent-local-oxigraph-literal-'));
    tempDirs.push(dataDir);
    const largeLiteral = `"${'agent-local-oxigraph'.repeat(8)}"`;
    const hash = createHash('sha256').update(largeLiteral, 'utf8').digest('hex');

    const agent = await DKGAgent.create({
      name: 'LocalOxigraphLargeLiteralStorageAgent',
      dataDir,
      listenHost: '127.0.0.1',
      storeConfig: { backend: 'oxigraph' },
      largeLiteralStorage: { thresholdBytes: 20 },
    });

    try {
      await agent.store.insert([{
        subject: 'urn:test:agent-local-oxigraph-large-literal',
        predicate: 'http://schema.org/value',
        object: largeLiteral,
        graph: SWM_GRAPH,
      }]);

      expect(await readFile(join(dataDir, 'literal-blobs', hash), 'utf8')).toBe(largeLiteral);

      const result = await agent.store.query(
        `SELECT ?o WHERE { GRAPH <${SWM_GRAPH}> { <urn:test:agent-local-oxigraph-large-literal> <http://schema.org/value> ?o } }`,
      );
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') {
        expect(result.bindings).toEqual([{ o: largeLiteral }]);
      }
    } finally {
      await agent.stop().catch(() => {});
      await agent.store.close().catch(() => {});
    }
  });
});
