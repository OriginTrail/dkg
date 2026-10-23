import { expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { applyDefaultLargeLiteralStorage } from '../src/dkg-agent-helpers.js';

it.each(['files', 'sqlite-wal'] as const)('preserves the agent-selected %s blob layout through defaulting, same-instance reuse and durable reopen', async persistence => {
  const root = await mkdtemp(join(tmpdir(), 'dkg-agent-blob-layout-'));
  let store: TripleStore | undefined;
  try {
    const config = applyDefaultLargeLiteralStorage({ backend: 'oxigraph-persistent', options: { path: join(root, 'store.nq') } },
      root, { persistence, thresholdBytes: 16 });
    const graph = 'urn:agent-config/_shared_memory', object = JSON.stringify('retained layout '.repeat(4096));
    store = await createTripleStore(config);
    await store.insert([{ graph, subject: 'urn:asset', predicate: 'urn:value', object }]); await store.close();
    const files = await readdir(join(root, 'literal-blobs'));
    expect(files.includes('literal-blobs-v1.sqlite')).toBe(persistence === 'sqlite-wal');
    expect(files.some(name => /^[a-f0-9]{64}$/.test(name))).toBe(persistence === 'files');
    const nextObject = JSON.stringify('fresh after same-instance close '.repeat(4096));
    await store.insert([{ graph, subject: 'urn:next-asset', predicate: 'urn:value', object: nextObject }]);
    await expect(store.query(`SELECT ?value WHERE { GRAPH <${graph}> { <urn:next-asset> <urn:value> ?value } }`))
      .resolves.toMatchObject({ bindings: [{ value: nextObject }] });
    await store.close();
    store = await createTripleStore(config);
    await expect(store.query(`SELECT ?value WHERE { GRAPH <${graph}> { <urn:next-asset> <urn:value> ?value } }`))
      .resolves.toMatchObject({ bindings: [{ value: nextObject }] });
    await expect(store.query(`SELECT ?value WHERE { GRAPH <${graph}> { <urn:asset> <urn:value> ?value } }`))
      .resolves.toMatchObject({ bindings: [{ value: object }] });
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }); }
});
