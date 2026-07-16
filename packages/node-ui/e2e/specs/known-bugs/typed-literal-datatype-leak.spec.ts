/**
 * Regression test for GH #913 — FIXED in this PR. Was a `test.fixme()` known-bug
 * repro; now ACTIVE and passing. It guards the fix and turns red if the bug
 * regresses.
 *
 * GH ISSUE: https://github.com/OriginTrail/dkg/issues/913 — "typed/language-tagged
 * RDF literals render with a raw datatype/lang suffix in entity views".
 *
 * Root cause: `useMemoryEntities.ts:489` builds `entity.properties` with
 *   const val = t.object.startsWith('"') ? t.object.replace(/^"|"$/g, '') : t.object;
 * `/^"|"$/g` strips a leading OR trailing `"`. A TYPED literal serialises as
 * `"42"^^<http://www.w3.org/2001/XMLSchema#integer>` — it ends in `>`, not `"` —
 * so only the leading quote is stripped, leaving `42"^^<…#integer>` on screen.
 * The same buggy pattern is in the Triples-tab object column
 * (`views/project/components.tsx:3705`). The correct, datatype-aware strip
 * already exists in sibling hooks (useVerifiableMemoryAnchors / useSwmAttributions
 * / useAssertionLifecycleEvents): `.replace(/^"/, '').replace(/"(\^\^<[^>]*>)?$/, '')`.
 *
 * This test is deterministic and uses NO mocks: it publishes a real WM entity
 * carrying an explicit `"42"^^<xsd:integer>` property via the devnet API, opens
 * it in the live UI, and asserts the rendered detail contains no `^^<datatype>`
 * residue. It FAILS today (the suffix leaks) and will PASS once the literal
 * formatter is fixed.
 */
import { test, expect } from '../../fixtures/base.js';
import { PRIMARY_CG } from '../../helpers/real-node.js';
import { createWmAssertion } from '../../helpers/devnet-publish.js';

test.describe('KNOWN BUG: typed RDF literals leak their datatype suffix in entity views', () => {
  test('a typed integer property renders as "42", not 42"^^<…integer>', async ({
    page,
    shell,
    leftPanel,
  }) => {
    // ---- seed a real WM entity with an explicit typed literal (no mocks) ----
    const stamp = `${Date.now()}`;
    const subject = `urn:e2e:ui:typed-literal:${stamp}`;
    const label = `Typed Literal Repro ${stamp}`;
    const graph = `did:dkg:context-graph:${PRIMARY_CG}`;
    const seed = await createWmAssertion({
      contextGraphId: PRIMARY_CG,
      name: `typed-literal-repro-${stamp}`,
      quads: [
        {
          subject,
          predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          object: 'http://dkg.io/ontology/core/Entity',
          graph,
        },
        {
          subject,
          predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
          object: `"${label}"`,
          graph,
        },
        {
          // The bug-bearing triple: an xsd:integer typed literal.
          subject,
          predicate: 'http://dkg.io/ontology/test/count',
          object: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph,
        },
      ],
      alsoShareSwm: false,
    });
    expect(seed.ok, `WM seed failed: ${seed.status} ${seed.body}`).toBe(true);

    // ---- open the entity in the live UI ----
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await leftPanel.clickLayer(PRIMARY_CG, 'wm');

    const card = page.locator('.v10-entity-card').filter({ hasText: label });
    await expect(card.first()).toBeVisible({ timeout: 20_000 });
    await card.first().click();

    const center = page.locator('.v10-center-content');
    // sanity: the detail for OUR entity is open (so a later assertion failure is
    // about the leak, not a mis-click).
    await expect(center.getByText(label).first()).toBeVisible({ timeout: 10_000 });

    // ==== THE BUG ====
    // The integer literal `"42"^^<xsd:integer>` must display as plain `42`.
    // Today it renders `42"^^<http://www.w3.org/2001/XMLSchema#integer>`, so a
    // search for the datatype residue finds it. CORRECT behavior = zero matches.
    await expect(
      center.getByText(/\^\^<http|XMLSchema#/),
      'Typed RDF literal renders with a raw datatype suffix (e.g. 42"^^<…integer>) ' +
        'instead of just 42 — useMemoryEntities.ts:489 strips only the leading quote. See GH #913.',
    ).toHaveCount(0, { timeout: 10_000 });
  });
});
