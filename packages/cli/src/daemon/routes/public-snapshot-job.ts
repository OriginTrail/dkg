import { normalizePublicSnapshotSyncOptions } from '@origintrail-official/dkg-agent';
// SPDX-License-Identifier: Apache-2.0
import { readBody, jsonResponse, isPayloadTooLargeError } from "../http-utils.js";
import { createSnapshotJobTracker } from './snapshot-job-tracker.js';
import type {
  DKGAgent,
} from "@origintrail-official/dkg-agent";
import type { RequestContext } from "./context.js";

type WithoutSignal<T> = T extends unknown ? Omit<T, 'signal'> : never;
const jobs = createSnapshotJobTracker<Awaited<ReturnType<DKGAgent['syncPublicGraphSnapshot']>>,
  { request: WithoutSignal<ReturnType<typeof normalizePublicSnapshotSyncOptions>> }, { finishedAt: number }>(
  () => ({ finishedAt: Date.now() }));
/** The parent route enforces node-admin authorization for both start and status. */
export async function handlePublicSnapshotJob({
  req,
  res,
  agent,
}: RequestContext): Promise<void> {
  const reply = (status: number, body: unknown) => {
    jsonResponse(res, status, body);
  };
  if (req.method === "GET") {
    reply(200, { ...(jobs.get(agent) ?? { state: "idle" }),
      capabilities: { sourcePolicies: agent.getPublicSnapshotSourcePolicies() } });
    return;
  }
  if (req.method !== "POST") {
    reply(405, { error: "Method not allowed" });
    return;
  }
  if (jobs.isRunning(agent)) {
    reply(409, { error: "Snapshot recovery already running" });
    return;
  }
  let input: ReturnType<typeof normalizePublicSnapshotSyncOptions>;
  try {
    const raw: unknown = JSON.parse(await readBody(req, 4096));
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.keys(raw).some(
        (k) =>
          ![
            "contextGraphId",
            "onChainId",
            "trustedCorePeerIds",
            "mode",
            "transport",
            "sourcePolicy",
          ].includes(k),
      )
    )
      throw new Error("Invalid request");
    input = normalizePublicSnapshotSyncOptions(raw);
  } catch (error) {
    if (isPayloadTooLargeError(error)) { reply(413, { error: "Request too large" }); return; }
    reply(400, { error: "Invalid snapshot recovery request" });
    return;
  }
  const job = jobs.start(agent, {
    request: {
      contextGraphId: input.contextGraphId,
      onChainId: input.onChainId,
      mode: input.mode,
      transport: input.transport,
      ...(input.sourcePolicy
        ? { sourcePolicy: input.sourcePolicy, trustedCorePeerIds: [] as const }
        : { trustedCorePeerIds: [...input.trustedCorePeerIds] }),
    },
  }, () => agent.syncPublicGraphSnapshot(input));
  if (!job) { reply(409, { error: "Snapshot recovery already running" }); return; }
  reply(202, job);
}
