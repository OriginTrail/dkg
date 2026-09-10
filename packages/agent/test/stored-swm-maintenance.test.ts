import { describe, expect, it } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { GraphManager, type Quad } from '@origintrail-official/dkg-storage';
import { contextGraphSharedMemoryUri, contextGraphSharedMemoryMetaUri } from '@origintrail-official/dkg-core';

const DKG = 'http://dkg.io/ontology/';
const ENTITY = 'urn:maintenance:entity';
const OWNER = 'did:dkg:agent:maintenance';

describe('stored SWM maintenance without context-graph declarations', () => {
  it.each([
    { name: 'bare root', contextGraphId: 'runtime-private-query', subGraphName: undefined, data: true },
    { name: 'owner/name root', contextGraphId: `0x${'ab'.repeat(20)}/private-query`, subGraphName: undefined, data: true },
    { name: 'named scope', contextGraphId: `0x${'ab'.repeat(20)}/private-query`, subGraphName: 'Claims', data: true },
    { name: 'metadata-only named scope', contextGraphId: 'runtime-private-query', subGraphName: 'Claims', data: false },
  ])('expires $name and clears only its ownership partition', async ({ contextGraphId, subGraphName, data }) => {
    const agent = await DKGAgent.create({
      name: 'maintenance-test', listenPort: 0, sharedMemoryTtlMs: 60_000,
      rfc64CatalogActivation: { enabled: false },
    });
    try {
      const dataGraph = contextGraphSharedMemoryUri(contextGraphId, subGraphName);
      const metaGraph = contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName);
      const meta = (subject: string, predicate: string, object: string): Quad => ({ subject, predicate, object, graph: metaGraph });
      await agent.store.insert([
        meta('urn:expired', `${DKG}rootEntity`, ENTITY),
        meta('urn:expired', `${DKG}publishedAt`, '"2000-01-01T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'),
        meta('urn:expired', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${DKG}WorkspaceOperation`),
        meta(ENTITY, `${DKG}workspaceOwner`, OWNER),
        ...(data ? [
          { subject: ENTITY, predicate: 'urn:name', object: '"old"', graph: dataGraph },
          { subject: `${ENTITY}/.well-known/genid/child`, predicate: 'urn:name', object: '"child"', graph: `${dataGraph}/0xabc/1` },
        ] : []),
        { subject: 'urn:fresh', predicate: 'urn:name', object: '"fresh"', graph: dataGraph },
        { subject: ENTITY, predicate: 'urn:name', object: '"other scope"', graph: contextGraphSharedMemoryUri(contextGraphId, 'Other') },
      ]);
      const key = subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
      const otherKey = `${contextGraphId}\0Other`;
      const ownership = (agent as unknown as { workspaceOwnedEntities: Map<string, Map<string, string>> }).workspaceOwnedEntities;
      ownership.set(key, new Map([[ENTITY, OWNER], ['urn:fresh', OWNER]]));
      ownership.set(otherKey, new Map([[ENTITY, OWNER]]));
      expect(await new GraphManager(agent.store).listContextGraphs()).toEqual(['agents', 'ontology']);

      expect(await agent.cleanupExpiredSharedMemory()).toBe(data ? 6 : 4);
      expect(await agent.store.countQuads(metaGraph)).toBe(0);
      expect(await agent.store.countQuads(dataGraph)).toBe(1);
      expect(await agent.store.countQuads(`${dataGraph}/0xabc/1`)).toBe(0);
      expect(ownership.get(key)?.has(ENTITY)).toBe(false);
      expect(ownership.get(key)?.has('urn:fresh')).toBe(true);
      expect(ownership.get(otherKey)?.has(ENTITY)).toBe(true);
      expect(await agent.store.countQuads(contextGraphSharedMemoryUri(contextGraphId, 'Other'))).toBe(1);
      expect(await new GraphManager(agent.store).listContextGraphs()).toEqual(['agents', 'ontology']);
    } finally {
      await agent.stop();
      await agent.store.close();
    }
  });
});
