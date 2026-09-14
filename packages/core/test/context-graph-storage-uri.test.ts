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
