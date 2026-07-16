/**
 * Playwright global setup — seeds deterministic content into the devnet so the
 * data-driven UI views (memory layers, entity lists, triple counts, subgraphs)
 * have something real to render.
 *
 * Runs in PARALLEL with the webServer (see playwright.config.ts), so it must NOT
 * assume the bootstrap has finished — it polls `waitForDevnetStatus` until node1
 * is reachable (the chained bootstrap brings it up), then publishes one entity
 * through the full WM → SWM → VM pipeline into the primary seeded context graph.
 *
 * IDEMPOTENT seed. Several specs (subgraph-bar, dashboard, triple-counts, …) hard-
 * require the seeded VM entity + NAMED_SUBGRAPH sub-graph, so the supported "reuse
 * an operator-owned devnet" flow needs them present too — skipping the seed there
 * would fail those specs even on a healthy UI. But re-seeding on every run would
 * accrete assertions on a reused cluster. So we seed only when the devnet isn't
 * seeded yet (detected by the absence of the NAMED_SUBGRAPH sub-graph in
 * PRIMARY_CG): a fresh CI devnet — or a never-seeded operator devnet — gets seeded
 * once; subsequent runs against an already-seeded devnet are a no-op.
 *
 * Seeding is REQUIRED, not best-effort: several specs hard-require the seeded VM
 * entity + sub-graph, so any failure here (devnet never reachable, publish or
 * sub-graph seeding errors) must abort the run AT SETUP with the underlying
 * error. Swallowing it would only resurface later as confusing, unrelated
 * UI-assertion failures that are far harder to diagnose.
 */
import { waitForDevnetStatus, waitForConnectedPeers } from './helpers/devnet.js';
import { listSubGraphs, waitForContextGraph, countSeededVmRootEntities } from './helpers/devnet-publish.js';
import { seedVmEntity, seedSubgraphEntity, PRIMARY_CG, NAMED_SUBGRAPH, UI_NODE, EXPECTED_MIN_PEERS } from './helpers/real-node.js';

// The UI can be repointed at a non-default node via DEVNET_NODE / UI_NODE_ID
// (see playwright.config.ts + bootstrap-devnet.ts). `UI_NODE` (from real-node.ts)
// is derived from the same env vars, so we health-check, quorum-wait,
// idempotency-check and SEED the SAME node the browser talks to — otherwise we
// could seed/verify node1 while the UI reads a different backend and start
// asserting before the seeded data is visible to it.

export default async function globalSetup(): Promise<void> {
  // Intentionally NOT wrapped in try/catch — see the file header. A seed failure
  // must propagate so Playwright aborts the run at setup with the real error.
  await waitForDevnetStatus(UI_NODE, 180_000);
  // `/api/status` answering does NOT mean the seeded context graphs are
  // registered yet — on a cold boot scripts/devnet.sh is still registering
  // `devnet-test` for a few seconds after the API port opens. Gate on the CG
  // actually existing so the strict listSubGraphs() below can't 400/throw on an
  // unregistered CG and abort the whole suite moments before it would be ready.
  await waitForContextGraph(PRIMARY_CG, UI_NODE, 120_000);
  // Gate the WHOLE run on the mesh being SETTLED — not merely "≥1 peer". globalSetup
  // runs in parallel with the bootstrap, so on a cold boot the UI node can be up
  // while a peer is still dialing; starting specs then makes peer-connectivity
  // assert against a half-formed mesh (intermittent failures) and lets a VM seed
  // race quorum. Waiting for EXPECTED_MIN_PEERS (the settled count for the chosen
  // UI node — N-1 for the hub, 1 for a non-hub) BEFORE the idempotency check means
  // even a reused/already-seeded devnet is confirmed healthy before the run begins.
  await waitForConnectedPeers(UI_NODE, EXPECTED_MIN_PEERS, 120_000);
  // Idempotency check: skip ONLY when BOTH seed artifacts the specs depend on are
  // present — they are seeded separately and a guard on just one can be satisfied
  // without the other:
  //   1. the e2e-namespaced NAMED_SUBGRAPH sub-graph WITH ≥1 entity (drives the
  //      SubGraphBar's concrete scope chip), AND
  //   2. the deterministic VM root-bucket seed (drives the layer/entity/triple
  //      views) — verified directly, not inferred from the sub-graph.
  // Requiring both means a reused devnet that happens to carry NAMED_SUBGRAPH for
  // some other reason (or a prior run that died between the two seeds) does NOT
  // trick us into skipping and leaving specs asserting against ambient data. A
  // bare registered sub-graph with entityCount 0 likewise fails the check, so a
  // mid-seed crash re-seeds to completion. Re-seeding is safe: specs assert ≥1 /
  // "the label I just seeded is visible", never an exact total.
  const existing = await listSubGraphs(PRIMARY_CG, UI_NODE);
  const subGraphSeeded = existing.some((sg) => sg.name === NAMED_SUBGRAPH && sg.entityCount >= 1);
  // A transient /api/query failure must not be mistaken for "VM seed present" and
  // skip — treat an un-confirmable VM seed as not-seeded and (re-)seed.
  let vmSeeded = false;
  try {
    vmSeeded = (await countSeededVmRootEntities(PRIMARY_CG, UI_NODE)) >= 1;
  } catch (err) {
    console.log(`[global-setup] could not confirm VM root seed on node${UI_NODE} (${(err as Error).message}) — will (re-)seed`);
  }
  if (subGraphSeeded && vmSeeded) {
    console.log(
      `[global-setup] ${PRIMARY_CG} already seeded on node${UI_NODE} (sub-graph "${NAMED_SUBGRAPH}" has entities AND VM root seed present) — skipping to avoid accreting duplicate content`,
    );
    return;
  }
  console.log(
    `[global-setup] seeding ${PRIMARY_CG} on node${UI_NODE} (subGraphSeeded=${subGraphSeeded}, vmSeeded=${vmSeeded})`,
  );
  // Mesh already confirmed settled above (waitForConnectedPeers), so the VM
  // publish below has the connected-CORE-peer quorum it needs and can't race
  // the cold boot into a QuorumUnmetError.
  const seeded = await seedVmEntity(PRIMARY_CG, UI_NODE);
  console.log(`[global-setup] seeded VM entity into ${PRIMARY_CG} (node${UI_NODE}): "${seeded.label}" (kaId=${seeded.kaId ?? 'n/a'})`);
  // Register + seed a named sub-graph so the SubGraphBar always has a concrete
  // scope chip to drive — the subgraph specs assert against this instead of
  // skipping when only the aggregate "All" chip exists.
  const sg = await seedSubgraphEntity(PRIMARY_CG, NAMED_SUBGRAPH, UI_NODE);
  console.log(`[global-setup] seeded sub-graph "${NAMED_SUBGRAPH}" entity into ${PRIMARY_CG} (node${UI_NODE}): "${sg.label}"`);
}
