import { describe, expect, it } from 'vitest';
import {
  parseWorkspaceSnapshotContextGraphId,
  workspaceKnowledgeAssetOperationSnapshotGraph,
  workspaceOperationPublicSnapshotGraph,
} from '../src/context-graph-snapshot-uri.js';

const PREFIX = 'did:dkg:context-graph:';

describe('legacy workspace snapshot graph coordinates', () => {
  it('pins the existing complete-KA snapshot output byte for byte', () => {
    expect(workspaceKnowledgeAssetOperationSnapshotGraph('team/repo', 'share/operation'))
      .toBe(`${PREFIX}team%2Frepo/_shared_memory_snapshots/_/share%2Foperation/ka`);
  });

  it('pins the existing entity snapshot output and distinct legacy percent encoder', () => {
    expect(workspaceOperationPublicSnapshotGraph('team/repo', 'share/operation', 'https://example.org/entity', 'reports!%FF'))
      .toBe(`${PREFIX}team%2Frepo/_shared_memory_snapshots/reports!%25FF/share%2Foperation/https%3A%2F%2Fexample.org%2Fentity/_shared_memory`);
  });

  it.each([undefined, 'reports!', 'reports%FF'])('round-trips both snapshot constructors for subgraph %s', (subGraphName) => {
    for (const contextGraphId of ['plain', 'team/repo', 'tenant/_meta', 'a'.repeat(256)]) {
      const kaGraph = workspaceKnowledgeAssetOperationSnapshotGraph(contextGraphId, 'operation', subGraphName);
      const entityGraph = workspaceOperationPublicSnapshotGraph(contextGraphId, 'operation', 'urn:entity:1', subGraphName);
      expect(parseWorkspaceSnapshotContextGraphId(kaGraph)).toBe(contextGraphId);
      expect(parseWorkspaceSnapshotContextGraphId(entityGraph)).toBe(contextGraphId);
    }
  });

  it.each([
    { operation: '', root: '', subgraph: '' },
    { operation: 'operation', root: 'urn:entity:1', subgraph: '_meta' },
    { operation: 'operation?!', root: 'root/entity', subgraph: 'reports/daily' },
  ])('preserves the unchanged builders\' payload-coordinate contract: %s', ({ operation, root, subgraph }) => {
    const contextGraphId = 'team/repo';
    expect(parseWorkspaceSnapshotContextGraphId(
      workspaceKnowledgeAssetOperationSnapshotGraph(contextGraphId, operation, subgraph),
    )).toBe(contextGraphId);
    expect(parseWorkspaceSnapshotContextGraphId(
      workspaceOperationPublicSnapshotGraph(contextGraphId, operation, root, subgraph),
    )).toBe(contextGraphId);
  });

  it.each([
    'urn:other:graph',
    `${PREFIX}team%2Frepo/_shared_memory_snapshots/_/operation/ka/extra`,
    `${PREFIX}team%2Frepo/_shared_memory_snapshots/_/operation/entity`,
    `${PREFIX}team%2Frepo/_shared_memory_snapshots/_/operation/entity/_shared_memory/extra`,
    `${PREFIX}team%2frepo/_shared_memory_snapshots/_/operation/ka`,
    `${PREFIX}%74eam/_shared_memory_snapshots/_/operation/ka`,
    `${PREFIX}%FF/_shared_memory_snapshots/_/operation/ka`,
    `${PREFIX}team%2F..%2Frepo/_shared_memory_snapshots/_/operation/ka`,
    `${PREFIX}team%2Frepo/_shared_memory_snapshots/reports%FF/operation/ka`,
    `${PREFIX}team%2Frepo/_shared_memory_snapshots/_/operation%ZZ/ka`,
    `${PREFIX}team%2Frepo/_shared_memory_snapshots/_/operation/root%FF/_shared_memory`,
  ])('rejects incomplete or noncanonical snapshot coordinate %s', (uri) => {
    expect(parseWorkspaceSnapshotContextGraphId(uri)).toBeUndefined();
  });
});
