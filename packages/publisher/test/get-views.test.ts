import { describe, it, expect } from 'vitest';
import {
  type GetView,
  GET_VIEWS,
  contextGraphSharedMemoryUri,
  contextGraphVerifiableMemoryUri,
  contextGraphAssertionUri,
} from '@origintrail-official/dkg-core';
import { resolveViewGraphs, type ViewResolution } from '@origintrail-official/dkg-query';

const CG = 'ml-research';
const AGENT = '0xAbc123';

describe('resolveViewGraphs', () => {
  describe('working-memory', () => {
    it('requires agentAddress', () => {
      expect(() => resolveViewGraphs('working-memory', CG)).toThrow('agentAddress is required');
    });

    it('returns a prefix for all agent assertions when no assertionName given', () => {
      const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT });
      expect(res.graphs).toHaveLength(0);
      expect(res.graphPrefixes).toHaveLength(1);
      expect(res.graphPrefixes[0]).toBe(`did:dkg:context-graph:${CG}/_working_memory/${AGENT}/`);
    });

    it('includes the agent address in the graph URI prefix', () => {
      const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT });
      expect(res.graphPrefixes[0]).toContain(AGENT);
    });

    it('returns an exact assertion URI when assertionName is provided', () => {
      const res = resolveViewGraphs('working-memory', CG, { agentAddress: AGENT, assertionName: 'exp-lr' });
      expect(res.graphs).toEqual([contextGraphAssertionUri(CG, AGENT, 'exp-lr')]);
      expect(res.graphPrefixes).toHaveLength(0);
    });
  });

  describe('shared-working-memory', () => {
    it('maps to _shared_memory graph', () => {
      const res = resolveViewGraphs('shared-working-memory', CG);
      expect(res.graphs).toEqual([contextGraphSharedMemoryUri(CG)]);
      expect(res.graphPrefixes[0]).toBe(`did:dkg:context-graph:${CG}/_shared_memory/`);
      expect(res.graphPrefixes).toHaveLength(1);
    });
  });

  describe('verifiable-memory', () => {
    it('unions the root content graph + `_verifiable_memory/` prefix when no specific verifiedGraph is given (RC11 / PR-A: Codex #671)', () => {
      const res = resolveViewGraphs('verifiable-memory', CG);
      // RC11 / PR-A (Codex review fix on #671, comment 3302058969):
      // re-includes the root content graph `did:dkg:context-graph:{id}`
      // alongside the `_verifiable_memory/*` post-`verify` named graphs.
      // The tentative-VM leak the PR2 first cut was guarding against is
      // now plugged at the publisher (root-graph insert deferred to the
      // chain-success branch in `DKGPublisher.publish`), so re-unioning
      // root in VM no longer surfaces unconfirmed quads while still
      // letting VM-publish query callers (incl. memory-search) see confirmed
      // data immediately, without needing
      // a separate `verify` step.
      expect(res.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
      expect(res.graphPrefixes).toEqual([`did:dkg:context-graph:${CG}/_verifiable_memory/`]);
    });

    it('returns an exact URI when verifiedGraph is specified', () => {
      const res = resolveViewGraphs('verifiable-memory', CG, { verifiedGraph: 'team-decisions' });
      expect(res.graphs).toEqual([contextGraphVerifiableMemoryUri(CG, 'team-decisions')]);
      expect(res.graphs[0]).toBe(`did:dkg:context-graph:${CG}/_verifiable_memory/team-decisions`);
      expect(res.graphPrefixes).toHaveLength(0);
    });
  });

  describe('regression: legacy views throw migration error', () => {
    it('long-term-memory throws', () => {
      expect(() => resolveViewGraphs('long-term-memory' as GetView, CG)).toThrow(
        /removed in V10/,
      );
    });

    it('authoritative throws', () => {
      expect(() => resolveViewGraphs('authoritative' as GetView, CG)).toThrow(
        /removed in V10/,
      );
    });
  });

  describe('GET_VIEWS constant', () => {
    it('contains all 3 views', () => {
      expect(GET_VIEWS).toHaveLength(3);
    });

    it('is ordered by trust level (ascending)', () => {
      expect([...GET_VIEWS]).toEqual([
        'working-memory',
        'shared-working-memory',
        'verifiable-memory',
      ]);
    });

    it('every view in GET_VIEWS returns a populated ViewResolution (at least one graph or prefix)', () => {
      // Previously this test only asserted `.not.toThrow()` in a loop —
      // which would pass even if resolveViewGraphs started returning
      // `{ graphs: [], graphPrefixes: [] }` (a silently-empty view that
      // would break every downstream `GET` query). Assert the positive
      // contract: each view yields at least one concrete graph URI or
      // URI prefix, and every returned URI is shaped like a DKG context
      // graph URI (starts with `did:dkg:context-graph:`). If a view
      // is accidentally wired to return an empty resolution, the test
      // will now fail at the specific view instead of silently passing.
      for (const view of GET_VIEWS) {
        const res: ViewResolution = view === 'working-memory'
          ? resolveViewGraphs(view, CG, { agentAddress: AGENT })
          : resolveViewGraphs(view, CG);

        const total = res.graphs.length + res.graphPrefixes.length;
        expect(total, `view "${view}" returned empty graphs+prefixes`).toBeGreaterThan(0);

        for (const g of res.graphs) {
          expect(g, `graph URI for "${view}" missing did:dkg prefix`).toMatch(/^did:dkg:context-graph:/);
        }
        for (const p of res.graphPrefixes) {
          expect(p, `graph prefix for "${view}" missing did:dkg prefix`).toMatch(/^did:dkg:context-graph:/);
        }
      }
    });
  });
});
