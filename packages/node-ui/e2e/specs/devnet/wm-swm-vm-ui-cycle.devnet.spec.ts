/**
 * UI-driven WM → SWM → VM lifecycle against a live devnet.
 *
 * Unlike `wm-swm-vm-lifecycle.devnet.spec.ts` (which drives the pipeline over
 * the HTTP API), this spec exercises the REAL user journey through the browser:
 *
 *   1. Import a Markdown file into Working Memory via the Import modal.
 *   2. Click the Promote control to move WM → SWM.
 *   3. Click the Publish control to move SWM → VM.
 *
 * It asserts BOTH that the UI is functional AND — the critical part — that the
 * triples actually migrate across layers, verified by per-graph SPARQL counts
 * (surface-independent, so the spec doesn't depend on which layer-view variant
 * renders the buttons).
 *
 * WHY THIS REPRODUCES THE BUG: the fixture is a Markdown doc that the
 * deterministic extractor turns into one NAMED root entity plus BLANK-NODE
 * section subjects. Promote's WM-cleanup deletes those blank-node-bearing
 * triples; on the rc.15 fresh-install default backend (oxigraph-server, which
 * devnet nodes 1-2 now run) a `DELETE DATA` with blank nodes is rejected, so a
 * pre-fix promote left WM populated and surfaced the "No triples were promoted"
 * no-op in the UI. The blank-node-safe adapter `delete()` is what makes this
 * spec go green.
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

  // Devnet-HEALTH gate (unchanged intent): a settled CI devnet always has the
  // seeded primary CG registered by global-setup, so an empty list means a
  // partitioned mesh / dropped CG — keep failing loudly (CI) / skipping (local).
  // `/api/status` answering does NOT prove the seed finished, so on a cold boot
  // `listContextGraphs()` can briefly return []; poll a bounded window before
  // deciding. NOTE: this spec no longer promotes on the shared seeded CG
  // (`cgs[0]`); it provisions its OWN dedicated CG below (#1464). The gate stays
  // purely as a "the devnet booted correctly" health check.
  let cgs = await listContextGraphs(1);
  if (cgs.length === 0) {
    const deadline = Date.now() + 30_000;
    while (cgs.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
      cgs = await listContextGraphs(1);
    }
  }
  requireDevnetPrecondition(test, cgs.length === 0, 'No context graphs on devnet');

  // #1464 — provision a DEDICATED, unique-per-run context graph so the UI's
  // promote-all (`widget-promote-all-btn`) sees ONLY this spec's own clean,
  // default-graph assertion. On the SHARED seeded CG the bulk promote iterates
  // EVERY WM assertion in the CG and aborts the whole batch if any one throws
  // (layer-widgets.tsx); sibling specs leave foreign `_named_graph` WM
  // assertions there, which the promote guard KA_NAMED_GRAPH_SHARE_UNSUPPORTED
  // (dkg-publisher.ts) correctly rejects → the fixture's own root failed to
  // migrate INTERMITTENTLY (depends on test ordering). A private, single-
  // assertion CG removes that cross-test coupling entirely.
  //
  // LOCAL create only (no `register`): WM import + WM→SWM promote are local
  // operations that need no on-chain registration (only the deferred VM-publish
  // `fixme` below would). The CG is curated by THIS node's agent — the same
  // identity that curates the seeded CGs (both go through the shared devnet auth
  // token) — so it renders under the browser's "My Context Graphs" (curator
  // match / `callerInvolved`), exactly like `devnet-test`. A plain-slug id
  // (matching the seeded `devnet-test` shape) keeps the
  // `did:dkg:context-graph:<id>/...` graph URIs the layer-count helpers build
  // well-formed.
  //
  // `accessPolicy: 0` (OPEN) matches the seeded devnet CGs on purpose: the
  // daemon's context-graph listing DROPS private/unknown-privacy rows when the
  // caller has no resolvable wallet (dkg-agent-cg-resolve.ts) — only `public`
  // rows survive that branch. Creating open makes this CG a faithful clone of
  // `devnet-test`, so it can't be silently filtered out of either the list the
  // poll below reads or the one the browser reads, regardless of how the devnet
  // auth token resolves. (Open vs curated has no effect on the local WM→SWM
  // promote this spec exercises.)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dedicatedCgId = `wm-swm-ui-cycle-1464-${stamp}`;
  const dedicatedCgName = `WM-SWM UI Cycle 1464 ${stamp}`;
  const createRes = await devnetApiFetch('/api/context-graph/create', {
    method: 'POST',
    nodeNum: 1,
    body: JSON.stringify({ id: dedicatedCgId, name: dedicatedCgName, accessPolicy: 0 }),
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '');
    throw new Error(`dedicated CG create failed: ${createRes.status} ${body}`);
  }

  // The daemon lists a CG only once it is persisted AND passes the caller-scoped
  // visibility filter (curator === this node's agent ⇒ `callerInvolved`). Poll
  // the SAME listing the browser reads so the first `shell.goto()` can't race
  // the create; if it never lists, fail HERE with a clear message instead of
  // surfacing later as a confusing `openProjectTab` timeout.
  //
  // CLEANUP: intentionally none. There is no CG-definition delete/drop route
  // (only `/api/context-graph/subscriptions` DELETE tears down subscriptions),
  // so an afterAll would have nothing to call. It's safe to leave the CG: it's
  // unique per run so it can't contaminate the shared seeded CG, and CI tears
  // the whole devnet down after the run.
  await expect(async () => {
    const list = await listContextGraphs(1);
    expect(
      list.some((c) => c.id === dedicatedCgId),
      `dedicated CG ${dedicatedCgId} not yet visible in the node's context-graph list`,
    ).toBe(true);
  }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

  run.cgId = dedicatedCgId;
  run.cgName = dedicatedCgName;
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

// #1464 — pruned the dead `.or()` fallbacks: the list-*/mlv-* testids exist nowhere in the
// codebase; only the widget surface renders. Keeping them made the readers surface-agnostic in
// name only and muddied WHICH component actually rendered.
function promoteControl(page: Page) {
  return page.getByTestId('widget-promote-all-btn');
}

function publishControl(page: Page) {
  return page.getByTestId('widget-publish-vm-btn');
}

/** The SUCCESS banner text (empty if none). */
async function successText(page: Page): Promise<string> {
  const el = page.getByTestId('layer-action-result');
  return (await el.count()) ? ((await el.first().textContent()) ?? '') : '';
}

/** #1464 — the ERROR banner text (empty if none), now on a DISTINCT testid from success so a
 *  thrown promote can't be read as a successful result. */
async function errorText(page: Page): Promise<string> {
  const el = page.getByTestId('layer-action-error');
  return (await el.count()) ? ((await el.first().textContent()) ?? '') : '';
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
    await expect(async () => {
      const a = await findWmAssertion(run.cgId!, FIXTURE_NAME_PART);
      run.dataGraph = a.dataGraphUri;
      run.markerUri = a.markerUri;
    }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });

    const roots = await namedRootsInGraph(run.cgId!, run.dataGraph!);
    expect(roots.length, 'fixture extracts exactly one named root entity').toBe(1);
    run.rootUri = roots[0];

    // Pre-promote invariants: the WM assertion holds content INCLUDING
    // blank-node section subjects, and SWM has none of it yet.
    expect(await countTriplesInGraph(run.cgId!, run.dataGraph!)).toBeGreaterThan(0);
    expect(
      await countBlankNodeTriplesInGraph(run.cgId!, run.dataGraph!),
      'fixture must contain blank-node section triples (the bug trigger)',
    ).toBeGreaterThan(0);
    expect(await countRootInSharedMemory(run.cgId!, run.rootUri!)).toBe(0);
    expect(await readMemoryLayerMarker(run.cgId!, run.markerUri!)).toBe('WM');
  });

  test('promotes WM → SWM via the UI and the triples actually migrate', async ({ shell, page }) => {
    test.skip(!run.dataGraph || !run.rootUri, 'Import step did not produce an assertion');
    await shell.goto();
    await openProjectTab(page, run.cgName!);

    // Switch to the Working Memory layer where the promote control lives.
    await page.locator('button.v10-layer-switch-btn[data-layer="wm"]').first().click();

    const promote = promoteControl(page);
    await expect(promote).toBeVisible({ timeout: 15_000 });
    await promote.click();

    // #1464 — POSITIVE success contract. The old guard only rejected the literal
    // "No triples were promoted" no-op, which an "✕ Promote failed…" error banner PASSED —
    // so a THROWN promote read as success and the redness surfaced later as a bare count-0,
    // misdiagnosed as a silent migration gap. Now: wait for a terminal outcome, assert NO error
    // banner is present (surfacing its now-server-tagged text so the throwing step is NAMED in CI),
    // then assert the success banner rendered and isn't the no-op.
    await expect(async () => {
      const err = await errorText(page);
      expect(err, `promote FAILED — error banner: "${err}"`).toBe('');
      const ok = await successText(page);
      expect(ok.length, 'a promote success banner must render').toBeGreaterThan(0);
      expect(ok, 'promote must not report the no-op (the bug symptom)').not.toMatch(
        /No triples were promoted/i,
      );
    }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });

    // Migration contract: the assertion's content left WM (blank nodes included), landed in the
    // count-visible SWM graph (root + skolemized children), and the marker flipped to SWM.
    // #1464 — on persistent count-0, DISAMBIGUATE instead of failing on a bare 0: capture the
    // WM-drain + marker so the failure classifies itself — WM intact/marker=WM ⇒ a pre-insert
    // throw (root never written); WM drained/marker=SWM but count 0 ⇒ the root committed but is
    // not enumerated by the count query (graph-set-index staleness or the bare-bucket exclusion).
    await expect(async () => {
      const count = await countRootInSharedMemory(run.cgId!, run.rootUri!);
      if (count > 0) return;
      const wmBlankNodes = await countBlankNodeTriplesInGraph(run.cgId!, run.dataGraph!);
      const marker = await readMemoryLayerMarker(run.cgId!, run.markerUri!);
      expect(
        count,
        `root not in count-visible SWM. disambiguation → WM-blank-node-triples=${wmBlankNodes} (0=WM drained), ` +
        `marker=${marker}: {WM,>0}⇒pre-insert throw (root never landed); {SWM,0}⇒committed-but-unenumerated/bare-bucket (see #1464 plan)`,
      ).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000, intervals: [500, 1000, 2000] });

    expect(
      await countBlankNodeTriplesInGraph(run.cgId!, run.dataGraph!),
      'all blank-node triples must be removed from the WM assertion graph',
    ).toBe(0);
    expect(await readMemoryLayerMarker(run.cgId!, run.markerUri!)).toBe('SWM');
  });

  // DEFERRED (OriginTrail/dkg#966): the SWM → VM publish step is a browser-
  // coverage gap, NOT the promote bug this spec proves. The project-view bulk
  // "Publish to Verifiable Memory" control (`widget-publish-vm-btn`) publishes
  // every selected SWM assertion as its own on-chain Knowledge Asset via the
  // canonical per-KA /vm/publish. Now that this spec runs on its OWN dedicated,
  // single-assertion CG (see beforeAll), that bulk publish WOULD map 1:1 to our
  // one root — but the dedicated CG is created LOCAL-ONLY (unregistered), and a
  // VM publish requires the CG to be registered on-chain AND ACK quorum from
  // connected core peers. Registering + funding + a real mint from the browser
  // is a heavier, slower flow than this promote-focused spec should own, and its
  // end-to-end on-chain mint is already verified by the API-driven sibling spec
  // (`wm-swm-vm-lifecycle.devnet.spec`). Kept as `fixme`: un-deferring it means
  // registering this CG on-chain (e.g. create with `register: true` + a
  // `waitForConnectedPeers` gate) first. The import → promote steps above are
  // the asserting cycle for the blank-node fix.
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
