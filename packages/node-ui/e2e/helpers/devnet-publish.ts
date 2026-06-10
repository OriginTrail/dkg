/**
 * Devnet API helpers for Playwright e2e — WM → SWM → VM publish flows.
 * Mirrors patterns from `devnet/rich-scenario/automated.test.ts`.
 */
import { devnetApiFetch, readDevnetNode } from './devnet.js';
import { withSwmLock } from './swm-lock.js';

export interface PublishQuads {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

/**
 * Subject prefix for the deterministic VM root-bucket seed published into a CG's
 * root content graph by {@link buildTestQuads} / runWmSwmVmPipeline. Used as the
 * idempotency probe ({@link countSeededVmRootEntities}) so global-setup can tell
 * whether OUR VM seed exists, independent of the named sub-graph sentinel.
 */
export const VM_SEED_SUBJECT_PREFIX = 'urn:e2e:ui:entity:';

export function buildTestQuads(cgId: string, stamp: number, label: string): PublishQuads[] {
  const subject = `${VM_SEED_SUBJECT_PREFIX}${stamp}`;
  const graph = `did:dkg:context-graph:${cgId}`;
  return [
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
  ];
}

export async function listContextGraphs(nodeNum = 1): Promise<Array<{ id: string; name: string }>> {
  const res = await devnetApiFetch('/api/context-graphs', { nodeNum });
  if (!res.ok) throw new Error(`context-graphs: ${res.status}`);
  const json = (await res.json()) as { contextGraphs: Array<{ id: string; name: string }> };
  return json.contextGraphs ?? [];
}

/**
 * Poll until `contextGraphId` is registered on `nodeNum`.
 *
 * `waitForDevnetStatus()` only proves `/api/status` is answering; on a COLD boot
 * `scripts/devnet.sh` is still registering `devnet-test` for a few seconds after
 * that point. Calling `listSubGraphs(PRIMARY_CG)` in that window can 400/throw
 * ("unknown context graph") and abort the whole suite even though bootstrap
 * finishes moments later. Gate setup on the CG actually existing before treating
 * any sub-graph-endpoint error as fatal. Transient errors WHILE polling (5xx /
 * transport / not-yet-registered) are swallowed; only a timeout throws.
 */
export async function waitForContextGraph(
  contextGraphId: string,
  nodeNum = 1,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'context graph never appeared';
  while (Date.now() < deadline) {
    try {
      const cgs = await listContextGraphs(nodeNum);
      if (cgs.some((cg) => cg.id === contextGraphId || cg.name === contextGraphId)) return;
      lastErr = `registered: [${cgs.map((c) => c.name || c.id).join(', ') || 'none'}]`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `waitForContextGraph: "${contextGraphId}" not registered on node${nodeNum} within ${timeoutMs}ms (${lastErr})`,
  );
}

/**
 * List the named sub-graphs registered in `contextGraphId` (the same endpoint the
 * SubGraphBar reads). Used by global-setup to detect an already-seeded devnet and
 * keep seeding idempotent.
 *
 * Only the EXPECTED "no sub-graphs yet" case (404) is mapped to an empty list. A
 * 200 returns whatever the daemon reports (empty or populated). Every OTHER status
 * (401/403 auth, 5xx, transport) is a real startup problem the caller must NOT
 * mistake for "unseeded" — surface it so global-setup fails fast instead of
 * re-publishing duplicate fixtures over a broken precondition.
 */
export async function listSubGraphs(
  contextGraphId: string,
  nodeNum = 1,
): Promise<Array<{ name: string; entityCount: number }>> {
  const res = await devnetApiFetch(
    `/api/sub-graph/list?contextGraphId=${encodeURIComponent(contextGraphId)}`,
    { nodeNum },
  );
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`listSubGraphs failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    subGraphs?: Array<{ name: string; entityCount?: number }>;
  };
  return (json.subGraphs ?? []).map((sg) => ({
    name: sg.name,
    entityCount: sg.entityCount ?? 0,
  }));
}

/**
 * Count the deterministic VM root-bucket seed entities (subject prefix
 * {@link VM_SEED_SUBJECT_PREFIX}) committed into `contextGraphId`'s root content
 * graph. Mirrors the EXACT scope the UI's VM layer query uses (graphs under the
 * CG, excluding `/assertion/`, `/_shared_memory`, `/meta` bookkeeping), so a
 * non-zero result means our VM seed is genuinely visible to the data-driven
 * views — letting global-setup verify the VM seed independently of the named
 * sub-graph sentinel. Throws on a non-OK response (caller decides how to treat).
 */
export async function countSeededVmRootEntities(
  contextGraphId: string,
  nodeNum = 1,
): Promise<number> {
  const cgUri = `did:dkg:context-graph:${contextGraphId}`;
  const sparql = `SELECT (COUNT(DISTINCT ?s) AS ?cnt) WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(
      STRSTARTS(STR(?g), "${cgUri}") &&
      !CONTAINS(STR(?g), "/assertion/") &&
      !CONTAINS(STR(?g), "/_shared_memory") &&
      !CONTAINS(STR(?g), "/meta")
    )
    FILTER(STRSTARTS(STR(?s), "${VM_SEED_SUBJECT_PREFIX}"))
  }`;
  const res = await devnetApiFetch('/api/query', {
    method: 'POST',
    nodeNum,
    body: JSON.stringify({ sparql, contextGraphId, includeContextGraphPartitions: true }),
  });
  if (!res.ok) {
    throw new Error(`countSeededVmRootEntities failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as any;
  const bindings = json?.result?.bindings ?? json?.results?.bindings ?? [];
  const raw = bindings[0]?.cnt;
  const value = typeof raw === 'string' ? raw : raw?.value;
  return Number(value) || 0;
}

/**
 * Register a named sub-graph in `contextGraphId`. Idempotent for our purposes:
 * a duplicate registration just returns the existing one (or a benign error we
 * swallow), so callers can register-then-seed without a pre-check.
 */
export async function createSubGraph(opts: {
  contextGraphId: string;
  subGraphName: string;
  nodeNum?: number;
}): Promise<void> {
  const res = await devnetApiFetch('/api/sub-graph/create', {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
      subGraphName: opts.subGraphName,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Idempotency: the ONLY benign client error is a duplicate registration —
    // the sub-graph already exists, so a register-then-seed caller can proceed.
    // A 409 Conflict or an "already exists/registered" message both signal that.
    // Every OTHER 4xx (invalid `subGraphName`, unknown context graph, malformed
    // body, …) is a genuine setup regression that would leave seedSubgraphEntity()
    // running from a broken precondition — surface it rather than swallow it. 5xx
    // always throws.
    const alreadyExists =
      res.status === 409 || /already\s+(exist|exists|registered|present)/i.test(body);
    if (!alreadyExists) {
      throw new Error(`createSubGraph failed: ${res.status} ${body}`);
    }
  }
}

/** Quads targeting a NAMED sub-graph's data graph (`<cg>/<subGraph>`). */
export function buildSubGraphQuads(
  cgId: string,
  subGraphName: string,
  stamp: number,
  label: string,
): PublishQuads[] {
  const subject = `urn:e2e:ui:sg:${subGraphName}:${stamp}`;
  const graph = `did:dkg:context-graph:${cgId}/${subGraphName}`;
  return [
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
  ];
}

export async function createWmAssertion(opts: {
  contextGraphId: string;
  name: string;
  quads: PublishQuads[];
  promote?: boolean;
  /**
   * Finalize the WM assertion at create time. Defaults to `true` for
   * back-compat with every existing caller. Pass `false` to exercise the
   * rc.17 #1004 path where `promote` auto-finalizes a FULL promote — i.e. the
   * real Node UI journey (write → Promote All → Publish-to-VM) with no explicit
   * finalize step.
   */
  finalize?: boolean;
  subGraphName?: string;
  nodeNum?: number;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await devnetApiFetch('/api/knowledge-assets', {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
      name: opts.name,
      quads: opts.quads,
      finalize: opts.finalize ?? true,
      // rc.17 KA-routes-unification: the inline SWM-promote flag is `alsoShareSwm`
      // (the old `promote` is silently ignored → the assertion never reaches SWM).
      alsoShareSwm: opts.promote ?? false,
      ...(opts.subGraphName ? { subGraphName: opts.subGraphName } : {}),
    }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

export async function promoteAssertion(opts: {
  contextGraphId: string;
  assertionName: string;
  nodeNum?: number;
}): Promise<Response> {
  const encoded = encodeURIComponent(opts.assertionName);
  return devnetApiFetch(`/api/knowledge-assets/${encoded}/swm/share`, {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
    }),
  });
}

export async function publishToVm(opts: {
  contextGraphId: string;
  assertionName: string;
  nodeNum?: number;
  clearAfter?: boolean;
  /**
   * Tolerate a 207 partial publish (SWM/VM landed but the context-graph mirror
   * failed). OFF by default — see the 207 handling below. No current caller
   * needs this; it exists as a deliberate, greppable escape hatch so a future
   * spec that specifically exercises the partial-publish path can opt in rather
   * than silently inheriting it.
   */
  allowPartial?: boolean;
}): Promise<{ httpStatus: number; status?: string; kaId?: string; txHash?: string; contextGraphError?: string }> {
  // LU-5 (OT-RFC-38): the publish-access-policy gate refuses to publish until
  // the CG's curation policy is CHAIN-CONFIRMED. On a freshly-created/registered
  // CG that confirmation lags the registration tx by a few blocks, so the first
  // publish can race ahead and 500 with "publish access-policy is unknown …
  // curated=unknown". That's a transient, not a failure — retry that SPECIFIC
  // error with backoff (the devnet mines ~1 block/s), so the global-setup VM
  // seed (and every other publish caller) waits for the policy instead of
  // flaking. Any other non-ok status still throws immediately.
  const POLICY_CONFIRM_BUDGET_MS = 45_000;
  const policyDeadline = Date.now() + POLICY_CONFIRM_BUDGET_MS;
  let res: Response;
  for (;;) {
    res = await devnetApiFetch('/api/shared-memory/publish', {
      method: 'POST',
      nodeNum: opts.nodeNum ?? 1,
      body: JSON.stringify({
        contextGraphId: opts.contextGraphId,
        assertionName: opts.assertionName,
        clearAfter: opts.clearAfter ?? false,
      }),
    });
    if (res.ok) break;
    const errText = await res.text();
    const policyNotConfirmed =
      res.status === 500 &&
      /publish access-policy is unknown|curated=unknown/i.test(errText);
    if (policyNotConfirmed && Date.now() < policyDeadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }
    throw new Error(`publish failed: ${res.status} ${errText}`);
  }
  const body = (await res.json()) as { status?: string; kaId?: string; txHash?: string; contextGraphError?: string };
  // `res.ok` is true for 207 too. The daemon returns 207 when the SWM/VM publish
  // itself succeeded but the context-graph mirror failed (`contextGraphError`) —
  // a PARTIAL publish. That is exactly the kind of false-green this lane is meant
  // to catch, so REJECT it here by default: a centralized throw protects every
  // caller (the global-setup VM seed, the conviction + messaging specs, …) at
  // once, instead of relying on each one to remember to inspect `httpStatus`.
  // Callers that genuinely want a partial publish pass `allowPartial: true`.
  if (res.status === 207 && !opts.allowPartial) {
    throw new Error(
      `publish partial (HTTP 207) — SWM/VM publish landed but the context-graph ` +
        `mirror failed: ${body.contextGraphError ?? 'unknown contextGraphError'}`,
    );
  }
  return { httpStatus: res.status, ...body };
}

export async function runWmSwmVmPipeline(opts: {
  contextGraphId: string;
  stamp?: number;
  nodeNum?: number;
}): Promise<{ assertionName: string; label: string; kaId?: string; httpStatus?: number; contextGraphError?: string }> {
  const stamp = opts.stamp ?? Date.now();
  const assertionName = `e2e-ui-pipeline-${stamp}`;
  const label = `E2E Pipeline ${stamp}`;
  const quads = buildTestQuads(opts.contextGraphId, stamp, label);

  // Hold the SWM mutation lock across promote→publish so a concurrent
  // `clearAfter: true` from another spec can't wipe this CG's shared memory
  // between our promote and publish (see swm-lock.ts). The WM create is inside
  // the lock too, keeping the assertion's whole WM→SWM→VM lifecycle atomic
  // relative to other mutators.
  return withSwmLock(async () => {
    const wm = await createWmAssertion({
      contextGraphId: opts.contextGraphId,
      name: assertionName,
      quads,
      promote: false,
      nodeNum: opts.nodeNum,
    });
    if (!wm.ok) throw new Error(`WM create failed: ${wm.status} ${wm.body}`);

    const promoteRes = await promoteAssertion({
      contextGraphId: opts.contextGraphId,
      assertionName,
      nodeNum: opts.nodeNum,
    });
    if (!promoteRes.ok) {
      throw new Error(`SWM promote failed: ${promoteRes.status} ${await promoteRes.text()}`);
    }

    const vm = await publishToVm({
      contextGraphId: opts.contextGraphId,
      assertionName,
      nodeNum: opts.nodeNum,
    });

    return { assertionName, label, kaId: vm.kaId, httpStatus: vm.httpStatus, contextGraphError: vm.contextGraphError };
  });
}

export async function registerAgent(nodeNum: number, label: string): Promise<{ agentAddress: string; authToken: string }> {
  const res = await devnetApiFetch('/api/agent/register', {
    method: 'POST',
    nodeNum,
    body: JSON.stringify({ name: `e2e-${label}-${Date.now()}`, framework: 'playwright-e2e' }),
  });
  if (!res.ok) throw new Error(`register agent: ${res.status} ${await res.text()}`);
  return (await res.json()) as { agentAddress: string; authToken: string };
}

export async function addParticipant(cgId: string, agentAddress: string, nodeNum = 1): Promise<Response> {
  return devnetApiFetch(`/api/context-graph/${encodeURIComponent(cgId)}/add-participant`, {
    method: 'POST',
    nodeNum,
    body: JSON.stringify({ agentAddress }),
  });
}

export function devnetNodeHome(num: number): string | null {
  return readDevnetNode(num)?.home ?? null;
}
