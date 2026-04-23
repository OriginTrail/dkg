/**
 * View resolution + `minTrust` filtering tests (P-13).
 *
 * Audit finding covered:
 *
 *   P-13 (MEDIUM) — Spec §12 GET declares that the `verified-memory`
 *                   view MUST honor `minTrust` so a caller requesting
 *                   `TrustLevel.ConsensusVerified` does NOT see triples
 *                   that only reached `TrustLevel.SelfAttested`. The
 *                   original `resolveViewGraphs(view, cgId, opts)`
 *                   signature had no `minTrust` parameter — the field
 *                   was declared on the query-engine `QueryOptions`
 *                   type, but the resolver silently ignored it.
 *
 * Fix: `resolveViewGraphs` now accepts `minTrust`. When it is set
 * above `TrustLevel.SelfAttested`, the root data graph (which holds
 * chain-confirmed SelfAttested triples) is dropped from the resolution.
 * Only quorum-verified sub-graphs under `/_verified_memory/{quorum}`
 * survive the resolution step.
 *
 * Note: per-quad trust filtering inside the surviving sub-graphs (based
 * on a `dkg:trustLevel` predicate on each triple) is tracked as Q-1 and
 * is out of scope for this test.
 */
import { describe, expect, it } from 'vitest';
import { TrustLevel } from '@origintrail-official/dkg-core';
import { resolveViewGraphs, type ViewResolution } from '@origintrail-official/dkg-query';

const CG = '42';
const VM_QUORUM_A = '0xa0a0a0';

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

  it('minTrust=SelfAttested (or omitted) keeps the root data graph', () => {
    const omitted = resolveViewGraphs('verified-memory', CG);
    const explicit = resolveViewGraphs('verified-memory', CG, {
      minTrust: TrustLevel.SelfAttested,
    });
    expect(omitted.graphs).toEqual([`did:dkg:context-graph:${CG}`]);
    expect(explicit.graphs).toEqual(omitted.graphs);
    expect(explicit.graphPrefixes).toEqual(omitted.graphPrefixes);
  });

  it(
    'minTrust > SelfAttested drops the root data graph — prevents SelfAttested triples ' +
      'from leaking into ConsensusVerified queries (see BUGS_FOUND.md P-13).',
    () => {
      const high = resolveViewGraphs('verified-memory', CG, {
        minTrust: TrustLevel.ConsensusVerified,
      });
      // Root data graph must not be present at any trust level above SelfAttested.
      expect(high.graphs).not.toContain(`did:dkg:context-graph:${CG}`);
      expect(high.graphs).toEqual([]);
      // Quorum-verified sub-graphs are still discovered via the prefix.
      expect(high.graphPrefixes).toEqual([
        `did:dkg:context-graph:${CG}/_verified_memory/`,
      ]);
    },
  );

  it('minTrust=Endorsed already drops the root (threshold is strict >SelfAttested)', () => {
    const res = resolveViewGraphs('verified-memory', CG, {
      minTrust: TrustLevel.Endorsed,
    });
    expect(res.graphs).toEqual([]);
    expect(res.graphPrefixes).toEqual([
      `did:dkg:context-graph:${CG}/_verified_memory/`,
    ]);
  });

  it(
    'verifiedGraph + minTrust=SelfAttested is allowed — minTrust is a no-op at SelfAttested',
    () => {
      const res = resolveViewGraphs('verified-memory', CG, {
        verifiedGraph: VM_QUORUM_A,
        minTrust: TrustLevel.SelfAttested,
      });
      expect(res.graphs).toEqual([
        `did:dkg:context-graph:${CG}/_verified_memory/${VM_QUORUM_A}`,
      ]);
      expect(res.graphPrefixes).toEqual([]);
    },
  );

  it(
    'verifiedGraph + minTrust > SelfAttested REJECTS — the engine cannot yet prove a ' +
      'named sub-graph satisfies a trust threshold, so silently reading it would violate spec §14',
    () => {
      // Codex review on PR #239 flagged the original behaviour (silently
      // ignore minTrust when verifiedGraph is set) as a trust-bypass hole:
      // a caller could ask for ConsensusVerified and receive whatever
      // trust level happens to live under that exact _verified_memory URI.
      // The resolver now throws instead; callers must either drop
      // verifiedGraph (to union across the quorum-verified prefix) or
      // drop minTrust (to read the specific sub-graph verbatim).
      expect(() =>
        resolveViewGraphs('verified-memory', CG, {
          verifiedGraph: VM_QUORUM_A,
          minTrust: TrustLevel.ConsensusVerified,
        }),
      ).toThrow(/verifiedGraph cannot be combined with minTrust above SelfAttested/);
      expect(() =>
        resolveViewGraphs('verified-memory', CG, {
          verifiedGraph: VM_QUORUM_A,
          minTrust: TrustLevel.Endorsed,
        }),
      ).toThrow(/verifiedGraph cannot be combined with minTrust above SelfAttested/);
    },
  );
});
