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

const CG = 'gh1078-cg';
const ROOT = 'urn:gh1078:device';

function priv(predicate: string, object: string): Quad {
  return { subject: ROOT, predicate, object, graph: '' };
}

describe('GH #1078 — private payload storage must be scoped to the committing layer/commitment', () => {
  it(
    'a root hydrates only the authoritative private slice, not a different commitment for the same root',
    async () => {
      const store = new OxigraphStore();
      const gm = new GraphManager(store);
      const pcs = new PrivateContentStore(store, gm);

      // Commitment #1 — an EARLIER private slice for ROOT (e.g. a WM/SWM draft or
      // a superseded KA version). The exact authority does not matter; what
      // matters is that it is a DIFFERENT private payload committed under the
      // same root, identified by its own verifiable-commitment id.
      await pcs.storePrivateTriples(CG, ROOT, [priv('https://schema.org/serialNumber', '"OLD-0001"')], undefined, 'commitment-old');

      // Commitment #2 — the slice the AUTHORITATIVE / verifiable KA actually
      // committed for ROOT. This is what a `privateDataAnchor` on the verifiable
      // KA should resolve to. A NEW commitment supersedes the stale one for the
      // same root, so the stale slice must not survive into hydration.
      await pcs.storePrivateTriples(CG, ROOT, [priv('https://schema.org/serialNumber', '"NEW-0002"')], undefined, 'commitment-new');

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

  it(
    'superseding one root does NOT delete a sibling root whose IRI shares its prefix',
    async () => {
      const store = new OxigraphStore();
      const gm = new GraphManager(store);
      const pcs = new PrivateContentStore(store, gm);

      const R1 = 'urn:gh1078:device:1';
      const R10 = 'urn:gh1078:device:10'; // shares the "urn:gh1078:device:1" prefix

      await pcs.storePrivateTriples(CG, R1, [{ subject: R1, predicate: 'https://schema.org/serialNumber', object: '"R1-OLD"', graph: '' }], undefined, 'c1');
      await pcs.storePrivateTriples(CG, R10, [{ subject: R10, predicate: 'https://schema.org/serialNumber', object: '"R10-KEEP"', graph: '' }], undefined, 'c10');

      // Re-publish R1 under a NEW commitment → supersedes R1's slice. A bare
      // prefix delete would also wipe R10 (STRSTARTS("urn:device:1")); the
      // exact-root + skolem-prefix delete must leave R10 intact.
      await pcs.storePrivateTriples(CG, R1, [{ subject: R1, predicate: 'https://schema.org/serialNumber', object: '"R1-NEW"', graph: '' }], undefined, 'c1-v2');

      const r10 = (await pcs.getPrivateTriples(CG, R10)).map((q) => q.object);
      expect(r10, 'sibling root R10 must survive R1 supersede').toContain('"R10-KEEP"');

      const r1 = (await pcs.getPrivateTriples(CG, R1)).map((q) => q.object);
      expect(r1).toContain('"R1-NEW"');
      expect(r1).not.toContain('"R1-OLD"');
    },
  );
});
