import { describe, expect, it } from 'vitest';
import {
  contextGraphAssertionUri,
  contextGraphCatalogUri,
  contextGraphDataUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphRulesUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphSharedMemoryUri,
  contextGraphSubGraphMetaUri,
  contextGraphSubGraphPrivateUri,
  contextGraphSubGraphUri,
  contextGraphVerifiableMemoryMetaUri,
  validateContextGraphId,
  validateNewContextGraphId,
} from '../src/constants.js';
import { MemoryLayer } from '../src/memory-model.js';
import { assertionScopedGraphUri } from '../src/assertion-scoped-graphs.js';
import {
  workspaceKnowledgeAssetOperationSnapshotGraph,
  workspaceOperationPublicSnapshotGraph,
} from '../src/context-graph-snapshot-uri.js';
import {
  buildCatalogAssertionScopeV1,
  type CatalogLaneV1,
} from '../src/author-catalog-codec.js';
import {
  contextGraphStorageOwnerCandidates,
  parseContextGraphUri,
} from '../src/context-graph-storage-uri.js';

const PREFIX = 'did:dkg:context-graph:';
const AUTHOR = '0x0000000000000000000000000000000000000001';
const ROOTS = ['plain', 'team/repo/private', `${AUTHOR}/project`, 'tenant/_meta', 'team/_old/private'];

const STORAGE_BUILDERS: Array<[string, (id: string) => string]> = [
  ['bare data', (id) => contextGraphDataUri(id)],
  ['context data', (id) => contextGraphDataUri(id, '7')],
  ['context metadata', (id) => contextGraphMetaUri(id, '7')],
  ['metadata', contextGraphMetaUri],
  ['private', contextGraphPrivateUri],
  ['catalog', contextGraphCatalogUri],
  ['rules', contextGraphRulesUri],
  ['SWM bucket', contextGraphSharedMemoryUri],
  ['SWM metadata', contextGraphSharedMemoryMetaUri],
  ['VM asset metadata', (id) => contextGraphVerifiableMemoryMetaUri(id, `${AUTHOR}/1`)],
  ['named data', (id) => contextGraphSubGraphUri(id, 'reports')],
  ['named metadata', (id) => contextGraphSubGraphMetaUri(id, 'reports')],
  ['named private', (id) => contextGraphSubGraphPrivateUri(id, 'reports')],
  ['named SWM bucket', (id) => contextGraphSharedMemoryUri(id, 'reports')],
  ['legacy assertion coordinate', (id) => contextGraphAssertionUri(id, AUTHOR, 'fact')],
  ['named assertion coordinate', (id) => contextGraphAssertionUri(id, AUTHOR, 'fact', 'reports')],
  ...Object.values(MemoryLayer).flatMap((layer): Array<[string, (id: string) => string]> => [
    [`${layer} asset`, (id) => contextGraphLayerUri(id, layer, AUTHOR, 1)],
    [`named ${layer} asset`, (id) => contextGraphLayerUri(id, layer, AUTHOR, 1, 'reports')],
  ]),
];

describe('parseContextGraphUri', () => {
  it.each(ROOTS)('preserves exact valid legacy ID %s', (id) => {
    expect(parseContextGraphUri(contextGraphDataUri(id))).toBe(id);
  });

  it.each([
    'urn:unrelated:graph',
    PREFIX,
    `<${PREFIX}plain>`,
    ` ${PREFIX}plain`,
    `${PREFIX}plain `,
    `${PREFIX}a/../b`,
    `${PREFIX}${'a'.repeat(257)}`,
    `${PREFIX}team%2Frepo`,
  ])('rejects non-exact or invalid CG URI %s', (uri) => {
    expect(parseContextGraphUri(uri)).toBeUndefined();
  });
});

describe('contextGraphStorageOwnerCandidates', () => {
  it.each(ROOTS)('retains root %s through every supported storage constructor', (id) => {
    for (const [label, build] of STORAGE_BUILDERS) {
      const uri = build(id);
      const owners = contextGraphStorageOwnerCandidates(uri);
      expect(owners, `${label}: ${uri}`).toContain(id);
      expect(owners?.every((owner) => validateContextGraphId(owner).valid)).toBe(true);
    }
  });

  it('retains a reserved-suffix legacy root without requiring metadata facts', () => {
    expect(validateContextGraphId('tenant/_meta').valid).toBe(true);
    expect(validateNewContextGraphId('tenant/_meta').valid).toBe(false);
    expect(contextGraphStorageOwnerCandidates(contextGraphDataUri('tenant/_meta')))
      .toEqual(expect.arrayContaining(['tenant/_meta', 'tenant']));
  });

  it('examines every adjacent reserved segment, including ones inside a legacy root', () => {
    expect(contextGraphStorageOwnerCandidates(contextGraphMetaUri('tenant/_old/_private')))
      .toEqual(expect.arrayContaining([
        'tenant/_old/_private/_meta', 'tenant/_old/_private', 'tenant/_old', 'tenant',
      ]));
  });

  it('retains all root, named-subgraph and metadata interpretations of public/tasks/_meta', () => {
    expect(contextGraphStorageOwnerCandidates(contextGraphSubGraphMetaUri('public', 'tasks')))
      .toEqual(expect.arrayContaining(['public/tasks/_meta', 'public/tasks', 'public']));
  });

  it('retains both a slash root and its legal wallet parent for memory partitions', () => {
    const uri = contextGraphLayerUri(`${AUTHOR}/project`, MemoryLayer.VerifiableMemory, AUTHOR, 1);
    expect(contextGraphStorageOwnerCandidates(uri))
      .toEqual(expect.arrayContaining([`${AUTHOR}/project`, AUTHOR]));
  });

  it('preserves the exact context scope and a colliding bare root', () => {
    expect(contextGraphStorageOwnerCandidates(contextGraphDataUri('team/repo', '7')))
      .toEqual(expect.arrayContaining(['team/repo', 'team/repo/context/7']));
  });

  it('uses the rightmost context delimiter when the legacy root itself contains context', () => {
    expect(contextGraphStorageOwnerCandidates(contextGraphMetaUri('team/context/old', '7')))
      .toContain('team/context/old');
  });

  it('reuses the unsplit legacy assertion coordinate and its optional named parent', () => {
    const uri = contextGraphAssertionUri('team/repo', AUTHOR, 'fact', 'reports');
    expect(contextGraphStorageOwnerCandidates(uri))
      .toEqual(expect.arrayContaining(['team/repo/reports', 'team/repo']));
  });

  it.each([
    { label: 'root assertion', subGraphName: undefined, child: false },
    { label: 'named-subgraph assertion', subGraphName: 'reports', child: false },
    { label: 'root assertion named child', subGraphName: undefined, child: true },
    { label: 'named-subgraph assertion named child', subGraphName: 'reports', child: true },
  ])('recovers the private owner of a peer-ID $label', ({ subGraphName, child }) => {
    const id = 'team/private';
    const assertion = contextGraphAssertionUri(id, '12D3KooWLegacyPeer', 'draft', subGraphName);
    const graph = child ? assertionScopedGraphUri(assertion, 'urn:legacy:named-graph') : assertion;
    const owners = contextGraphStorageOwnerCandidates(graph);

    expect(owners).toContain(id);
    if (subGraphName) expect(owners).toContain(`${id}/${subGraphName}`);
    // The assertion-shaped path can also be a separately registered legacy CG.
    expect(owners).toContain(assertion.slice(PREFIX.length));
  });

  it.each([undefined, 'reports'])('retains a peer-ID assertion owner before a legacy child partition for %s', (subGraphName) => {
    const id = 'team/private';
    const assertion = contextGraphAssertionUri(id, '12D3KooWLegacyPeer', 'draft', subGraphName);
    // Historical underscore partitions remain legal independently of the exact
    // base64url codec used by the current named-child constructor.
    const graph = `${assertion}/_named_graph/urn%3Aexample%3Anamed`;
    const owners = contextGraphStorageOwnerCandidates(graph);

    expect(owners).toContain(id);
    if (subGraphName) expect(owners).toContain(`${id}/${subGraphName}`);
    expect(owners).toContain(assertion.slice(PREFIX.length));
  });

  const peerAssertion = 'team/private/reports/assertion/12D3KooWLegacyPeer/draft';
  it.each([
    {
      label: 'raw slash scope',
      uri: contextGraphDataUri('team/private'),
      owners: ['team', 'team/private'],
    },
    {
      label: 'adjacent partitions',
      uri: contextGraphMetaUri('tenant/_old/_private'),
      owners: ['tenant', 'tenant/_old', 'tenant/_old/_private', 'tenant/_old/_private/_meta'],
    },
    {
      label: 'context data',
      uri: contextGraphDataUri('team/context/old', '7'),
      owners: ['team/context/old', 'team/context/old/context', 'team/context/old/context/7'],
    },
    {
      label: 'context metadata',
      uri: contextGraphMetaUri('team/context/old', '7'),
      owners: [
        'team/context/old', 'team/context/old/context',
        'team/context/old/context/7', 'team/context/old/context/7/_meta',
      ],
    },
    {
      label: 'assertion scope',
      uri: `${PREFIX}${peerAssertion}`,
      owners: ['team/private', 'team/private/reports', peerAssertion],
    },
    {
      label: 'canonical assertion child',
      uri: assertionScopedGraphUri(`${PREFIX}${peerAssertion}`, 'urn:graph'),
      owners: [
        'team/private', 'team/private/reports', peerAssertion,
        `${peerAssertion}/_named_graph`, `${peerAssertion}/_named_graph/dXJuOmdyYXBo`,
      ],
    },
    {
      label: 'legacy assertion child',
      uri: `${PREFIX}${peerAssertion}/_named_graph/urn%3Aexample%3Anamed`,
      owners: [
        'team/private', 'team/private/reports', peerAssertion, `${peerAssertion}/_named_graph`,
      ],
    },
    {
      label: 'exact tagged catalog scope',
      uri: contextGraphSharedMemoryUri(buildCatalogAssertionScopeV1({
        contextGraphId: 'team/private', subGraphName: null,
      } as CatalogLaneV1)),
      owners: ['team/private', 'v1/root'],
    },
    {
      label: 'malformed tagged scope with valid legacy parent',
      uri: contextGraphSharedMemoryUri('v1/root', 'reports%FF'),
      owners: ['v1/root'],
    },
    {
      label: 'exact encoded snapshot',
      uri: workspaceKnowledgeAssetOperationSnapshotGraph('team/private', 'share/operation'),
      owners: ['team/private'],
    },
  ])('preserves the complete compatibility union for $label', ({ uri, owners }) => {
    expect([...(contextGraphStorageOwnerCandidates(uri) ?? [])].sort()).toEqual([...owners].sort());
  });

  it.each([null, 'café'])('decodes the exact RFC-64 owner for subgraph %s through storage constructors', (subGraphName) => {
    const id = 'team/repo/private';
    const scope = buildCatalogAssertionScopeV1({ contextGraphId: id, subGraphName } as CatalogLaneV1);
    for (const [label, build] of STORAGE_BUILDERS) {
      const uri = build(scope);
      expect(contextGraphStorageOwnerCandidates(uri), `${label}: ${uri}`).toContain(id);
    }
    if (subGraphName === null) {
      // '%' is valid in a flat subgraph name even though it is forbidden in CG IDs.
      expect(contextGraphStorageOwnerCandidates(contextGraphSharedMemoryUri(scope))).toContain('v1/root');
    }
  });

  it('retains raw legacy v1/root/private alongside the decoded owner private', () => {
    expect(contextGraphStorageOwnerCandidates(contextGraphSharedMemoryUri('v1/root/private')))
      .toEqual(expect.arrayContaining(['private', 'v1/root/private', 'v1/root']));
  });

  it('retains a valid catalog owner without applying the distinct raw legacy grammar', () => {
    const id = 'team/../repo';
    const scope = buildCatalogAssertionScopeV1({ contextGraphId: id, subGraphName: null } as CatalogLaneV1);
    expect(validateContextGraphId(id).valid).toBe(false);
    expect(contextGraphStorageOwnerCandidates(contextGraphSharedMemoryUri(scope))).toContain(id);
  });

  it.each([
    contextGraphSubGraphUri('v1/root', 'reports%FF'),
    contextGraphSubGraphMetaUri('v1/root', 'reports%FF'),
    contextGraphSharedMemoryUri('v1/root', 'reports%FF'),
    contextGraphLayerUri('v1/root', MemoryLayer.VerifiableMemory, AUTHOR, 1, 'reports%FF'),
    `${PREFIX}v1/root/private%ZZ/_meta`,
    `${PREFIX}v1/root/%FF/_shared_memory`,
  ])('retains valid legacy ownership when a tagged interpretation is malformed: %s', (uri) => {
    expect(contextGraphStorageOwnerCandidates(uri)).toContain('v1/root');
  });

  it('recognizes the persisted snapshot from native finalized SWM retirement', () => {
    const id = '0x1111111111111111111111111111111111111111/native-wiring';
    const uri = workspaceKnowledgeAssetOperationSnapshotGraph(id, 'preexisting-finalized-twin-v1');
    expect(contextGraphStorageOwnerCandidates(uri)).toContain(id);
  });

  it('retains RFC64 owners of both encoded snapshot families', () => {
    const id = 'team/../repo';
    for (const graph of [
      workspaceKnowledgeAssetOperationSnapshotGraph(id, 'operation'),
      workspaceOperationPublicSnapshotGraph(id, 'operation', 'urn:entity:1'),
    ]) {
      expect(contextGraphStorageOwnerCandidates(graph)).toContain(id);
    }
  });

  it.each([undefined, 'reports!%FF'])('recognizes both legacy snapshot layouts for subgraph %s', (subGraphName) => {
    for (const id of ROOTS) {
      for (const uri of [
        workspaceKnowledgeAssetOperationSnapshotGraph(id, 'share/operation', subGraphName),
        workspaceOperationPublicSnapshotGraph(id, 'share/operation', 'https://example.org/entity', subGraphName),
      ]) {
        expect(contextGraphStorageOwnerCandidates(uri), uri).toContain(id);
      }
    }
  });

  it('does not discard raw legacy interpretations of a snapshot-shaped graph', () => {
    const id = 'tenant/_shared_memory_snapshots/_/operation/ka';
    expect(contextGraphStorageOwnerCandidates(contextGraphDataUri(id)))
      .toEqual(expect.arrayContaining([id, 'tenant']));
  });

  it.each([
    'team%2frepo/_shared_memory_snapshots/_/operation/ka',
    'team%2Frepo/_shared_memory_snapshots/_/operation/ka/extra',
    'team%2Frepo/_shared_memory_snapshots/_/operation',
    'team%2Frepo/_shared_memory_snapshots/reports%FF/operation/ka',
    'team%2Frepo/_shared_memory_snapshots/_/operation%ZZ/ka',
    'team%2Frepo/_shared_memory_snapshots/_/operation/root%FF/_shared_memory',
  ])('does not infer a decoded owner from an invalid snapshot shape %s', (tail) => {
    expect(contextGraphStorageOwnerCandidates(`${PREFIX}${tail}`)).toBeUndefined();
  });

  it('does not decode a noncanonical catalog component', () => {
    const owners = contextGraphStorageOwnerCandidates(`${PREFIX}v1/root/team%2frepo/_shared_memory`);
    expect(owners).toContain('v1/root');
    expect(owners).not.toContain('team/repo');
  });

  it('does not decode an arbitrary tagged prefix of an incomplete scope', () => {
    const owners = contextGraphStorageOwnerCandidates(`${PREFIX}v1/root/private/extra/tail/_shared_memory`);
    expect(owners).toContain('v1/root/private/extra/tail');
    expect(owners).not.toContain('private');
  });

  it('reports no interpretation when malformed tagged components leave no valid legacy owner', () => {
    expect(contextGraphStorageOwnerCandidates(`${PREFIX}v1/subgraph/team%2Frepo/reports%FF/_shared_memory`))
      .toBeUndefined();
  });

  it('validates a legal parent independently when adding a subgraph exceeds the CG length limit', () => {
    const root = 'a'.repeat(256);
    expect(contextGraphStorageOwnerCandidates(contextGraphSubGraphUri(root, 'reports'))).toEqual([root]);
  });

  it('returns immutable, deduplicated owners', () => {
    const owners = contextGraphStorageOwnerCandidates(contextGraphMetaUri('tenant'))!;
    expect(new Set(owners).size).toBe(owners.length);
    expect(Object.isFrozen(owners)).toBe(true);
  });

  it.each(['urn:other:graph', PREFIX, `<${PREFIX}tenant>`])('does not parse unsupported URI %s', (uri) => {
    expect(contextGraphStorageOwnerCandidates(uri)).toBeUndefined();
  });
});
