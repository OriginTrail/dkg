/**
 * Issue-liveness repro for GH #1078 — "Private payload storage is not scoped to
 * memory layer or verifiable commitment."
 * https://github.com/OriginTrail/dkg/issues/1078
 *
 * `PrivateContentStore` keys the finalized private partition only by
 * `(contextGraphId[, subGraphName])` → `…/_private`. It is NOT split by memory
 * layer / KA version the way public state is (WM/SWM/VM each get their own
 * graph). So two DISTINCT private commitments for the SAME root — e.g. a stale
 * draft slice and the slice the verifiable KA actually committed — land in ONE
 * graph and `getPrivateTriples(cg, root)` returns BOTH. A caller that follows a
 * `dkg:privateDataAnchor` on a verifiable KA then hydrates triples that a
 * different layer/version committed.
 *
 * This test asserts the CORRECT (post-fix) behaviour, so it is RED today
 * (the bug is live) and turns GREEN once the fix lands; it stays red until #1078 is fixed.. Hermetic — in-memory oxigraph only.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore, GraphManager, PrivateContentStore, type Quad } from '../src/index.js';

// Opt-in gate: these repros assert post-fix behaviour, so they are RED while
// the bug is live. They are EXCLUDED from the default test lane (which must stay
// green / mergeable) and run only under `RUN_ISSUE_LIVENESS=1` (the dedicated
// issue-liveness CI lane). See package.json `test:issue-liveness`.
const LIVENESS_ENABLED = process.env.RUN_ISSUE_LIVENESS === '1';


const CG = 'gh1078-cg';
const ROOT = 'urn:gh1078:device';

function priv(predicate: string, object: string): Quad {
  return { subject: ROOT, predicate, object, graph: '' };
}

describe.runIf(LIVENESS_ENABLED)('GH #1078 — private payload storage must be scoped to the committing layer/commitment', () => {
  it(
    'a root hydrates only the authoritative private slice, not a different commitment for the same root',
    async () => {
      const store = new OxigraphStore();
      const gm = new GraphManager(store);
      const pcs = new PrivateContentStore(store, gm);

      // Commitment #1 — an EARLIER private slice for ROOT (e.g. a WM/SWM draft or
      // a superseded KA version). The exact authority does not matter; what
      // matters is that it is a DIFFERENT private payload committed under the
      // same root.
      await pcs.storePrivateTriples(CG, ROOT, [priv('https://schema.org/serialNumber', '"OLD-0001"')]);

      // Commitment #2 — the slice the AUTHORITATIVE / verifiable KA actually
      // committed for ROOT. This is what a `privateDataAnchor` on the verifiable
      // KA should resolve to.
      await pcs.storePrivateTriples(CG, ROOT, [priv('https://schema.org/serialNumber', '"NEW-0002"')]);

      // Hydration for ROOT (the only main-API read path).
      const hydrated = await pcs.getPrivateTriples(CG, ROOT);
      const serials = hydrated
        .filter((q) => q.predicate === 'https://schema.org/serialNumber')
        .map((q) => q.object);

      // Control: the authoritative slice IS present (so the negative assertion
      // below is meaningful and not vacuously true on an empty read).
      expect(serials).toContain('"NEW-0002"');

      // CORRECT (post-fix): a verifiable-commitment-scoped hydration returns ONLY
      // the authoritative slice. Today private storage is layer-blind, so the
      // superseded "OLD-0001" leaks back in — exactly the cross-commitment
      // hydration #1078 describes.
      expect(serials).not.toContain('"OLD-0001"');
    },
  );
});
