/**
 * ST-1 — adapter-parity misleading-name evidence.
 *
 * See .test-audit/BUGS_FOUND.md "packages/storage" ST-1:
 *
 *   `adapter-parity.test.ts` looks like it verifies that OxigraphStore
 *   and BlazegraphStore agree on count / delete semantics, but the
 *   Blazegraph side is a hard-coded node:http server that returns fake
 *   COUNT responses ("2" then "1"). Whatever BlazegraphStore actually
 *   asks over the wire is never executed against a real RDF engine, so
 *   the suite would pass even if BlazegraphStore's SPARQL was totally
 *   broken. That is not "parity".
 *
 * This file does two things:
 *
 *   1. Provides a real, opt-in parity harness gated on the
 *      `BLAZEGRAPH_URL` env var. When the var is set, the same quad
 *      set is exercised against both OxigraphStore and BlazegraphStore
 *      (real HTTP endpoint) and their outputs must match. When the
 *      var is NOT set the parity cases are marked as skipped with a
 *      clear reason, and the CI job that claims to validate parity is
 *      expected to set the var (otherwise skipping == regressing).
 *
 *   2. Pins a static assertion over the existing `adapter-parity.test.ts`
 *      source so the misleading fixture (hard-coded "2"/"1" COUNT
 *      responses, absence of a real Blazegraph URL) cannot be silently
 *      re-introduced after a refactor.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { OxigraphStore, BlazegraphStore, type Quad } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXISTING_PARITY = join(HERE, 'adapter-parity.test.ts');

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_URL;

// ---------------------------------------------------------------------------
// (1) Real parity harness — skip with a loud reason when unavailable.
// ---------------------------------------------------------------------------

describe('Real Oxigraph ↔ Blazegraph parity [ST-1]', () => {
  const G = 'urn:dkg:parity:real:g';
  const quads: Quad[] = [
    { subject: 'urn:dkg:parity:s1', predicate: 'http://ex.org/p', object: '"alpha"', graph: G },
    { subject: 'urn:dkg:parity:s2', predicate: 'http://ex.org/p', object: '"beta"',  graph: G },
    { subject: 'urn:dkg:parity:s3', predicate: 'http://ex.org/p', object: '"gamma"', graph: G },
  ];

  it.runIf(!!BLAZEGRAPH_URL)(
    'countQuads, deleteByPattern, listGraphs agree across backends',
    async () => {
      const ox = new OxigraphStore();
      const blaze = new BlazegraphStore(BLAZEGRAPH_URL as string);

      try {
        // Clean slate on the Blazegraph side to avoid cross-run bleed.
        await blaze.dropGraph(G).catch(() => undefined);

        await ox.insert(quads);
        await blaze.insert(quads);

        expect(await ox.countQuads(G)).toBe(quads.length);
        expect(await blaze.countQuads(G)).toBe(quads.length);

        const removedOx = await ox.deleteByPattern({ graph: G, subject: 'urn:dkg:parity:s1' });
        const removedBlaze = await blaze.deleteByPattern({ graph: G, subject: 'urn:dkg:parity:s1' });
        expect(removedOx).toBe(removedBlaze);

        expect(await ox.countQuads(G)).toBe(await blaze.countQuads(G));
      } finally {
        await blaze.dropGraph(G).catch(() => undefined);
        await ox.close();
        await blaze.close();
      }
    },
  );

  it.runIf(!BLAZEGRAPH_URL)(
    'BLAZEGRAPH_URL not set — real parity cannot be verified (CI must set this)',
    () => {
      // This test intentionally fails red when run in any "CI parity
      // lane" that did NOT stand up a real Blazegraph and export
      // BLAZEGRAPH_URL. It documents the gap rather than silently
      // skipping.
      //
      // Previous iterations honoured a `DKG_SKIP_REAL_BLAZEGRAPH=1`
      // escape hatch that returned silently. Under the "zero false
      // positives" policy an empty-assertion green pass is itself a
      // bug-hider: CI could believe parity was validated when no
      // engine was ever contacted. The escape hatch has been removed.
      // Local devs who cannot run a real Blazegraph should either
      // install one (the README covers this) or accept the red on
      // this single test — the rest of the storage suite runs green.
      throw new Error(
        '[ST-1] Real Oxigraph↔Blazegraph parity untested: ' +
          'export BLAZEGRAPH_URL=<sparql endpoint> to enable. ' +
          'Any CI job that reports this lane green without setting ' +
          'the env var is lying about parity coverage.',
      );
    },
  );
});

// ---------------------------------------------------------------------------
// (2) Static guardrail over the existing misleading fixture.
// ---------------------------------------------------------------------------

describe('adapter-parity.test.ts is a known misleading fixture [ST-1]', () => {
  it('the file exists — regression guard so the skip below cannot be "evaded"', () => {
    expect(existsSync(EXISTING_PARITY)).toBe(true);
  });

  it('uses a hard-coded node:http stub instead of a real Blazegraph endpoint', () => {
    // PROD-TEST-BUG: the file is NAMED "adapter-parity" but the
    // Blazegraph side is a node:http test double that returns a
    // canned COUNT payload ('2' then '1'). The Oxigraph side is a
    // real in-process engine. "Parity" therefore reduces to
    // "Oxigraph counts two quads AND our test double said 2". This
    // assertion pins those two giveaways so the suite name cannot
    // drift further from what it tests. Until the suite is rewritten
    // to talk to a real engine (see the first describe block in this
    // file), the misleading name is the bug.
    const src = readFileSync(EXISTING_PARITY, 'utf-8');
    expect(src).toMatch(/createServer/);
    expect(src).toMatch(/COUNT\(\*\)/);
    // The canned response table.
    expect(src).toMatch(/queryCount <= 1 \? '2' : '1'/);
    // There is no reference to the env-gated live endpoint.
    expect(src).not.toMatch(/BLAZEGRAPH_URL/);
  });

  it('reminder: when BLAZEGRAPH_URL is available this file provides the REAL parity check', () => {
    // Not an assertion about production code — it's a pointer to the
    // correct lane above so future readers don't "fix" the ST-1 finding
    // by deleting it.
    expect(typeof BLAZEGRAPH_URL === 'string' || BLAZEGRAPH_URL === undefined).toBe(true);
  });
});
