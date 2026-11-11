import { describe, expect, it } from 'vitest';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphCatalogUri, contextGraphDataGraphUri, contextGraphDataUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { generateSubGraphRegistration } from '@origintrail-official/dkg-publisher';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { DKGAgent } from '../src/dkg-agent.js';

describe('ContextGraphMetaProjection', () => {
  it('enumerates declared context graph ids from ontology, agents, and root _meta graphs', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const ontologyId = 'projection-list-ontology';
    const agentsId = 'projection-list-agents';
    const metaId = '0x0000000000000000000000000000000000000abc/projection-list-meta';
    const metaSubGraphId = `${metaId}/tasks`;

    await store.insert([
      {
        subject: contextGraphDataGraphUri(ontologyId),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: contextGraphDataGraphUri(agentsId),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: agentsGraph,
      },
      {
        subject: contextGraphDataGraphUri(metaId),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: contextGraphMetaGraphUri(metaId),
      },
      {
        subject: contextGraphDataGraphUri(metaSubGraphId),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: contextGraphMetaGraphUri(metaSubGraphId),
      },
    ]);

    expect(await projection.listDeclaredContextGraphIds()).toEqual([
      agentsId,
      metaId,
      ontologyId,
    ].sort());
  });

  it('lets root _meta scalar fields override older ontology and agents declarations', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-meta-authoritative';
    const uri = contextGraphDataGraphUri(id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Old ontology name"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000001', graph: ontologyGraph },
      { subject: uri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: '"101"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION, object: '"Old agents description"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000002', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Fresh meta name"', graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION, object: '"Fresh meta description"', graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000003', graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000004', graph: metaGraph },
      { subject: uri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: '"202"', graph: metaGraph },
    ]);

    const meta = await projection.get(id);
    expect(meta.name).toBe('Fresh meta name');
    expect(meta.description).toBe('Fresh meta description');
    expect(meta.creator).toBe('did:dkg:agent:0x0000000000000000000000000000000000000003');
    expect(meta.curator).toBe('did:dkg:agent:0x0000000000000000000000000000000000000004');
    expect(meta.onChainId).toBe('202');
    expect(meta.creators).toEqual(['did:dkg:agent:0x0000000000000000000000000000000000000003']);
    expect(meta.curators).toEqual([
      'did:dkg:agent:0x0000000000000000000000000000000000000004',
      'did:dkg:agent:0x0000000000000000000000000000000000000001',
    ]);
  });

  it('keeps a CG private once any source declares private, even if root _meta later declares public (one-way ratchet)', async () => {
    // Privacy is a one-way ratchet (product decision 2026-06-16): a later `public`
    // declaration must NOT downgrade a CG that any source already declared private.
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-meta-public-after-private';
    const uri = contextGraphDataGraphUri(id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: metaGraph },
    ]);

    expect((await projection.get(id)).accessPolicy).toBe('private');
  });

  it('preserves case-sensitive projected metadata while folding address-only lists', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-case-sensitive-metadata';
    const uri = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    const address = '0x0000000000000000000000000000000000000aBc';
    const addressVariant = '0x0000000000000000000000000000000000000AbC';
    const peer = '12D3KooWCaseSensitivePeer';
    const peerVariant = '12d3koowcasesensitivepeer';

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER, object: `"${peer}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER, object: `"${peerVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `"did:dkg:agent:${peer}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `"did:dkg:agent:${peerVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, object: `"identity:${peer}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, object: `"identity:${peerVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${address}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${addressVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, object: `"${address}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, object: `"${addressVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: `"${address}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: `"${addressVariant}"`, graph: metaGraph },
    ]);

    const meta = await projection.get(id);
    expect(meta.allowedPeers).toHaveLength(2);
    expect(meta.allowedPeers).toEqual(expect.arrayContaining([peer, peerVariant]));
    expect(meta.creators).toHaveLength(2);
    expect(meta.creators).toEqual(expect.arrayContaining([`did:dkg:agent:${peer}`, `did:dkg:agent:${peerVariant}`]));
    expect(meta.participantIdentityIds).toHaveLength(2);
    expect(meta.participantIdentityIds).toEqual(expect.arrayContaining([`identity:${peer}`, `identity:${peerVariant}`]));
    expect(meta.allowedAgents).toHaveLength(1);
    expect(meta.allowedAgents[0]?.toLowerCase()).toBe(address.toLowerCase());
    expect(meta.participantAgents).toHaveLength(1);
    expect(meta.participantAgents[0]?.toLowerCase()).toBe(address.toLowerCase());
    expect(meta.revokedAgents).toHaveLength(1);
    expect(meta.revokedAgents[0]?.toLowerCase()).toBe(address.toLowerCase());
  });

  it('takes a private policy from the AGENTS graph and invalidates allowlist mutations', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = '0x0000000000000000000000000000000000000abc/projection-agents-private';
    const uri = contextGraphDataGraphUri(id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000111', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: '"0x0000000000000000000000000000000000000333"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: '"0x0000000000000000000000000000000000000111"', graph: metaGraph },
    ]);

    const first = await projection.get(id);
    expect(first.accessPolicy).toBe('private');
    expect(first.curator).toBeUndefined();
    expect(first.allowedAgents).toEqual(['0x0000000000000000000000000000000000000111']);
    expect(first.revokedAgents).toEqual([]);

    const addedAgent: Quad = {
      subject: uri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: '"0x0000000000000000000000000000000000000222"',
      graph: metaGraph,
    };
    await store.insert([addedAgent]);
    expect(projection.markDirtyFromQuads([addedAgent])).toEqual([id]);

    const second = await projection.get(id);
    expect(second.allowedAgents).toHaveLength(2);
    expect(second.allowedAgents).toEqual(expect.arrayContaining([
      '0x0000000000000000000000000000000000000111',
      '0x0000000000000000000000000000000000000222',
    ]));
  });

  describe('a context graph access list comes from its own metadata', () => {
    const id = '0x0000000000000000000000000000000000000abc/projection-access-list';
    const uri = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const member = '0x0000000000000000000000000000000000000111';
    const wallet = '0x0000000000000000000000000000000000000222';
    const row = (predicate: string, value: string, graph: string): Quad => (
      { subject: uri, predicate, object: `"${value}"`, graph }
    );
    const accessRows = (graph: string): Quad[] => [
      row(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet, graph),
      row(DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, wallet, graph),
      row(DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, '7', graph),
      row(DKG_ONTOLOGY.DKG_ALLOWED_PEER, 'peer-shared', graph),
      row(DKG_ONTOLOGY.DKG_REVOKED_AGENT, member, graph),
    ];
    const ownRows = (): Quad[] => [
      row(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, member, metaGraph),
      row(DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, member, metaGraph),
      row(DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, '5', metaGraph),
      row(DKG_ONTOLOGY.DKG_ALLOWED_PEER, 'peer-own', metaGraph),
    ];

    it.each([
      ['AGENTS', agentsGraph],
      ['ONTOLOGY', ontologyGraph],
    ])('takes none of it from the %s graph', async (_name, graph) => {
      const store = new OxigraphStore();
      await store.insert([...ownRows(), ...accessRows(graph)]);

      const meta = await new ContextGraphMetaProjection(store).get(id);

      expect(meta.allowedAgents).toEqual([member]);
      expect(meta.participantAgents).toEqual([member]);
      expect(meta.participantIdentityIds).toEqual(['5']);
      expect(meta.allowedPeers).toEqual(['peer-own']);
      expect(meta.revokedAgents).toEqual([]);
    });

    it.each([
      ['AGENTS', agentsGraph],
      ['ONTOLOGY', ontologyGraph],
    ])('reports no gate from the %s graph alone', async (_name, graph) => {
      const store = new OxigraphStore();
      await store.insert(accessRows(graph));

      const meta = await new ContextGraphMetaProjection(store).get(id);

      expect(meta).toMatchObject({ hasAgentGate: false, hasPeerGate: false, hasLegacyParticipantGate: false });
      expect(meta.accessPolicy).toBeUndefined();
    });

    it('takes no one who speaks for the graph from the AGENTS graph', async () => {
      const store = new OxigraphStore();
      await store.insert([
        { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${wallet}`, graph: agentsGraph },
        { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${wallet}`, graph: agentsGraph },
        row(`${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, '101', agentsGraph),
      ]);

      const meta = await new ContextGraphMetaProjection(store).get(id);

      expect(meta).toMatchObject({ creators: [], curators: [] });
      expect(meta.creator).toBeUndefined();
      expect(meta.curator).toBeUndefined();
      expect(meta.onChainId).toBeUndefined();
    });

    it('still takes a public graph\'s definition from the ONTOLOGY graph', async () => {
      const store = new OxigraphStore();
      await store.insert([
        { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
        row(DKG_ONTOLOGY.SCHEMA_NAME, 'Public graph', ontologyGraph),
        row(DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'public', ontologyGraph),
        row(`${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, '101', ontologyGraph),
        { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${wallet}`, graph: ontologyGraph },
        { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${member}`, graph: ontologyGraph },
      ]);

      expect(await new ContextGraphMetaProjection(store).get(id)).toMatchObject({
        declared: true,
        name: 'Public graph',
        accessPolicy: 'public',
        onChainId: '101',
        creator: `did:dkg:agent:${wallet}`,
        curator: `did:dkg:agent:${member}`,
      });
    });

    it('takes existence, a description and a private policy from the AGENTS graph, and no public one', async () => {
      const store = new OxigraphStore();
      await store.insert([
        { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
        row(DKG_ONTOLOGY.SCHEMA_NAME, 'Declared', agentsGraph),
        row(DKG_ONTOLOGY.SCHEMA_DESCRIPTION, 'A description', agentsGraph),
        row(DKG_ONTOLOGY.DKG_CREATED_AT, '2026-10-31T00:00:00Z', agentsGraph),
        row(DKG_ONTOLOGY.DKG_ACCESS_POLICY, ' PUBLIC ', agentsGraph),
      ]);

      const projection = new ContextGraphMetaProjection(store);
      const declaredMeta = await projection.get(id);
      expect(declaredMeta).toMatchObject({
        declared: true,
        name: 'Declared',
        description: 'A description',
        createdAt: '2026-10-31T00:00:00Z',
      });
      expect(declaredMeta.accessPolicy).toBeUndefined();

      const privateRow = row(DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'private', agentsGraph);
      await store.insert([privateRow]);
      projection.markDirtyFromQuads([privateRow]);
      expect((await projection.get(id)).accessPolicy).toBe('private');
    });

    it('takes a restricted access class from the AGENTS graph', async () => {
      const store = new OxigraphStore();
      await store.insert([{
        subject: uri,
        predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
        object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED,
        graph: agentsGraph,
      }]);

      expect((await new ContextGraphMetaProjection(store).get(id)).accessPolicy).toBe('private');
    });

    it('keeps the record of the agents system graph itself', async () => {
      const store = new OxigraphStore();
      await store.insert([
        { subject: agentsGraph, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
        { subject: agentsGraph, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Agent Registry"', graph: agentsGraph },
      ]);

      expect(await new ContextGraphMetaProjection(store).get(SYSTEM_CONTEXT_GRAPHS.AGENTS))
        .toMatchObject({ declared: true, isSystem: true, name: 'Agent Registry' });
    });

    it('keeps the disclosure floor of the catalog graph', async () => {
      const store = new OxigraphStore();
      const catalogGraph = contextGraphCatalogUri(id);
      await store.insert([
        { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph: catalogGraph },
        row(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet, catalogGraph),
        row(DKG_ONTOLOGY.SCHEMA_NAME, 'Catalog name', catalogGraph),
      ]);

      const meta = await new ContextGraphMetaProjection(store).get(id);

      expect(meta).toMatchObject({ declared: true, accessPolicy: 'private', allowedAgents: [] });
      expect(meta.name).toBeUndefined();
    });
  });

  it('does not dirty policy entries for unrelated tentative KC metadata', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-tentative-no-thrash';
    const uri = contextGraphDataGraphUri(id);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
    ]);

    expect((await projection.get(id)).accessPolicy).toBeUndefined();

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: agentsGraph },
    ]);

    const tentativeQuad: Quad = {
      subject: `did:dkg:assertion:${id}:tentative`,
      predicate: 'https://dkg.network/ontology#assertionStatus',
      object: '"TENTATIVE"',
      graph: metaGraph,
    };
    const rootLikeDataQuad: Quad = {
      subject: uri,
      predicate: DKG_ONTOLOGY.SCHEMA_NAME,
      object: '"Not authoritative metadata"',
      graph: contextGraphDataGraphUri('projection-user-data'),
    };
    expect(projection.markDirtyFromQuads([tentativeQuad, rootLikeDataQuad])).toEqual([]);
    expect((await projection.get(id)).accessPolicy).toBeUndefined();

    projection.markDirty(id);
    expect((await projection.get(id)).accessPolicy).toBe('private');
  });

  it('advances the authority revision for every workspace recipient fact', () => {
    const projection = new ContextGraphMetaProjection({} as TripleStore);
    const predicates = [
      DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
      DKG_ONTOLOGY.DKG_REVOKED_AGENT,
      DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
      DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
      DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
      DKG_ONTOLOGY.DKG_PEER_ID,
      DKG_ONTOLOGY.DKG_REVOKED_AT,
      DKG_ONTOLOGY.DKG_REVOKED_BY,
      DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF,
    ];

    for (const predicate of predicates) {
      const before = projection.readAuthorityFactsRevision;
      expect(projection.markDirtyFromQuads([{
        subject: 'did:dkg:agent:recipient-revision',
        predicate,
        object: '"value"',
        graph: 'did:dkg:context-graph:agents',
      }])).toEqual([]);
      expect(projection.readAuthorityFactsRevision).toBe(before + 1);
    }
  });

  it('advances the authority revision for an opaque non-CG subject replacement target', () => {
    const projection = new ContextGraphMetaProjection({} as TripleStore);
    const before = projection.readAuthorityFactsRevision;

    projection.markDirtyForGraph('urn:dkg:local:join-encryption-key-cache');

    expect(projection.readAuthorityFactsRevision).toBe(before + 1);
  });

  it('fences one graph without discarding its proof for unrelated metadata writes', () => {
    const projection = new ContextGraphMetaProjection({} as TripleStore);
    const target = 'projection-target';
    const before = projection.readContextGraphAuthorityFactsRevision(target);

    projection.markDirty('projection-other');
    projection.markDirtyForGraph('urn:dkg:local:join-encryption-key-cache');
    expect(projection.readContextGraphAuthorityFactsRevision(target)).toBe(before);

    projection.markDirtyForGraph(contextGraphMetaGraphUri(target));
    const afterOwnWrite = projection.readContextGraphAuthorityFactsRevision(target);
    expect(afterOwnWrite).not.toBe(before);

    projection.markAllDirty();
    expect(projection.readContextGraphAuthorityFactsRevision(target)).not.toBe(afterOwnWrite);
  });

  it('rebuilds a cached record on request without advancing either authority revision', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-fresh-read';
    const member = '0x00000000000000000000000000000000000000aa';
    const policyQuad: Quad = {
      subject: contextGraphDataUri(id),
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"',
      graph: contextGraphMetaGraphUri(id),
    };
    await store.insert([policyQuad]);
    expect((await projection.get(id)).allowedAgents).toEqual([]);

    // This fixture's bare store reports nothing to the projection, so the
    // cached record is stale from here on.
    await store.insert([{ ...policyQuad, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${member}"` }]);
    expect((await projection.get(id)).allowedAgents).toEqual([]);

    const nodeWide = projection.readAuthorityFactsRevision;
    const perGraph = projection.readContextGraphAuthorityFactsRevision(id);
    projection.requireFreshRead(id);
    expect(projection.readAuthorityFactsRevision).toBe(nodeWide);
    expect(projection.readContextGraphAuthorityFactsRevision(id)).toBe(perGraph);
    expect((await projection.get(id)).allowedAgents).toEqual([member]);

    // A reported change still moves both revisions after a fresh-read request.
    projection.markDirty(id);
    expect(projection.readAuthorityFactsRevision).toBe(nodeWide + 1);
    expect(projection.readContextGraphAuthorityFactsRevision(id)).not.toBe(perGraph);
    const afterOwnChange = projection.readContextGraphAuthorityFactsRevision(id);
    projection.markAllDirty();
    expect(projection.readAuthorityFactsRevision).toBe(nodeWide + 2);
    expect(projection.readContextGraphAuthorityFactsRevision(id)).not.toBe(afterOwnChange);
    await store.close();
  });

  it('leaves a graph it holds no record of untouched by a fresh-read request', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-fresh-read-unknown';
    const nodeWide = projection.readAuthorityFactsRevision;
    const perGraph = projection.readContextGraphAuthorityFactsRevision(id);

    projection.requireFreshRead(id);

    expect(projection.readAuthorityFactsRevision).toBe(nodeWide);
    expect(projection.readContextGraphAuthorityFactsRevision(id)).toBe(perGraph);
    expect((projection as unknown as { entries: Map<string, unknown> }).entries.has(id)).toBe(false);
    expect((await projection.get(id)).declared).toBe(false);
    await store.close();
  });

  it('supersedes an in-flight rebuild on a fresh-read request, as an invalidation does', async () => {
    let releaseFirstQuery!: () => void;
    const firstQuery = new Promise<void>((resolve) => { releaseFirstQuery = resolve; });
    let queryCalls = 0;
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const store = {
      async query(sparql: string) {
        queryCalls += 1;
        const callNumber = queryCalls;
        if (callNumber === 1) await firstQuery;
        if (callNumber <= 4) return { type: 'bindings', bindings: [] };
        if (sparql.includes(`<${agentsGraph}>`)) {
          return {
            type: 'bindings',
            bindings: [{ p: DKG_ONTOLOGY.DKG_ACCESS_POLICY, o: '"private"' }],
          };
        }
        return { type: 'bindings', bindings: [] };
      },
    } as unknown as TripleStore;
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-inflight-fresh-read';

    const first = projection.get(id);
    const nodeWide = projection.readAuthorityFactsRevision;
    const perGraph = projection.readContextGraphAuthorityFactsRevision(id);
    projection.requireFreshRead(id);
    const afterRequest = projection.get(id);
    releaseFirstQuery();

    expect((await first).accessPolicy).toBeUndefined();
    expect((await afterRequest).accessPolicy).toBe('private');
    // The superseded rebuild is not kept as the clean cached value either.
    expect((await projection.get(id)).accessPolicy).toBe('private');
    expect(projection.readAuthorityFactsRevision).toBe(nodeWide);
    expect(projection.readContextGraphAuthorityFactsRevision(id)).toBe(perGraph);
  });

  it('rebuilds for callers that arrive after invalidation during an in-flight rebuild', async () => {
    let releaseFirstQuery!: () => void;
    const firstQuery = new Promise<void>((resolve) => { releaseFirstQuery = resolve; });
    let queryCalls = 0;
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const store = {
      async query(sparql: string) {
        queryCalls += 1;
        const callNumber = queryCalls;
        if (callNumber === 1) await firstQuery;
        if (callNumber <= 4) return { type: 'bindings', bindings: [] };
        if (sparql.includes(`<${agentsGraph}>`)) {
          return {
            type: 'bindings',
            bindings: [{ p: DKG_ONTOLOGY.DKG_ACCESS_POLICY, o: '"private"' }],
          };
        }
        return { type: 'bindings', bindings: [] };
      },
    } as unknown as TripleStore;
    const projection = new ContextGraphMetaProjection(store);

    const first = projection.get('projection-inflight-dirty');
    projection.markDirty('projection-inflight-dirty');
    const afterDirty = projection.get('projection-inflight-dirty');
    releaseFirstQuery();

    expect((await first).accessPolicy).toBeUndefined();
    expect((await afterDirty).accessPolicy).toBe('private');
    expect(queryCalls).toBeGreaterThan(4);
  });

  it('joins a clean in-flight refresh instead of serving its stale cached authorization', async () => {
    let policy = 'public';
    let blockNextQuery = false;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    let releaseRefresh!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const store = {
      async query(sparql: string) {
        if (blockNextQuery) {
          blockNextQuery = false;
          refreshStarted();
          await blocked;
        }
        if (sparql.includes(`<${ontologyGraph}>`)) {
          return {
            type: 'bindings',
            bindings: [{ p: DKG_ONTOLOGY.DKG_ACCESS_POLICY, o: `"${policy}"` }],
          };
        }
        return { type: 'bindings', bindings: [] };
      },
    } as unknown as TripleStore;
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-clean-inflight-refresh';

    expect((await projection.get(id)).accessPolicy).toBe('public');
    policy = 'private';
    projection.markDirty(id);
    blockNextQuery = true;
    const refresh = projection.get(id);
    await started;

    let concurrentSettled = false;
    const concurrent = projection.get(id).finally(() => { concurrentSettled = true; });
    await Promise.resolve();
    expect(concurrentSettled).toBe(false);

    releaseRefresh();
    expect((await refresh).accessPolicy).toBe('private');
    expect((await concurrent).accessPolicy).toBe('private');
  });

  it('honors caller cancellation while waiting on a shared in-flight rebuild', async () => {
    let releaseQuery!: () => void;
    const blockedQuery = new Promise<void>((resolve) => { releaseQuery = resolve; });
    let queryCalls = 0;
    const store = {
      async query() {
        queryCalls += 1;
        await blockedQuery;
        return { type: 'bindings', bindings: [] };
      },
    } as unknown as TripleStore;
    const projection = new ContextGraphMetaProjection(store);
    const first = projection.get('projection-abort-inflight');
    await Promise.resolve();

    const controller = new AbortController();
    const second = projection.get('projection-abort-inflight', { signal: controller.signal });
    controller.abort(new Error('projection aborted'));

    await expect(second).rejects.toThrow('projection aborted');
    releaseQuery();
    await expect(first).resolves.toMatchObject({ id: 'projection-abort-inflight' });
    expect(queryCalls).toBeGreaterThan(0);
  });

  it('does not let the first caller abort poison a shared in-flight rebuild', async () => {
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });
    let releaseQuery!: () => void;
    const blockedQuery = new Promise<void>((resolve) => { releaseQuery = resolve; });
    let queryCalls = 0;
    const store = {
      async query(_sparql: string, options?: { signal?: AbortSignal }) {
        queryCalls += 1;
        if (queryCalls === 1) {
          queryStarted();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              reject(options?.signal?.reason);
            };
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            blockedQuery.then(() => {
              options?.signal?.removeEventListener('abort', onAbort);
              resolve();
            }, reject);
          });
        }
        return { type: 'bindings', bindings: [] };
      },
    } as unknown as TripleStore;
    const projection = new ContextGraphMetaProjection(store);
    const firstCaller = new AbortController();
    const first = projection.get('projection-first-abort-shared', { signal: firstCaller.signal });
    await started;

    const second = projection.get('projection-first-abort-shared');
    firstCaller.abort(new Error('first caller aborted'));

    await expect(first).rejects.toThrow('first caller aborted');
    releaseQuery();
    await expect(second).resolves.toMatchObject({ id: 'projection-first-abort-shared' });
    expect(queryCalls).toBeGreaterThan(0);
  });

  it('projects sub-graph registrations from the context graph meta graph', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-subgraphs';
    const uri = contextGraphDataGraphUri(id);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const registration = generateSubGraphRegistration({
      contextGraphId: id,
      subGraphName: 'tasks',
      createdBy: 'projection-test',
      description: 'Task memory',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      ...registration,
    ]);
    projection.markDirtyFromQuads(registration);

    expect((await projection.get(id)).subGraphs).toEqual([
      {
        uri: `${uri}/tasks`,
        name: 'tasks',
        createdBy: 'did:dkg:agent:projection-test',
        createdAt: '2026-01-01T00:00:00Z',
        description: 'Task memory',
      },
    ]);
  });

  it('returns defensive copies of cached array metadata', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-defensive-copy';
    const uri = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    const registration = generateSubGraphRegistration({
      contextGraphId: id,
      subGraphName: 'copy-safe',
      createdBy: 'projection-test',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER, object: '"12D3KooWCopySafePeer111111111111111111111111"', graph: metaGraph },
      ...registration,
    ]);

    const first = await projection.get(id);
    first.allowedPeers.push('poisoned-peer');
    first.subGraphs[0]!.name = 'poisoned-subgraph';

    const second = await projection.get(id);
    expect(second.allowedPeers).toEqual(['12D3KooWCopySafePeer111111111111111111111111']);
    expect(second.subGraphs[0]?.name).toBe('copy-safe');
  });

  it('filters projected revoked agents from private participant authorization lists', async () => {
    const revoked = '0x0000000000000000000000000000000000000111';
    const active = '0x0000000000000000000000000000000000000222';
    const agentLike = {
      subscribedContextGraphs: new Map<string, { participantAgents?: string[] }>([
        ['projection-agents-private', { participantAgents: [revoked] }],
      ]),
      getCgMeta: async () => ({
        allowedAgents: [revoked, active],
        participantAgents: [revoked],
        participantIdentityIds: ['identity:legacy'],
        revokedAgents: [revoked],
      }),
    };

    const participants = await (DKGAgent.prototype as unknown as {
      getPrivateContextGraphParticipants(this: unknown, contextGraphId: string): Promise<string[] | null>;
    }).getPrivateContextGraphParticipants.call(agentLike, 'projection-agents-private');

    expect(participants).toEqual([active, 'identity:legacy']);
  });

  it('routes wallet curators through the creator peer an ONTOLOGY definition names', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-ontology-curator-route';
    const uri = contextGraphDataGraphUri(id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const curatorAddress = '0x0000000000000000000000000000000000000abc';
    const creatorPeerId = '12D3KooWOntologyCreatorPeer1111111111111111111111';

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${curatorAddress}`, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${creatorPeerId}`, graph: ontologyGraph },
    ]);

    const agentLike = {
      preferredSyncPeers: new Map<string, string>(),
      getCgMeta: (contextGraphId: string) => projection.get(contextGraphId),
      discovery: {
        findAgents: async () => {
          throw new Error('registry fallback should not be needed');
        },
      },
    };

    const curatorPeerId = await (DKGAgent.prototype as unknown as {
      resolveCuratorPeerId(this: unknown, contextGraphId: string): Promise<string | undefined>;
    }).resolveCuratorPeerId.call(agentLike, id);

    expect(curatorPeerId).toBe(creatorPeerId);
  });

  it('filters projected revoked agents from registration participant agents', async () => {
    const revoked = '0x0000000000000000000000000000000000000111';
    const active = '0x0000000000000000000000000000000000000222';
    const agentLike = {
      getCgMeta: async () => ({
        allowedAgents: [revoked, active],
        participantAgents: [revoked],
        revokedAgents: [revoked],
      }),
    };

    const participants = await (DKGAgent.prototype as unknown as {
      getContextGraphParticipantAgentAddresses(this: unknown, contextGraphId: string): Promise<string[]>;
    }).getContextGraphParticipantAgentAddresses.call(agentLike, 'projection-agents-private');

    expect(participants).toEqual([active]);
  });

  // ── OT-RFC-49 catalog read-path (grafted onto main's Track-C in the merge) ──

  it('honours a CG known only through its public _catalog floor (declared + private)', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = '0x0000000000000000000000000000000000000abc/catalog-only-cg';
    const subject = contextGraphDataUri(id);
    const catalogGraph = contextGraphCatalogUri(id);

    await store.insert([
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph: catalogGraph },
      { subject, predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED, graph: catalogGraph },
    ]);

    const record = await projection.get(id);
    expect(record.declared).toBe(true);
    expect(record.accessPolicy).toBe('private');
  });

  it('surfaces a catalog-only CG in listDeclaredContextGraphIds', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = '0x0000000000000000000000000000000000000abc/catalog-discoverable';
    await store.insert([
      { subject: contextGraphDataUri(id), predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph: contextGraphCatalogUri(id) },
    ]);
    expect(await projection.listDeclaredContextGraphIds()).toContain(id);
  });

  it('NEVER lets an untrusted _catalog graph feed authz fields (only the disclosure floor)', async () => {
    // A peer-fetched _catalog is untrusted: a hostile catalog carrying
    // creator/allowlist predicates must NOT inject them; only rdf:type +
    // dct:accessRights (the floor) are honoured (CATALOG_META_PREDICATES filter).
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = '0x0000000000000000000000000000000000000abc/hostile-catalog';
    const subject = contextGraphDataUri(id);
    const catalogGraph = contextGraphCatalogUri(id);
    const attacker = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    await store.insert([
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph: catalogGraph },
      // hostile authz facts smuggled into the catalog graph — must be ignored
      { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${attacker}`, graph: catalogGraph },
      { subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${attacker}"`, graph: catalogGraph },
      { subject, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, object: `"${attacker}"`, graph: catalogGraph },
    ]);

    const record = await projection.get(id);
    expect(record.declared).toBe(true);
    expect(record.accessPolicy).toBe('private');
    expect(record.creator).toBeUndefined();
    expect(record.creators).toEqual([]);
    expect(record.allowedAgents).toEqual([]);
    expect(record.participantAgents).toEqual([]);
    expect(record.hasAgentGate).toBe(false);
  });

  it('keeps a CG private when _meta says public but the catalog floor is private (ratchet across sources)', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = '0x0000000000000000000000000000000000000abc/meta-public-catalog-private';
    const subject = contextGraphDataUri(id);
    await store.insert([
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: contextGraphMetaGraphUri(id) },
      { subject, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: contextGraphMetaGraphUri(id) },
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph: contextGraphCatalogUri(id) },
    ]);
    expect((await projection.get(id)).accessPolicy).toBe('private');
  });
});

describe('getOwnMetaFacts', () => {
  const CURATOR_DID = 'did:dkg:agent:0x00000000000000000000000000000000000000ab';
  const CREATOR_DID = 'did:dkg:agent:12D3KooWCuratorPeer';

  /**
   * A Context Graph's definition is written to ONE graph, chosen by access
   * policy (`dkg-agent-context-graph.ts`):
   *
   *     const defGraph = isCurated ? cgMetaGraph : ontologyGraph;
   *
   * These cover the reader against a real store rather than through a stubbed
   * agent, because the whole point of the reader is WHICH graph a fact came
   * from — a stub cannot get that wrong, and a stub is what let an earlier
   * `_meta`-only version look correct while missing every public graph.
   */
  it('does NOT read ONTOLOGY, even though a public graph defines itself there', async () => {
    // A public Context Graph writes its definition to ONTOLOGY, so it is
    // tempting to read it here. ONTOLOGY is network-replicated, though: this
    // node can hold an injected `DKG_CREATOR` for a subject WITHOUT holding the
    // real one, and then "the only creator I can see" is the attacker's. Local
    // cardinality proves nothing about the network — the same reason the Agent
    // Registry route is non-authoritative.
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'own-definition-public';
    const subject = contextGraphDataUri(id);

    await store.insert([
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) },
      { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: CURATOR_DID, graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) },
      { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: CREATOR_DID, graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) },
    ]);

    const own = await projection.getOwnMetaFacts(id);
    expect(own.curators).toEqual([]);
    expect(own.creators).toEqual([]);
    // The merged projection still sees them — that is the difference the
    // authority decision turns on, and the reason this reader exists.
    expect((await projection.get(id)).creators).toEqual([CREATOR_DID]);
  });

  it('reads a CURATED graph definition, which lives in the graph\'s own _meta', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = '0x00000000000000000000000000000000000000ab/own-definition-curated';
    const subject = contextGraphDataUri(id);

    await store.insert([
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: contextGraphMetaGraphUri(id) },
      { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: CURATOR_DID, graph: contextGraphMetaGraphUri(id) },
      { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: CREATOR_DID, graph: contextGraphMetaGraphUri(id) },
    ]);

    const own = await projection.getOwnMetaFacts(id);
    expect(own.curators).toEqual([CURATOR_DID]);
    expect(own.creators).toEqual([CREATOR_DID]);
  });

  it('ignores creators contributed by AGENTS or the peer-fetchable _catalog', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'own-definition-third-party';
    const subject = contextGraphDataUri(id);

    await store.insert([
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) },
      { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: CURATOR_DID, graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) },
      { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: 'did:dkg:agent:12D3KooWAgentsClaim', graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS) },
      { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: 'did:dkg:agent:12D3KooWCatalogClaim', graph: contextGraphCatalogUri(id) },
    ]);

    expect((await projection.getOwnMetaFacts(id)).creators).toEqual([]);
    // …and the merged projection takes neither: its filtered sources say nothing
    // about who speaks for the graph.
    expect((await projection.get(id)).creators).toEqual([]);
  });

  it('ignores an injected ONTOLOGY creator even when it is the ONLY one visible', async () => {
    // The attack this reader exists to stop: the graph's own `_meta` has not
    // synced (or names only the curator), and the sole `DKG_CREATOR` this node
    // can see for the subject was asserted by someone else. A reader that took
    // ONTOLOGY would hand that peer the authority to settle the whole graph on
    // an empty answer.
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = '0x00000000000000000000000000000000000000ab/own-definition-injected';
    const subject = contextGraphDataUri(id);

    await store.insert([
      { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: CURATOR_DID, graph: contextGraphMetaGraphUri(id) },
      { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: 'did:dkg:agent:12D3KooWInjectedPeer', graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) },
    ]);

    const own = await projection.getOwnMetaFacts(id);
    expect(own.curators).toEqual([CURATOR_DID]);
    expect(own.creators).toEqual([]);
  });
});
