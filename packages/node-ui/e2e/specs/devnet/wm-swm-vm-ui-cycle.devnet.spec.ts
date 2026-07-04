/**
 * UI-driven WM → SWM → VM lifecycle against a live devnet.
 *
 * Unlike `wm-swm-vm-lifecycle.devnet.spec.ts` (which drives the pipeline over
 * the HTTP API), this spec exercises the REAL user journey through the browser:
 *
 *   1. Import a Markdown file into Working Memory via the Import modal.
 *   2. Seed a default-graph WM assertion and click the Promote control to move
 *      it WM → SWM.
 *   3. Click the Publish control to move SWM → VM.
 *
 * It asserts BOTH that the UI is functional AND — the critical part — that the
 * triples actually migrate across layers, verified by per-graph SPARQL counts
 * (surface-independent, so the spec doesn't depend on which layer-view variant
 * renders the buttons).
 *
 * The import fixture is retained as browser coverage for the upload flow, but
 * the promotion target is seeded through the JSON lifecycle API. Current SWM
 * share intentionally rejects assertion payloads that preserve original RDF
 * named-graph identity; the API-seeded assertion stays in the KA default graph
 * while still carrying blank-node section triples for the WM cleanup check.
 *
 * Run: `pnpm test:e2e` — the Playwright webServer boots (or reuses) the devnet.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect } from '../../fixtures/base.js';
import type { Page } from '@playwright/test';
import {
  waitForDevnetStatus,
  requireDevnetPrecondition,
  requireDevnetNode,
  devnetApiFetch,
} from '../../helpers/devnet.js';
import { listContextGraphs } from '../../helpers/devnet-publish.js';
import {
  findWmAssertion,
  namedRootsInGraph,
  countTriplesInGraph,
  countBlankNodeTriplesInGraph,
  countRootInSharedMemory,
  countRootInVmScope,
  readMemoryLayerMarker,
} from '../../helpers/layer-counts.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dir, '..', '..', 'fixtures', 'single-entity-fixture.md');
// The import modal sanitizes the filename into the assertion name
// (`[^a-zA-Z0-9._-]` → `_`), so the dot in `.md` is preserved and the WM
// assertion graph URI contains this substring.
const FIXTURE_NAME_PART = 'single-entity-fixture';

test.describe.configure({ mode: 'serial' });

const run: {
  cgId?: string;
  cgName?: string;
  assertionName?: string;
  dataGraph?: string;
  markerUri?: string;
  rootUri?: string;
} = {};

test.beforeAll(async () => {
  await requireDevnetNode(test, 1);
  await waitForDevnetStatus(1);

  // HARD precondition (NOT a skip): this spec only reproduces #996 on a
  // SPARQL-over-HTTP backend. If node 1 isn't on `oxigraph-server`, the
  // blank-node DELETE-DATA path is never exercised and the spec would pass
  // trivially — the exact silent-degradation trap that hid the bug in rc.16.
  // Fail loudly so the devnet backend wiring (scripts/devnet.sh: node 1-2 →
  // oxigraph-server) can never regress unnoticed.
  const statusRes = await devnetApiFetch('/api/status', { nodeNum: 1 });
  const status = (await statusRes.json()) as { storeBackend?: string };
  expect(
    status.storeBackend,
    'node 1 must run the oxigraph-server backend for this spec to exercise #996 ' +
      '(set in scripts/devnet.sh); got a non-SPARQL-over-HTTP backend instead',
  ).toBe('oxigraph-server');

  // `/api/status` answering does NOT mean the seeded primary context graph has
  // finished registering — on a cold boot `listContextGraphs()` can briefly
  // return [] and make this spec falsely skip with "No context graphs". Poll for
  // a bounded window so a still-propagating CG isn't mistaken for an empty
  // devnet; a genuinely-empty operator devnet still falls through to the skip.
  let cgs = await listContextGraphs(1);
  if (cgs.length === 0) {
    const deadline = Date.now() + 30_000;
    while (cgs.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
      cgs = await listContextGraphs(1);
    }
  }
  requireDevnetPrecondition(test, cgs.length === 0, 'No context graphs on devnet');
  run.cgId = cgs[0]!.id;
  run.cgName = cgs[0]!.name;
});

async function openProjectTab(page: Page, name: string) {
  await page
    .locator('.v10-panel-left')
    .first()
    .locator('.v10-tree-section-header')
    .filter({ hasText: name })
    .first()
    .click();
}

async function openImportModal(page: Page) {
  const importBtn = page.locator('button[aria-label="Import into Context Graph"]');
  await expect(importBtn).toBeVisible({ timeout: 10_000 });
  await importBtn.click();
}

async function expectOk(res: Response, label: string) {
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${await res.text()}`);
  }
}

async function createPromotableDefaultGraphAssertion() {
  const stamp = Date.now();
  const name = `e2e-ui-promote-${stamp}`;
  const root = `urn:e2e:ui-promote:${stamp}`;
  const defaultGraph = `did:dkg:context-graph:${run.cgId}`;
  const res = await devnetApiFetch('/api/knowledge-assets', {
    method: 'POST',
    body: JSON.stringify({
      contextGraphId: run.cgId,
      name,
      quads: [
        {
          subject: root,
          predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          object: 'http://dkg.io/ontology/core/Entity',
          graph: defaultGraph,
        },
        {
          subject: root,
          predicate: 'http://schema.org/name',
          object: `"UI Promote ${stamp}"`,
          graph: defaultGraph,
        },
        {
          subject: root,
          predicate: 'http://schema.org/hasPart',
          object: '_:section1',
          graph: defaultGraph,
        },
        {
          subject: '_:section1',
          predicate: 'http://schema.org/name',
          object: '"Background"',
          graph: defaultGraph,
        },
      ],
      finalize: true,
      alsoShareSwm: false,
    }),
  });
  await expectOk(res, 'create promotable assertion');

  const assertion = await findWmAssertion(run.cgId!, name);
  run.assertionName = assertion.name;
  run.dataGraph = assertion.dataGraphUri;
  run.markerUri = assertion.markerUri;
  run.rootUri = root;
}

function assertionPromoteControl(page: Page, assertionName: string) {
  return page
    .locator('.v10-item-row')
    .filter({ hasText: assertionName })
    .locator('button')
    .filter({ hasText: /SWM|Promote/i })
    .first();
}

/** A publish control on whichever layer-view surface renders. */
function publishControl(page: Page) {
  return page
    .getByTestId('widget-publish-vm-btn')
    .or(page.getByTestId('list-publish-all-btn'))
    .or(page.getByTestId('mlv-publish-all-btn'));
}

/** Any rendered promote/publish result container's combined text. */
async function resultText(page: Page): Promise<string> {
  const containers = page
    .getByTestId('layer-action-result')
    .or(page.getByTestId('list-action-result'))
    .or(page.getByTestId('mlv-promote-result'))
    .or(page.locator('.v10-promote-result'));
  const n = await containers.count();
  let text = '';
  for (let i = 0; i < n; i++) {
    text += (await containers.nth(i).textContent()) ?? '';
  }
  return text;
}

test.describe('WM → SWM → VM via the UI', () => {
  test('imports a Markdown file into Working Memory', async ({ shell, leftPanel, page, importFilesModal }) => {
    await shell.goto();
    await expect(async () => {
      const names = await leftPanel.getProjectNames();
      expect(names.length).toBeGreaterThan(0);
    }).toPass({ timeout: 12_000, intervals: [250, 500, 1000] });

    await openProjectTab(page, run.cgName!);
    await openImportModal(page);
    await expect(importFilesModal.overlay).toBeVisible();

    await importFilesModal.selectFile(FIXTURE);
    expect(await importFilesModal.isImportDisabled()).toBe(false);
    await importFilesModal.startImport();

    // Import result surfaces with a non-zero extracted-triple count.
    const result = page.getByTestId('import-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result).toHaveAttribute('data-import-status', 'success');
    const triples = Number(await result.getAttribute('data-import-triples'));
    expect(triples, 'extractor wrote >0 triples for the fixture').toBeGreaterThan(0);
    await importFilesModal.clickDone();

    // The assertion now exists in WM. Discover its data graph + marker URI.
    let imported: Awaited<ReturnType<typeof findWmAssertion>> | undefined;
    await expect(async () => {
      imported = await findWmAssertion(run.cgId!, FIXTURE_NAME_PART);
    }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });

    const roots = await namedRootsInGraph(run.cgId!, imported!.dataGraphUri);
    expect(roots.length, 'fixture extracts exactly one named root entity').toBe(1);

    // Import invariant: the WM assertion holds content INCLUDING blank-node
    // section subjects. Clean it up afterwards because SWM share correctly
    // rejects this import shape's assertion-scoped named-graph payload.
    expect(await countTriplesInGraph(run.cgId!, imported!.dataGraphUri)).toBeGreaterThan(0);
    expect(
      await countBlankNodeTriplesInGraph(run.cgId!, imported!.dataGraphUri),
      'fixture must contain blank-node section triples (the bug trigger)',
    ).toBeGreaterThan(0);
    expect(await readMemoryLayerMarker(run.cgId!, imported!.markerUri)).toBe('WM');

    const discard = await devnetApiFetch(`/api/knowledge-assets/${encodeURIComponent(imported!.name)}/wm/discard`, {
      method: 'POST',
      body: JSON.stringify({ contextGraphId: run.cgId }),
    });
    await expectOk(discard, 'discard imported assertion');
  });

  test('promotes WM → SWM via the UI and the triples actually migrate', async ({ shell, page }) => {
    await createPromotableDefaultGraphAssertion();
    test.skip(!run.dataGraph || !run.rootUri, 'Setup did not produce an assertion');

    // Pre-promote invariants: the WM assertion holds default-graph content plus
    // blank-node section triples, and SWM has none of it yet.
    expect(await countTriplesInGraph(run.cgId!, run.dataGraph!)).toBeGreaterThan(0);
    expect(
      await countBlankNodeTriplesInGraph(run.cgId!, run.dataGraph!),
      'promote target must contain blank-node section triples',
    ).toBeGreaterThan(0);
    expect(await countRootInSharedMemory(run.cgId!, run.rootUri!)).toBe(0);
    expect(await readMemoryLayerMarker(run.cgId!, run.markerUri!)).toBe('WM');

    await shell.goto();
    await openProjectTab(page, run.cgName!);

    // Switch to the Working Memory layer where the promote control lives.
    await page.locator('button.v10-layer-switch-btn[data-layer="wm"]').first().click();
    await page.getByRole('button', { name: 'Assertions' }).click();

    const promote = assertionPromoteControl(page, run.assertionName!);
    await expect(promote).toBeVisible({ timeout: 15_000 });
    await promote.click();

    // UI contract: the result must NOT be the misleading "No triples were
    // promoted" no-op that the blank-node DELETE bug produced. Wait for a
    // result to render, then assert it isn't the no-op message.
    await expect(async () => {
      const text = await resultText(page);
      expect(text.length, 'a promote result must render').toBeGreaterThan(0);
      expect(text, 'promote must report a successful migration').toMatch(/Promoted \d+ triple/i);
      expect(text, 'promote must not report the no-op (the bug symptom)').not.toMatch(
        /No triples were promoted/i,
      );
      expect(text, 'promote must not report a named-graph guard failure').not.toMatch(
        /named-graph|graph identity|✕/i,
      );
    }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });

    // Migration contract (surface-independent): the assertion's content left
    // WM (blank nodes included), landed in SWM (root + skolemized children),
    // and the memoryLayer marker flipped to SWM.
    await expect(async () => {
      expect(await countRootInSharedMemory(run.cgId!, run.rootUri!)).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });

    expect(
      await countBlankNodeTriplesInGraph(run.cgId!, run.dataGraph!),
      'all blank-node triples must be removed from the WM assertion graph',
    ).toBe(0);
    expect(await readMemoryLayerMarker(run.cgId!, run.markerUri!)).toBe('SWM');
  });

  // DEFERRED (OriginTrail/dkg#966): the SWM → VM publish step is a browser-
  // coverage gap, NOT the promote bug this spec proves. Both the project-view
  // bulk "Publish to Verifiable Memory" control (`widget-publish-vm-btn`) and the
  // `PublishPanel` in `MemoryLayerView` now publish EVERY selected SWM assertion
  // as its own on-chain Knowledge Asset via the canonical per-KA /vm/publish
  // (Design B, any entity count). On the shared seeded devnet CG (~25 SWM roots)
  // that fires ~25 real on-chain mints — too slow/flaky for a browser e2e, and it
  // touches roots this spec doesn't own. Neither surface offers a click-path to
  // publish ONLY this spec's imported root, so there is no clean single-assertion
  // target. End-to-end on-chain mint is already verified by the API-driven
  // sibling spec (`wm-swm-vm-lifecycle.devnet.spec`). Kept as `fixme` until this
  // spec provisions its own dedicated single-assertion CG so the bulk publish
  // maps 1:1 to our root. The import → promote steps above are the asserting
  // cycle for the blank-node fix.
  test.fixme('publishes SWM → VM via the UI and the entity lands in Verifiable Memory', async ({ shell, page }) => {
    test.skip(!run.rootUri, 'Promote step did not run');
    await shell.goto();
    await openProjectTab(page, run.cgName!);

    // Switch to the Shared Working Memory layer where Publish lives.
    await page.locator('button.v10-layer-switch-btn[data-layer="swm"]').first().click();

    const publish = publishControl(page);
    await expect(publish).toBeVisible({ timeout: 15_000 });
    await publish.click();

    // Outcome contract: the published entity becomes visible in the VM scope
    // (context-graph root graphs, excluding assertion/_shared_memory/meta).
    // This is the authoritative "did it publish" assertion; on-chain mint is
    // verified by the API-driven sibling spec.
    await expect(async () => {
      expect(await countRootInVmScope(run.cgId!, run.rootUri!)).toBeGreaterThan(0);
    }).toPass({ timeout: 60_000, intervals: [1000, 2000, 5000] });
  });
});
