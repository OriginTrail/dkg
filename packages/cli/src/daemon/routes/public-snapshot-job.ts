// SPDX-License-Identifier: Apache-2.0
import { readBody, jsonResponse, isPayloadTooLargeError } from "../http-utils.js";
import { randomUUID } from "node:crypto";
import type {
  DKGAgent,
  PublicSnapshotSyncOptions,
} from "@origintrail-official/dkg-agent";
import type { RequestContext } from "./context.js";

interface Job {
  id: string;
  request: {
    contextGraphId: string;
    onChainId: string;
    mode: string;
    trustedCorePeerIds: readonly string[];
  };
  state: "running" | "complete" | "failed";
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
}
const jobs = new WeakMap<DKGAgent, Job>();
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
    reply(200, jobs.get(agent) ?? { state: "idle" });
    return;
  }
  if (req.method !== "POST") {
    reply(405, { error: "Method not allowed" });
    return;
  }
  if (jobs.get(agent)?.state === "running") {
    reply(409, { error: "Snapshot recovery already running" });
    return;
  }
  let input: PublicSnapshotSyncOptions;
  try {
    input = JSON.parse(await readBody(req, 4096));
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).some(
        (k) =>
          ![
            "contextGraphId",
            "onChainId",
            "trustedCorePeerIds",
            "mode",
          ].includes(k),
      ) ||
      typeof input.contextGraphId !== "string" ||
      typeof input.onChainId !== "string" ||
      !Array.isArray(input.trustedCorePeerIds) ||
      input.trustedCorePeerIds.length < 1 ||
      input.trustedCorePeerIds.length > 4 ||
      input.trustedCorePeerIds.some(
        (p) => typeof p !== "string" || !p || p.length > 256,
      ) ||
      ![undefined, "core-cache", "rpc-only"].includes(input.mode) ||
      !/^[1-9][0-9]{0,77}$/.test(input.onChainId)
    )
      throw new Error("Invalid request");
  } catch (error) {
    if (isPayloadTooLargeError(error)) { reply(413, { error: "Request too large" }); return; }
    reply(400, { error: "Invalid snapshot recovery request" });
    return;
  }
  if (jobs.get(agent)?.state === "running") {
    reply(409, { error: "Snapshot recovery already running" });
    return;
  }
  const job: Job = {
    request: {
      contextGraphId: input.contextGraphId,
      onChainId: input.onChainId,
      mode: input.mode ?? "core-cache",
      trustedCorePeerIds: [...input.trustedCorePeerIds],
    },
    id: randomUUID(),
    state: "running",
    startedAt: Date.now(),
  };
  jobs.set(agent, job);
  void agent
    .syncPublicGraphSnapshot(input)
    .then(
      (result) => {
        job.result = result;
        job.state = "complete";
      },
      (error) => {
        job.error = error instanceof Error ? error.message : String(error);
        job.state = "failed";
      },
    )
    .finally(() => {
      job.finishedAt = Date.now();
    });
  reply(202, job);
}
