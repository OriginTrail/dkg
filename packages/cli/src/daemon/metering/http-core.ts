// V2 Stage-3 — the metering endpoint's testable core.
//
// Buyer-found (Hermes/Bo, 2026-08-06): the previous archive could not be
// executed because routes/metering.ts imports the daemon's http-utils, which
// transitively drags in chain ABIs and websocket transports — bundling it
// standalone was impossible, so 84 of 100 gates were unreproducible.
//
// The security-relevant logic does not need any of that. It needs to read a
// body, write JSON, and decide. So the decisions live HERE, dependency-light
// and bundleable, with I/O injected; routes/metering.ts is a thin adapter that
// passes the daemon's real helpers. The core is what the gates exercise, and
// the core is what carries every fail-closed rule.
import { createHash } from "node:crypto";
import { canonicalize, loadMeterConfig } from "./ledger.js";
import { COEFFICIENTS_CANONICAL, SCHEDULE_VERSION } from "./read-meter.js";
import {
  termsQuote, handshake, openTab, tabView, creditObservedDeposit,
} from "./stage3-endpoint.js";
import { anchorWalletKey } from "./buyer-registry.js";

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");

/** Everything the core needs from the outside world. */
export interface MeteringIo {
  /** Send a JSON response. */
  json(status: number, body: unknown): void;
  /** Read the request body as text (bounded). */
  readBody(): Promise<string>;
}

export interface MeteringRequest {
  method: string;
  path: string;
  searchParams: URLSearchParams;
  /**
   * Provider wallet address advertised in the quote, or null when the node
   * cannot resolve one. Null is never substituted with a placeholder: telling a
   * buyer to send TRAC to 0x0 is worse than refusing to quote.
   */
  providerAddress: string | null;
  /** Caller identity resolved by the daemon, if any. */
  requestAgentAddress?: string;
  /** Observed safe head, or null when the chain is unreachable. */
  safeHeadBlock: number | null;
  /** Metering home (DKG_HOME). */
  home: string;
  /**
   * EVM chain id, so a testnet binding proof cannot authorise mainnet.
   * Null when unresolvable — the node then refuses to serve rather than
   * comparing against NaN, which fails every proof with a baffling message.
   */
  chainId: number | null;
}

/**
 * Returns true when this request was handled. A false return means the path is
 * not ours and the caller should continue its dispatch chain.
 */
export async function handleMetering(req: MeteringRequest, io: MeteringIo): Promise<boolean> {
  const { path, method, home } = req;
  if (!path.startsWith("/api/metering/")) return false;

  const cfg = loadMeterConfig(home);

  // Fail closed on chain identity. A node that cannot say which chain it is on
  // must not verify a proof that names one. (Buyer-found: this compared against
  // NaN and rejected every valid proof.)
  if (req.chainId === null || !Number.isFinite(req.chainId)) {
    io.json(503, {
      error: "E_CHAIN_UNRESOLVED",
      detail: "This node cannot resolve its own EVM chain id, so it will not verify wallet bindings or quote terms.",
    });
    return true;
  }

  // Fail closed on the money question. Every route below either advertises the
  // deposit address or binds a delegation to it, so a node that cannot name its
  // own wallet must not serve any of them.
  if (!req.providerAddress || /^0x0+$/i.test(req.providerAddress)) {
    io.json(503, {
      error: "E_NO_PROVIDER_WALLET",
      detail: "This node cannot resolve its provider wallet, so it will not quote, open a tab, or accept a deposit.",
    });
    return true;
  }

  const coefficientsDigest = sha256(canonicalize(COEFFICIENTS_CANONICAL as unknown as Record<string, unknown>));

  // ── GET /api/metering/terms ────────────────────────────────────────────
  // Priced and verifiable before the buyer commits to anything at all.
  if (method === "GET" && path === "/api/metering/terms") {
    io.json(200, termsQuote({
      providerAddress: req.providerAddress,
      refundAddressHint: req.searchParams.get("refundAddress") ?? undefined,
      askMicroPer1k: cfg.readAskMicroPer1k,
      scheduleVersion: SCHEDULE_VERSION,
      coefficientsDigest,
      meterMode: cfg.mode,
      safeHeadBlock: req.safeHeadBlock,
      chainId: req.chainId,
    }));
    return true;
  }

  // ── POST /api/metering/handshake ───────────────────────────────────────
  // Zero-value preflight. No funded tab, no ledger write, no charge.
  if (method === "POST" && path === "/api/metering/handshake") {
    let body: Record<string, any>;
    try { body = JSON.parse((await io.readBody()) || "{}"); }
    catch { io.json(400, { error: "E_BAD_JSON" }); return true; }
    const { delegation, request, revocationCheckpoint } = body;
    if (!delegation || !request) {
      io.json(400, { error: "E_MISSING_FIELD", required: ["delegation", "request"] });
      return true;
    }
    // The key is resolved from operator-approved config, NOT from the request.
    // A caller cannot supply the evidence that validates its own claim.
    const anchor = anchorWalletKey(home, delegation.tabPrincipal, { proof: body.bindingProof, chainId: req.chainId });
    if (!anchor.ok) {
      // Surface the SPECIFIC binding failure as the verdict when a proof was
      // presented, so callers can branch on it. Safe because binding checks
      // never consult the registry and so cannot reveal registration state.
      io.json(200, {
        preflight: "zero-value", estimatedMicroTrac: 0,
        verdict: anchor.bindingCode ?? anchor.code,
        anchorCode: anchor.code,
        ok: false, ledgerTouched: false,
        capabilityId: delegation.capabilityId ?? null, detail: anchor.detail,
      });
      return true;
    }
    try {
      // A rejected preflight is a SUCCESSFUL preflight: 200 with a stable
      // reason code, so the buyer asserts on codes rather than parsing prose.
      io.json(200, handshake(home, {
        delegation, walletPublicKeyPem: anchor.walletPublicKeyPem, request,
        revocationCheckpoint: revocationCheckpoint ?? { observedAt: null, maxCheckpointAgeMs: 0 },
      }));
    } catch (e: unknown) {
      io.json(400, { error: "E_PREFLIGHT", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    return true;
  }

  // ── POST /api/metering/tab/open ────────────────────────────────────────
  if (method === "POST" && path === "/api/metering/tab/open") {
    let b: Record<string, any>;
    try { b = JSON.parse((await io.readBody()) || "{}"); }
    catch { io.json(400, { error: "E_BAD_JSON" }); return true; }
    if (!b.delegation || !b.refundAddress || !b.request) {
      io.json(400, { error: "E_MISSING_FIELD", required: ["delegation", "refundAddress", "request"] });
      return true;
    }
    const openAnchor = anchorWalletKey(home, b.delegation.tabPrincipal, { proof: b.bindingProof, chainId: req.chainId });
    if (!openAnchor.ok) {
      io.json(403, { opened: false, code: openAnchor.bindingCode ?? openAnchor.code, anchorCode: openAnchor.code, detail: openAnchor.detail });
      return true;
    }
    try {
      const out = openTab(home, {
        delegation: b.delegation,
        walletPublicKeyPem: openAnchor.walletPublicKeyPem,
        refundAddress: b.refundAddress,
        providerAddress: req.providerAddress,
        askMicroPer1k: cfg.readAskMicroPer1k,
        scheduleVersion: SCHEDULE_VERSION,
        request: b.request,
        revocationCheckpoint: b.revocationCheckpoint ?? { observedAt: null, maxCheckpointAgeMs: 0 },
      });
      io.json(out.opened ? 200 : 403, out);
    } catch (e: unknown) {
      io.json(400, { error: "E_OPEN_TAB", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    return true;
  }

  // ── GET /api/metering/tab ──────────────────────────────────────────────
  if (method === "GET" && path === "/api/metering/tab") {
    const principal = req.searchParams.get("principal") ?? req.requestAgentAddress;
    if (!principal) { io.json(400, { error: "E_NO_PRINCIPAL" }); return true; }
    io.json(200, tabView(home, principal, req.safeHeadBlock));
    return true;
  }

  // ── POST /api/metering/tab/credit ──────────────────────────────────────
  // Operator-only: hand the node an OBSERVED on-chain transfer. Every
  // buyer-set rule (confirmations, sender, minimum, open tab) is re-checked
  // inside creditObservedDeposit — this route cannot bypass any of them.
  if (method === "POST" && path === "/api/metering/tab/credit") {
    let b: Record<string, any>;
    try { b = JSON.parse((await io.readBody()) || "{}"); }
    catch { io.json(400, { error: "E_BAD_JSON" }); return true; }
    if (!b.principal || !b.transfer) {
      io.json(400, { error: "E_MISSING_FIELD", required: ["principal", "transfer"] });
      return true;
    }
    // A malformed transfer must be REFUSED, not thrown: an unhandled throw
    // surfaces as a 500 with a stack trace, which is both an information leak
    // and an ambiguous answer to "was I credited?". Validate the shape first.
    const need = ["txHash", "from", "to", "token", "amountTrac", "blockNumber", "safeHeadBlock"];
    const missing = need.filter((k) => b.transfer[k] === undefined || b.transfer[k] === null);
    if (missing.length) { io.json(400, { error: "E_MALFORMED_TRANSFER", missing }); return true; }
    if (!Number.isFinite(b.transfer.blockNumber) || !Number.isFinite(b.transfer.safeHeadBlock)) {
      io.json(400, { error: "E_MALFORMED_TRANSFER", detail: "block numbers must be finite" });
      return true;
    }
    try {
      const out = creditObservedDeposit(home, b.principal, b.transfer);
      io.json(out.credited ? 200 : 403, out);
    } catch (e: unknown) {
      io.json(400, { error: "E_CREDIT", detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    return true;
  }

  // Default-deny: an unknown /api/metering/* path is a 404, not a fallthrough
  // into some other route module's namespace.
  io.json(404, { error: "E_UNKNOWN_METERING_ROUTE", path });
  return true;
}
