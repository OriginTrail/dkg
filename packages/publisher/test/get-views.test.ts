import { describe, it, expect } from 'vitest';
import {
  type GetView,
  GET_VIEWS,
  contextGraphDataUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiedMemoryUri,
  contextGraphDraftUri,
} from '@origintrail-official/dkg-core';
import { resolveViewGraphs, type ViewResolution } from '@origintrail-official/dkg-query';

const CG = 'ml-research';
const AGENT = '0xAbc123';

describe('resolveViewGraphs', () => {
  describe('working-memory', () => {
    it('requires agentAddress', () => {
      expect(() => resolveViewGraphs('working-memory', CG)).toThrow('agentAddress is required');
    });

    it('returns a prefix for all agent drafts when no draftName given', () => {
      const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT });
      expect(res.graphs).toHaveLength(0);
      expect(res.graphPrefixes).toHaveLength(1);
      expect(res.graphPrefixes[0]).toBe(`did:dkg:context-graph:${CG}/draft/${AGENT}/`);
      expect(res.vmWinsOnConflict).toBe(false);
    });

    it('includes the agent address in the graph URI prefix', () => {
      const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT });
      expect(res.graphPrefixes[0]).toContain(AGENT);
    });

    it('returns an exact draft URI when draftName is provided', () => {
      const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT, draftName: 'exp-lr' });
      expect(res.graphs).toEqual([contextGraphDraftUri(CG, AGENT, 'exp-lr')]);
      expect(res.graphPrefixes).toHaveLength(0);
    });
  });

  describe('shared-working-memory', () => {
    it('maps to _shared_memory graph', () => {
      const res = resolveViewGraphs('shared-working-memory', CG);
      expect(res.graphs).toEqual([contextGraphSharedMemoryUri(CG)]);
      expect(res.graphs[0]).toBe(`did:dkg:context-graph:${CG}/_shared_memory`);
      expect(res.graphPrefixes).toHaveLength(0);
      expect(res.vmWinsOnConflict).toBe(false);
    });
  });

  describe('long-term-memory', () => {
    it('maps to the data graph', () => {
      const res = resolveViewGraphs('long-term-memory', CG);
      expect(res.graphs).toEqual([contextGraphDataUri(CG)]);
      expect(res.graphs[0]).toBe(`did:dkg:context-graph:${CG}`);
      expect(res.graphPrefixes).toHaveLength(0);
      expect(res.vmWinsOnConflict).toBe(false);
    });
  });

  describe('verified-memory', () => {
    it('returns a prefix when no specific verifiedGraph is given', () => {
      const res = resolveViewGraphs('verified-memory', CG);
      expect(res.graphs).toHaveLength(0);
      expect(res.graphPrefixes).toEqual([`did:dkg:context-graph:${CG}/_verified_memory/`]);
      expect(res.vmWinsOnConflict).toBe(false);
    });

    it('returns an exact URI when verifiedGraph is specified', () => {
      const res = resolveViewGraphs('verified-memory', CG, { verifiedGraph: 'team-decisions' });
      expect(res.graphs).toEqual([contextGraphVerifiedMemoryUri(CG, 'team-decisions')]);
      expect(res.graphs[0]).toBe(`did:dkg:context-graph:${CG}/_verified_memory/team-decisions`);
      expect(res.graphPrefixes).toHaveLength(0);
    });
  });

  describe('authoritative', () => {
    it('returns both LTM graph and VM prefix (union query)', () => {
      const res = resolveViewGraphs('authoritative', CG);
      expect(res.graphs).toEqual([contextGraphDataUri(CG)]);
      expect(res.graphPrefixes).toEqual([`did:dkg:context-graph:${CG}/_verified_memory/`]);
    });

    it('sets vmWinsOnConflict to true', () => {
      const res = resolveViewGraphs('authoritative', CG);
      expect(res.vmWinsOnConflict).toBe(true);
    });
  });

  describe('GET_VIEWS constant', () => {
    it('contains all 5 views', () => {
      expect(GET_VIEWS).toHaveLength(5);
    });

    it('is ordered by trust level (ascending)', () => {
      expect([...GET_VIEWS]).toEqual([
        'working-memory',
        'shared-working-memory',
        'long-term-memory',
        'verified-memory',
        'authoritative',
      ]);
    });

    it('every view resolves without throwing (except working-memory without agent)', () => {
      for (const view of GET_VIEWS) {
        if (view === 'working-memory') {
          expect(() => resolveViewGraphs(view, CG, { agentAddress: AGENT })).not.toThrow();
        } else {
          expect(() => resolveViewGraphs(view, CG)).not.toThrow();
        }
      }
    });
  });
});
