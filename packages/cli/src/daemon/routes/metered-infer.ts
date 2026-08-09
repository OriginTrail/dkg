// V2 — POST /api/metering/infer : thin adapter over metering/infer-http-core.
//
// Every decision lives in the core so a buyer can execute it standalone (this
// file's http-utils import drags in rdf-canonize, chain ABIs and websocket
// transports — the exact reason an earlier archive was unrunnable). The adapter
// does three things: resolve the chain id, hand the core a body reader and a
// JSON writer, and stay out of the way.
import type { RequestContext } from "./context.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "../http-utils.js";
import { handleInfer } from "../metering/infer-http-core.js";
import { chainIdOf } from "./metering.js";

const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

export {
  setInferenceBackend, inferenceBackendConfigured,
  type InferenceBackend,
} from "../metering/infer-http-core.js";

export async function handleMeteredInferRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (path !== "/api/metering/infer" && path !== "/api/metering/build") return;

  await handleInfer(
    { method: req.method ?? "GET", path, chainId: chainIdOf(ctx), home: meterHome() },
    {
      json: (status, body) => jsonResponse(res, status, body as Record<string, unknown>),
      readBody: () => readBody(req, SMALL_BODY_BYTES),
    },
  );
}
