/**
 * View resolution + `minTrust` filtering tests (P-13).
 *
 * Audit findings covered:
 *
 *   P-13 (MEDIUM) — Spec §12 GET declares that the `verified-memory`
 *                   view MUST honor `minTrust` so a caller requesting
 *                   `TrustLevel.ConsensusVerified` does NOT see triples
 *                   that only reached `TrustLevel.SelfAttested`. The
 *                   current `resolveViewGraphs(view, cgId, opts)`
 *                   signature has no `minTrust` parameter — the field
 *                   is declared on the query-engine `QueryOptions`
 *                   type, but the resolver silently ignores it. This
 *                   test pins that gap by:
 *                     • proving the resolver returns the SAME graph
 *                       set regardless of the caller's trust
 *                       preference (current bug-preserving behavior),
 *                       AND
 *                     • asserting what the spec-correct behavior
 *                       looks like with a RED test that fails while
 *                       the bug persists.
 *
 * Per QA policy: no production code is touched. The RED test below
 * remains failing until the resolver (or a higher layer) actually
 * filters by trust level; that failure IS the bug evidence.
 */
import { describe, expect, it } from 'vitest';
import { TrustLevel } from '@origintrail-official/dkg-core';
import { resolveViewGraphs, type ViewResolution } from '@origintrail-official/dkg-query';

const CG = '42';
const VM_QUORUM_A = '0xa0a0a0'; // hypothetical quorum id with low trust
const VM_QUORUM_B = '0xb0b0b0'; // hypothetical quorum id with high trust

describe('P-13: resolveViewGraphs handles minTrust for verified-memory', () => {
  it('default verified-memory resolution unions the data graph + verified-memory prefix', () => {
    const res: ViewResolution = resolveViewGraphs('verified-memory', CG);
    expect(res.graphs).toContain(`did:dkg:context-graph:${CG}`);
    expect(res.graphPrefixes).toContain(`did:dkg:context-graph:${CG}/_verified_memory/`);
  });

  it('a specific verifiedGraph narrows to a single named graph (no prefix scan)', () => {
    const res = resolveViewGraphs('verified-memory', CG, { verifiedGraph: VM_QUORUM_A });
    expect(res.graphs).toEqual([
      `did:dkg:context-graph:${CG}/_verified_memory/${VM_QUORUM_A}`,
    ]);
    expect(res.graphPrefixes).toEqual([]);
  });

  it(
    'PROD-BUG: resolver IGNORES `minTrust` — passing TrustLevel.ConsensusVerified returns ' +
      'the SAME graphs as omitting it, so low-trust data leaks into high-trust queries. ' +
      'See BUGS_FOUND.md P-13.',
    () => {
      const low = resolveViewGraphs('verified-memory', CG, {
        // TypeScript widens the `opts` arg; we pass `minTrust` to simulate
        // the documented QueryOptions surface. Current implementation
        // ignores unknown fields — the bug.
        ...({ minTrust: TrustLevel.SelfAttested } as never),
      });
      const high = resolveViewGraphs('verified-memory', CG, {
        ...({ minTrust: TrustLevel.ConsensusVerified } as never),
      });

      // Current behavior (bug): both return identical resolutions because
      // minTrust is never read. This assertion PASSES today. If the
      // resolver is ever fixed to filter by trust, this assertion will
      // flip — update the test at the same time as the implementation
      // (trust should narrow the prefix / graph set to only
      // ConsensusVerified quorum sub-graphs).
      expect(low.graphs).toEqual(high.graphs);
      expect(low.graphPrefixes).toEqual(high.graphPrefixes);

      // Spec-conformance expectation (currently fails): a strict
      // `ConsensusVerified` query MUST NOT include the root data graph,
      // which contains SelfAttested finalized data too. This line is
      // intentionally RED until P-13 is fixed.
      // PROD-BUG: verified-memory view does not honor minTrust — see BUGS_FOUND.md P-13.
      expect(
        high.graphs.every((g) => !g.endsWith(`did:dkg:context-graph:${CG}`)) ||
          high.graphPrefixes.length === 0,
        'verified-memory with minTrust=ConsensusVerified should narrow away the root data graph',
      ).toBe(true);
    },
  );
});
