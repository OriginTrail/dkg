// Seller-side lane executor: polls the seller's OWN node for lane requests
// arriving over SWM gossip, replays each against the seller's own loopback
// front (the reviewed HTTP surface — auth, metering, signing all unchanged),
// and publishes the response as an immutable KA the buyer's node will gossip
// back. Processed-id set is durable (jsonl) so a daemon restart cannot
// double-serve a request — and the front's own nonce burn makes replays
// harmless even if this file is lost.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nodeCaller, pollLaneRequests, publishLaneMessage, type LaneRequest } from "./swm-lane.js";

export interface LaneExecutorOpts {
  home: string;                 // marketplace namespace (processed-id store)
  nodeBase: string;             // OWN node, loopback
  nodeToken: string;
  contextGraphId: string;
  basePath: string;             // front mount, e.g. /marketplace
  pollMs: number;
  log: (line: string) => void;
}

const processedPath = (home: string) => join(home, "lane-processed.jsonl");

function loadProcessed(home: string): Set<string> {
  const p = processedPath(home);
  if (!existsSync(p)) return new Set();
  return new Set(readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return String((JSON.parse(l) as { id: string }).id); } catch { return ""; }
  }).filter(Boolean));
}

function markProcessed(home: string, id: string): void {
  const p = processedPath(home);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ id, at: new Date().toISOString() }) + "\n");
}

export function startLaneExecutor(opts: LaneExecutorOpts): { stop: () => void } {
  const call = nodeCaller(opts.nodeBase, opts.nodeToken);
  const processed = loadProcessed(opts.home);
  let running = false;
  let stopped = false;

  const serveOne = async (req: LaneRequest): Promise<void> => {
    // Replay against our own front EXACTLY as the buyer signed it: same method,
    // same path, same body bytes (base64-decoded), same x-nsm-* headers.
    const body = Buffer.from(req.bodyB64, "base64");
    const res = await fetch(opts.nodeBase + opts.basePath + req.path, {
      method: req.method,
      headers: { "content-type": "application/json", ...req.headers },
      ...(req.method === "GET" ? {} : { body }),
      signal: AbortSignal.timeout(300_000),
    });
    const resBody = Buffer.from(await res.arrayBuffer());
    await publishLaneMessage(call, opts.contextGraphId, {
      kind: "response",
      res: { correlation: req.id, status: res.status, bodyB64: resBody.toString("base64"), at: new Date().toISOString() },
    });
    opts.log(`lane served ${req.method} ${req.path} → ${res.status} (id ${req.id})`);
  };

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const reqs = await pollLaneRequests(call, opts.contextGraphId);
      for (const r of reqs) {
        if (processed.has(r.id)) continue;
        processed.add(r.id);
        markProcessed(opts.home, r.id);   // mark BEFORE serving: a crash mid-serve
        // must not double-serve — the buyer retries with a fresh id if needed,
        // and the front's nonce burn refuses a byte-replay anyway.
        try { await serveOne(r); } catch (e) {
          opts.log(`lane serve failed for ${r.id}: ${String((e as Error).message).slice(0, 120)}`);
        }
      }
    } catch (e) {
      opts.log(`lane poll failed: ${String((e as Error).message).slice(0, 120)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, opts.pollMs);
  timer.unref?.();
  void tick();
  opts.log(`lane executor started (cg=${opts.contextGraphId}, poll=${opts.pollMs}ms)`);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
