// V2 Stage-3 — HTTP wiring for the provider endpoint.
//
// Buyer-found defect (Hermes/Bo, 2026-08-06): the Stage-3 surfaces existed as
// module functions with passing unit gates but were never registered on the
// HTTP router, so a real buyer making a real request got 404. Unit gates green
// is not the same claim as "the endpoint is live"; this module is the missing
// half, and every route below is exercised over real HTTP in the gate suite.
//
//   GET  /api/metering/terms       quote BEFORE any commitment (D10/D13)
//   POST /api/metering/handshake   zero-value capability preflight
//   POST /api/metering/tab/open    register opening artifact + delegation
//   GET  /api/metering/tab         balance, sequence, expiry, chain head
//
// Fail-closed rules preserved from stage3-endpoint.ts:
//  * nothing here can bill — settlement still requires the buyer's per-leg
//    countersignature (D14), and shadow mode ignores enforcement entirely;
//  * the handshake never touches a ledger (`ledgerTouched: false`);
//  * a malformed body is a 400, never a partially-applied state change.
import type { RequestContext } from "./context.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "../http-utils.js";
import { createHash } from "node:crypto";
import { canonicalize, loadMeterConfig } from "../metering/ledger.js";
import { COEFFICIENTS_CANONICAL, SCHEDULE_VERSION } from "../metering/read-meter.js";
import {
  termsQuote, handshake, openTab, tabView, creditObservedDeposit,
} from "../metering/stage3-endpoint.js";

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");

const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

/** The provider wallet this node deposits to. Read-only; never a key. */
function providerAddress(ctx: RequestContext): string {
  const w = ctx.opWallets as unknown as Record<string, { address?: string }>;
  return w?.publisher?.address ?? w?.operational?.address ?? "0x0000000000000000000000000000000000000000";
}

/** Safe head = latest - confirmationDepth. Null when the chain is unreachable. */
async function safeHead(ctx: RequestContext): Promise<number | null> {
  try {
    const p = (ctx.agent as unknown as { provider?: { getBlockNumber?: () => Promise<number> } }).provider;
    if (!p?.getBlockNumber) return null;
    return await p.getBlockNumber();
  } catch { return null; }
}

export async function handleMeteringRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, requestAgentAddress } = ctx;
  if (!path.startsWith("/api/metering/")) return;

  const home = meterHome();
  const cfg = loadMeterConfig(home);
  const coefficientsDigest = sha256(canonicalize(COEFFICIENTS_CANONICAL as unknown as Record<string, unknown>));

  // ── GET /api/metering/terms ────────────────────────────────────────────
  // Priced and verifiable before the buyer commits to anything at all.
  if (req.method === "GET" && path === "/api/metering/terms") {
    return jsonResponse(res, 200, termsQuote({
      providerAddress: providerAddress(ctx),
      refundAddressHint: typeof ctx.url.searchParams.get("refundAddress") === "string"
        ? ctx.url.searchParams.get("refundAddress")! : undefined,
      askMicroPer1k: cfg.readAskMicroPer1k,
      scheduleVersion: SCHEDULE_VERSION,
      coefficientsDigest,
      meterMode: cfg.mode,
      safeHeadBlock: await safeHead(ctx),
    }));
  }

  // ── POST /api/metering/handshake ───────────────────────────────────────
  // Zero-value preflight. No funded tab, no ledger write, no charge.
  if (req.method === "POST" && path === "/api/metering/handshake") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req, SMALL_BODY_BYTES) || "{}"); }
    catch { return jsonResponse(res, 400, { error: "E_BAD_JSON" }); }
    const { delegation, walletPublicKeyPem, request, revocationCheckpoint } = body as Record<string, any>;
    if (!delegation || !walletPublicKeyPem || !request) {
      return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["delegation", "walletPublicKeyPem", "request"] });
    }
    try {
      const out = handshake(home, {
        delegation, walletPublicKeyPem, request,
        revocationCheckpoint: revocationCheckpoint ?? { observedAt: null, maxCheckpointAgeMs: 0 },
      });
      // A rejected preflight is a successful preflight: 200 with a stable
      // reason code, so the buyer can assert on codes rather than parse prose.
      return jsonResponse(res, 200, out);
    } catch (e: unknown) {
      return jsonResponse(res, 400, { error: "E_PREFLIGHT", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ── POST /api/metering/tab/open ────────────────────────────────────────
  if (req.method === "POST" && path === "/api/metering/tab/open") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req, SMALL_BODY_BYTES) || "{}"); }
    catch { return jsonResponse(res, 400, { error: "E_BAD_JSON" }); }
    const b = body as Record<string, any>;
    if (!b.delegation || !b.walletPublicKeyPem || !b.refundAddress || !b.request) {
      return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["delegation", "walletPublicKeyPem", "refundAddress", "request"] });
    }
    try {
      const out = openTab(home, {
        delegation: b.delegation,
        walletPublicKeyPem: b.walletPublicKeyPem,
        refundAddress: b.refundAddress,
        providerAddress: providerAddress(ctx),
        askMicroPer1k: cfg.readAskMicroPer1k,
        scheduleVersion: SCHEDULE_VERSION,
        request: b.request,
        revocationCheckpoint: b.revocationCheckpoint ?? { observedAt: null, maxCheckpointAgeMs: 0 },
      });
      return jsonResponse(res, out.opened ? 200 : 403, out);
    } catch (e: unknown) {
      return jsonResponse(res, 400, { error: "E_OPEN_TAB", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // ── GET /api/metering/tab ──────────────────────────────────────────────
  if (req.method === "GET" && path === "/api/metering/tab") {
    const principal = ctx.url.searchParams.get("principal") ?? requestAgentAddress;
    if (!principal) return jsonResponse(res, 400, { error: "E_NO_PRINCIPAL" });
    return jsonResponse(res, 200, tabView(home, principal, await safeHead(ctx)));
  }

  // ── POST /api/metering/tab/credit ──────────────────────────────────────
  // Operator-only: hand the node an OBSERVED on-chain transfer. Every
  // buyer-set rule (confirmations, sender, minimum, open tab) is re-checked
  // inside creditObservedDeposit — this route cannot bypass any of them.
  if (req.method === "POST" && path === "/api/metering/tab/credit") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req, SMALL_BODY_BYTES) || "{}"); }
    catch { return jsonResponse(res, 400, { error: "E_BAD_JSON" }); }
    const b = body as Record<string, any>;
    if (!b.principal || !b.transfer) {
      return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["principal", "transfer"] });
    }
    // A malformed transfer must be REFUSED, not thrown: an unhandled throw here
    // surfaces as a 500 with a stack trace, which is both an information leak
    // and an ambiguous answer to "was I credited?". Validate the shape first.
    const need = ["txHash", "from", "to", "token", "amountTrac", "blockNumber", "safeHeadBlock"];
    const missing = need.filter((k) => b.transfer[k] === undefined || b.transfer[k] === null);
    if (missing.length) {
      return jsonResponse(res, 400, { error: "E_MALFORMED_TRANSFER", missing });
    }
    if (!Number.isFinite(b.transfer.blockNumber) || !Number.isFinite(b.transfer.safeHeadBlock)) {
      return jsonResponse(res, 400, { error: "E_MALFORMED_TRANSFER", detail: "block numbers must be finite" });
    }
    try {
      const out = creditObservedDeposit(home, b.principal, b.transfer);
      return jsonResponse(res, out.credited ? 200 : 403, out);
    } catch (e: unknown) {
      return jsonResponse(res, 400, { error: "E_CREDIT", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  // Default-deny: an unknown /api/metering/* path is a 404, not a fallthrough
  // into some other route module's namespace.
  return jsonResponse(res, 404, { error: "E_UNKNOWN_METERING_ROUTE", path });
}
