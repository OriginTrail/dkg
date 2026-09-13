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
  parseContextGraphStorageUri,
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

describe('parseContextGraphStorageUri', () => {
  it.each(ROOTS)('retains root %s through every supported storage constructor', (id) => {
    for (const [label, build] of STORAGE_BUILDERS) {
      const uri = build(id);
      const parsed = parseContextGraphStorageUri(uri);
      expect(parsed?.ownerContextGraphIds, `${label}: ${uri}`).toContain(id);
      expect(parsed?.ownerContextGraphIds.every((owner) => validateContextGraphId(owner).valid)).toBe(true);
    }
  });

  it('retains a reserved-suffix legacy root without requiring metadata facts', () => {
    expect(validateContextGraphId('tenant/_meta').valid).toBe(true);
    expect(validateNewContextGraphId('tenant/_meta').valid).toBe(false);
    const parsed = parseContextGraphStorageUri(contextGraphDataUri('tenant/_meta'));
    expect(parsed?.ownerContextGraphIds).toEqual(expect.arrayContaining(['tenant/_meta', 'tenant']));
    expect(parsed?.shapes).toEqual(expect.arrayContaining([
      { kind: 'bare', scope: 'tenant/_meta' },
      { kind: 'partition', scope: 'tenant', partition: '_meta' },
    ]));
  });

  it('examines every adjacent reserved segment, including ones inside a legacy root', () => {
    const uri = contextGraphMetaUri('tenant/_old/_private');
    const parsed = parseContextGraphStorageUri(uri);
    expect(parsed?.ownerContextGraphIds).toEqual(expect.arrayContaining([
      'tenant/_old/_private/_meta',
      'tenant/_old/_private',
      'tenant/_old',
      'tenant',
    ]));
    expect(parsed?.shapes.filter((shape) => shape.kind === 'partition')).toEqual([
      { kind: 'partition', scope: 'tenant', partition: '_old' },
      { kind: 'partition', scope: 'tenant/_old', partition: '_private' },
      { kind: 'partition', scope: 'tenant/_old/_private', partition: '_meta' },
    ]);
  });

  it('retains all root, named-subgraph and metadata interpretations of public/tasks/_meta', () => {
    const parsed = parseContextGraphStorageUri(contextGraphSubGraphMetaUri('public', 'tasks'));
    expect(parsed?.ownerContextGraphIds).toEqual(expect.arrayContaining([
      'public/tasks/_meta', 'public/tasks', 'public',
    ]));
  });

  it('retains both a slash root and its legal wallet parent for memory partitions', () => {
    const parsed = parseContextGraphStorageUri(contextGraphLayerUri(`${AUTHOR}/project`, MemoryLayer.VerifiableMemory, AUTHOR, 1));
    expect(parsed?.ownerContextGraphIds).toEqual(expect.arrayContaining([`${AUTHOR}/project`, AUTHOR]));
  });

  it('preserves the exact context scope and a colliding bare root', () => {
    const parsed = parseContextGraphStorageUri(contextGraphDataUri('team/repo', '7'));
    expect(parsed?.ownerContextGraphIds).toEqual(expect.arrayContaining(['team/repo', 'team/repo/context/7']));
    expect(parsed?.shapes).toContainEqual({ kind: 'context', scope: 'team/repo', contextId: '7' });
  });

  it('uses the rightmost context delimiter when the legacy root itself contains context', () => {
    const parsed = parseContextGraphStorageUri(contextGraphMetaUri('team/context/old', '7'));
    expect(parsed?.shapes).toContainEqual({ kind: 'context', scope: 'team/context/old', contextId: '7' });
  });

  it('reuses the unsplit legacy assertion coordinate and its optional named parent', () => {
    const parsed = parseContextGraphStorageUri(contextGraphAssertionUri('team/repo', AUTHOR, 'fact', 'reports'));
    expect(parsed?.shapes).toContainEqual({ kind: 'assertion', scope: 'team/repo/reports' });
    expect(parsed?.ownerContextGraphIds).toEqual(expect.arrayContaining(['team/repo/reports', 'team/repo']));
  });

  it.each([null, 'reports'])('decodes the exact RFC-64 owner for subgraph %s and retains legal raw interpretations', (subGraphName) => {
    const id = 'team/repo/private';
    const scope = buildCatalogAssertionScopeV1({ contextGraphId: id, subGraphName } as CatalogLaneV1);
    const parsed = parseContextGraphStorageUri(contextGraphLayerUri(scope, MemoryLayer.SharedWorkingMemory, AUTHOR, 1));
    expect(parsed?.ownerContextGraphIds).toContain(id);
    expect(parsed?.shapes).toContainEqual({
      kind: 'encoded',
      contextGraphId: id,
      ...(subGraphName === null ? {} : { subGraphName }),
    });
    if (subGraphName === null) {
      // '%' is valid in a flat subgraph name even though it is forbidden in CG IDs.
      expect(parsed?.ownerContextGraphIds).toContain('v1/root');
    }
  });

  it('retains raw legacy v1/root/private alongside the decoded owner private', () => {
    const parsed = parseContextGraphStorageUri(contextGraphLayerUri('v1/root/private', MemoryLayer.SharedWorkingMemory, AUTHOR, 1));
    expect(parsed?.ownerContextGraphIds).toEqual(expect.arrayContaining(['private', 'v1/root/private', 'v1/root']));
  });

  it.each([
    `${PREFIX}v1/root/private%ZZ/_meta`,
    `${PREFIX}v1/subgraph/private/reports%ZZ/_shared_memory`,
    `${PREFIX}v1/root/%FF/_shared_memory`,
  ])('fails closed for malformed encoded owner scope %s', (uri) => {
    expect(() => parseContextGraphStorageUri(uri)).toThrow();
  });

  it('validates a legal parent independently when adding a subgraph exceeds the CG length limit', () => {
    const root = 'a'.repeat(256);
    const parsed = parseContextGraphStorageUri(contextGraphSubGraphUri(root, 'reports'));
    expect(parsed?.ownerContextGraphIds).toEqual([root]);
  });

  it('returns immutable, deduplicated owners', () => {
    const parsed = parseContextGraphStorageUri(contextGraphMetaUri('tenant'))!;
    expect(new Set(parsed.ownerContextGraphIds).size).toBe(parsed.ownerContextGraphIds.length);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.shapes)).toBe(true);
    expect(Object.isFrozen(parsed.ownerContextGraphIds)).toBe(true);
  });

  it.each(['urn:other:graph', PREFIX, `<${PREFIX}tenant>`])('does not parse unsupported URI %s', (uri) => {
    expect(parseContextGraphStorageUri(uri)).toBeUndefined();
  });
});
