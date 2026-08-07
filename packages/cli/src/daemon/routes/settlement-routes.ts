// V2-B5 — settlement HTTP surface.
//
// Split by trust, like every other route here:
//   GET  /api/metering/close   buyer-facing, READ-ONLY. Builds and returns the
//                              provider-signed close statement from the tab's
//                              journalled legs. Reachable through the front —
//                              it moves no money and reveals only the buyer's
//                              own legs.
//   POST /api/metering/withdraw/{prepare,sign,confirm}  OPERATOR-ONLY, loopback.
//                              These drive the withdrawal state machine and
//                              precede an on-chain transfer, so they are NOT on
//                              the front allowlist — same posture as tab/credit.
import type { RequestContext } from "./context.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "../http-utils.js";
import { createHash } from "node:crypto";
import { loadMeterConfig, readJournal, providerPublicPem, canonicalize } from "../metering/ledger.js";
import {
  buildCloseStatement, prepareWithdrawal, recordSignedWithdrawal, confirmWithdrawal,
  replayWithdrawals, type CloseLeg,
} from "../metering/settlement.js";
import { activeOpening } from "../metering/deposit-rail.js";
import { chainIdOf } from "./metering.js";

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");
const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

function providerAddress(ctx: RequestContext): string | null {
  const w = ctx.opWallets as unknown as { wallets?: Array<{ address?: string }> };
  const a = w?.wallets?.[0]?.address;
  return !a || /^0x0+$/i.test(a) ? null : a;
}

/**
 * Reconstruct the tab's legs for a close statement from the journal. An
 * accepted leg is a debit with a matching leg-countersigned record; a debit
 * without one is disputed/unsettled (Q3) — its value is NOT charged. The
 * completeness boundary comes from the leg sequences themselves.
 */
function legsForClose(home: string, principal: string): { legs: CloseLeg[]; deposit: { txHash: string; blockNumber: number; amountMicroTrac: number } | null } {
  const p = principal.toLowerCase();
  const signed = new Map<string, string>();
  let deposit: { txHash: string; blockNumber: number; amountMicroTrac: number } | null = null;
  for (const rec of readJournal(home)) {
    if (rec.kind === "leg-countersigned" && String(rec.principal ?? "").toLowerCase() === p) {
      signed.set(String(rec.legId), String(rec.countersignature));
    }
    if (rec.kind === "credit" && String(rec.principal ?? "").toLowerCase() === p) {
      const e = rec.evidence as Record<string, unknown> | undefined;
      if (e?.txHash) deposit = { txHash: String(e.txHash), blockNumber: Number(e.blockNumber ?? 0), amountMicroTrac: Number(rec.amountMicroTrac ?? 0) };
    }
  }
  const legs: CloseLeg[] = [];
  for (const rec of readJournal(home)) {
    if (rec.kind !== "debit") continue;
    const leg = rec.leg as Record<string, any>;
    if (String(leg?.requester?.principal ?? "").toLowerCase() !== p) continue;
    const legId = String(leg.legId);
    const cs = signed.get(legId);
    legs.push({
      legHash: String(rec.hash),
      sequence: Number(leg.sequence),
      previousLegHash: String(leg.previousLegHash),
      costMicroTrac: Number(leg.pricing?.costMicroTrac ?? 0),
      status: cs ? "accepted" : "disputed",
      ...(cs ? { countersignature: cs } : {}),
    });
  }
  return { legs, deposit };
}

export async function handleSettlementRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (!path.startsWith("/api/metering/close") && !path.startsWith("/api/metering/withdraw")) return;
  const home = meterHome();

  // ── GET /api/metering/close?principal=… — buyer-facing, read-only ────────
  if (req.method === "GET" && path === "/api/metering/close") {
    const principal = ctx.url.searchParams.get("principal") ?? ctx.requestAgentAddress;
    if (!principal) return jsonResponse(res, 400, { error: "E_NO_PRINCIPAL" });
    const provider = providerAddress(ctx);
    if (!provider) return jsonResponse(res, 503, { error: "E_NO_PROVIDER_WALLET" });
    const { legs, deposit } = legsForClose(home, principal);
    if (!deposit) return jsonResponse(res, 404, { error: "E_NO_DEPOSIT", detail: "no credited deposit for this principal to close against" });
    const artifact = activeOpening(home, principal);
    const cfg = loadMeterConfig(home);
    const chainId = chainIdOf(ctx) ?? 8453;
    const built = buildCloseStatement(home, {
      chain: `eip155:${chainId}`,
      tracContract: "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23",
      providerAddress: provider,
      tabPrincipal: principal,
      tabEpoch: artifact?.expiresAt ?? "closed",
      priorDeposit: deposit,
      legs,
      destination: artifact?.terms?.refundAddress ?? principal,
    });
    return jsonResponse(res, 200, {
      statement: built.statement,
      digest: built.digest,
      providerSignature: built.providerSignature,
      providerPublicKeyPem: providerPublicPem(home),
      meterMode: cfg.mode,
      note: "Verify this yourself: recompute the sums, match the accepted set against your own countersigned legs, check the close-sequence boundary, then verify the provider signature. Do not trust these numbers — reproduce them.",
    });
  }

  // ── POST /api/metering/withdraw/* — operator-only, loopback ──────────────
  // Reached only on the loopback port; the front does not expose these.
  let body: Record<string, any>;
  try { body = JSON.parse((await readBody(req, SMALL_BODY_BYTES)) || "{}"); }
  catch { return jsonResponse(res, 400, { error: "E_BAD_JSON" }); }

  if (req.method === "POST" && path === "/api/metering/withdraw/prepare") {
    if (!body.withdrawalId || !body.statementDigest || body.amountMicroTrac === undefined || !body.destination) {
      return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["withdrawalId", "statementDigest", "amountMicroTrac", "destination"] });
    }
    const out = prepareWithdrawal(home, {
      withdrawalId: body.withdrawalId, statementDigest: body.statementDigest,
      amountMicroTrac: Number(body.amountMicroTrac), destination: body.destination,
      chainId: chainIdOf(ctx) ?? 8453,
    });
    return jsonResponse(res, 200, out);
  }

  if (req.method === "POST" && path === "/api/metering/withdraw/sign") {
    if (!body.withdrawalId || !body.sender || body.accountNonce === undefined || !body.txHash) {
      return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["withdrawalId", "sender", "accountNonce", "txHash"] });
    }
    return jsonResponse(res, 200, recordSignedWithdrawal(home, {
      withdrawalId: body.withdrawalId, sender: body.sender, accountNonce: Number(body.accountNonce), txHash: body.txHash,
    }));
  }

  if (req.method === "POST" && path === "/api/metering/withdraw/confirm") {
    if (!body.withdrawalId || !body.receipt) {
      return jsonResponse(res, 400, { error: "E_MISSING_FIELD", required: ["withdrawalId", "receipt"] });
    }
    const out = confirmWithdrawal(home, {
      withdrawalId: body.withdrawalId,
      receipt: {
        txHash: String(body.receipt.txHash), to: String(body.receipt.to),
        amountMicroTrac: Number(body.receipt.amountMicroTrac),
        success: !!body.receipt.success, confirmations: Number(body.receipt.confirmations ?? 0),
      },
      requiredConfirmations: Number(body.requiredConfirmations ?? 12),
    });
    return jsonResponse(res, out.ok ? 200 : 409, out);
  }

  if (req.method === "GET" && path === "/api/metering/withdraw") {
    const id = ctx.url.searchParams.get("withdrawalId");
    const all = [...replayWithdrawals(home).values()];
    return jsonResponse(res, 200, id ? (all.find((w) => w.withdrawalId === id) ?? { error: "E_UNKNOWN" }) : all);
  }

  return jsonResponse(res, 404, { error: "E_UNKNOWN_SETTLEMENT_ROUTE", path });
}
