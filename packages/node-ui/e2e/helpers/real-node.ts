/**
 * Shared constants + seeding helpers for the real-node Playwright suite.
 *
 * There are NO mocks: every spec drives the real UI against a live devnet that
 * `e2e/bootstrap-devnet.ts` boots (and `e2e/global-teardown.ts` tears down).
 * `scripts/devnet.sh` seeds two open context graphs on every boot — these are
 * the deterministic anchors specs assert against instead of the old mock CGs.
 */
import {
  runWmSwmVmPipeline,
  createWmAssertion,
  buildTestQuads,
  createSubGraph,
  buildSubGraphQuads,
} from './devnet-publish.js';

/** Context graphs `scripts/devnet.sh` registers on-chain on every boot. */
export const PRIMARY_CG = 'devnet-test';
export const SECONDARY_CG = 'devnet-isolation';
export const SEEDED_CGS = [PRIMARY_CG, SECONDARY_CG] as const;

/**
 * Devnet TOPOLOGY the suite drives — derived from the SAME env vars
 * `playwright.config.ts` / `bootstrap-devnet.ts` read, with identical defaults,
 * so the test-runner process agrees with the webServer on which node the UI
 * targets and how the mesh is shaped. The config only force-sets these on the
 * webServer subprocesses, but when an operator exports `UI_NODE_ID`/`DEVNET_NODE`
 * (or `PLAYWRIGHT_DEVNET_NUM_NODES`) before invoking the runner, the runner
 * inherits them and stays in sync; otherwise everything falls back to node1 +
 * a 3-node mesh (the CI default), so these constants don't bake in a topology
 * that contradicts the advertised `UI_NODE_ID`/`DEVNET_NODE` overrides.
 *
 * `scripts/devnet.sh` makes node1 the relay HUB: every other node boots with
 * `relay = node1's multiaddr` and dials node1, so node1 reports N-1 connected
 * peers while a non-hub node only holds its single link to the hub. The first
 * `NUM_CORE_NODES` nodes boot as `core`; the rest are `edge`.
 */
export const UI_NODE = Number(process.env.DEVNET_NODE || process.env.UI_NODE_ID) || 1;
// Default 4 — matches playwright.config.ts. scripts/devnet.sh pins minSig=3, so
// a VM publish needs minSig OTHER core peers = 4 nodes total; node1 (relay hub)
// then settles at EXPECTED_MIN_PEERS = N-1 = 3.
export const NUM_NODES = Number(process.env.PLAYWRIGHT_DEVNET_NUM_NODES) || 4;
export const NUM_CORE_NODES = Number(process.env.NUM_CORE_NODES) || 4;
/** node1 is the relay hub every other node dials. */
export const IS_RELAY_HUB = UI_NODE === 1;
/**
 * Connected-peer count the UI's target node must reach once the mesh settles:
 * the hub sees every other node (N-1); a non-hub node sees only the hub (1).
 */
export const EXPECTED_MIN_PEERS = IS_RELAY_HUB ? Math.max(1, NUM_NODES - 1) : 1;
/** Role the UI's target node reports in Settings — core for node ≤ NUM_CORE_NODES, else edge. */
export const EXPECTED_NODE_ROLE: 'core' | 'edge' = UI_NODE <= NUM_CORE_NODES ? 'core' : 'edge';

/**
 * A named sub-graph that `global-setup.ts` registers + seeds inside PRIMARY_CG.
 * Its presence guarantees the SubGraphBar renders a concrete (non-"All") scope
 * chip on EVERY layer page — the bar derives its chips from the project-wide
 * `/api/sub-graph/list`, so a single registered sub-graph means specs never hit
 * the "only the aggregate All chip exists" degenerate case (which previously
 * forced conditional `test.skip`s and made the WM-layer bar flaky/empty).
 *
 * The slug is deliberately e2e-namespaced (NOT a generic name like "people")
 * because `global-setup.ts` uses its presence as the "this devnet was already
 * seeded by us" sentinel to keep seeding idempotent. A generic name could
 * pre-exist on a reused operator devnet and trick setup into skipping the seed,
 * leaving specs asserting against ambient cluster data instead of our fixtures.
 */
export const NAMED_SUBGRAPH = 'e2e-seed-people';

export interface SeededEntity {
  /** rdfs:label of the published entity — assert this appears in the VM layer. */
  label: string;
  /** The WM/SWM/VM assertion name used (handy for follow-up promote/publish). */
  assertionName: string;
  /** kaId returned by the VM publish, when the pipeline reached VM. */
  kaId?: string;
}

/**
 * Publish ONE deterministic entity through the full WM → SWM → VM pipeline into
 * `cgId`, so layer/entity/triple views have real, verifiable content to render.
 * Returns the entity label so the caller can assert it surfaces in the UI.
 *
 * Used from each rich-content spec's `beforeAll`. Each call mints a fresh
 * timestamped URI, so repeated runs accumulate entities rather than colliding —
 * specs therefore assert tolerantly ("the label I just seeded is visible",
 * "count ≥ 1") rather than against a brittle exact total.
 */
export async function seedVmEntity(cgId: string, nodeNum = 1): Promise<SeededEntity> {
  const stamp = Date.now();
  const result = await runWmSwmVmPipeline({ contextGraphId: cgId, stamp, nodeNum });
  return { label: result.label, assertionName: result.assertionName, kaId: result.kaId };
}

/**
 * Seed a WM-only (un-promoted) assertion so the Working-Memory layer has staged
 * content. Returns the label to assert against.
 */
export async function seedWmEntity(cgId: string, prefix = 'wm'): Promise<SeededEntity> {
  const stamp = Date.now();
  const assertionName = `e2e-ui-${prefix}-${stamp}`;
  const label = `E2E WM ${stamp}`;
  const res = await createWmAssertion({
    contextGraphId: cgId,
    name: assertionName,
    quads: buildTestQuads(cgId, stamp, label),
    alsoShareSwm: false,
  });
  if (!res.ok) throw new Error(`seedWmEntity failed: ${res.status} ${res.body}`);
  return { label, assertionName };
}

/**
 * Register `subGraphName` in `cgId` (idempotent) and publish ONE finalized,
 * promoted entity into it, so `/api/sub-graph/list` reports a real named
 * sub-graph with ≥1 entity. This makes the SubGraphBar render a concrete scope
 * chip on every layer deterministically (see {@link NAMED_SUBGRAPH}).
 */
export async function seedSubgraphEntity(
  cgId: string,
  subGraphName = NAMED_SUBGRAPH,
  nodeNum = 1,
): Promise<SeededEntity> {
  await createSubGraph({ contextGraphId: cgId, subGraphName, nodeNum });
  const stamp = Date.now();
  const assertionName = `e2e-ui-sg-${subGraphName}-${stamp}`;
  const label = `E2E SG ${subGraphName} ${stamp}`;
  const res = await createWmAssertion({
    contextGraphId: cgId,
    name: assertionName,
    quads: buildSubGraphQuads(cgId, subGraphName, stamp, label),
    subGraphName,
    alsoShareSwm: true,
    nodeNum,
  });
  if (!res.ok) throw new Error(`seedSubgraphEntity failed: ${res.status} ${res.body}`);
  return { label, assertionName };
}
