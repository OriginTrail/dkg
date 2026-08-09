// V2 Stage-3 — provider endpoint: the surface a real buyer talks to.
//
// Four routes, all loopback/tailnet-fronted, all fail-closed:
//   GET  /api/metering/terms       quote BEFORE any commitment (D10/D13)
//   POST /api/metering/handshake   zero-value capability preflight (OpenClaw)
//   POST /api/metering/tab/open    register an opening artifact + delegation
//   GET  /api/metering/tab         balance, sequence, expiry, chain head
//
// Design rules carried from the ratified log:
//  D14  the delegation is verified here, but ADMISSION for settlement still
//       requires the buyer's countersignature on each leg — this endpoint
//       cannot grant spending rights the buyer did not sign for;
//  D10  terms are the buyer-set ones; the opening artifact echoes the LOCKED
//       refund address and carries the terms digest;
//  C.3  nothing here can bill: enforcement remains per-principal in the
//       meter config, and shadow mode ignores all of it.
import { createHash } from "node:crypto";
import { canonicalize, balance, credit, settlementOf } from "./ledger.js";
import {
  buildOpeningArtifact, registerOpening, activeOpening, evaluateDeposit,
  creditDeposit, termsDigest, type TabTerms, type ObservedTransfer,
} from "./deposit-rail.js";
import { verifyCapability, zeroValuePreflight, type SignedDelegation, type CapabilityState } from "./capability.js";
import { MAX_BINDING_LIFETIME_MS, BINDING_DOMAIN } from "./evm-binding.js";
import { CAPABILITY_DOMAIN } from "./capability.js";

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");

/** Buyer-set terms (decision KA d10-tab-terms). Provider does not get to soften these. */
export function stage3Terms(providerAddress: string, refundAddress: string, askMicroPer1k: number, scheduleVersion: string, chainId = 8453): TabTerms {
  return {
    termsVersion: "tab-terms/v1",
    // Derived from the SAME resolved chain id the binding verifier uses.
    // Buyer-found: this was a hardcoded "base:8453" while verification read the
    // config, so the advertised chain and the enforced chain could disagree —
    // and did. Advertise what you enforce, from one source.
    chain: `eip155:${chainId}`,
    tracContract: "0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23",
    providerAddress,
    refundAddress,
    confirmationDepth: 12,          // safe head, buyer-set
    minimumCreditTrac: "1",
    expiryMs: 30 * 60 * 1000,
    rolloverPolicy: "none",
    refundOnExpiry: true,
    askMicroPer1k,
    scheduleVersion,
  };
}

const capStates = new Map<string, Map<string, CapabilityState>>();
const delegations = new Map<string, Map<string, SignedDelegation>>();
const freshState = (): CapabilityState => ({ spentMicroTrac: 0, window: { since: Date.now(), spentMicroTrac: 0 }, sequence: 0, revoked: false });

const perHome = <T,>(m: Map<string, Map<string, T>>, home: string) => {
  if (!m.has(home)) m.set(home, new Map());
  return m.get(home)!;
};

export function capabilityState(home: string, capabilityId: string): CapabilityState {
  const m = perHome(capStates, home);
  if (!m.has(capabilityId)) m.set(capabilityId, freshState());
  return m.get(capabilityId)!;
}

export function storedDelegation(home: string, capabilityId: string) {
  return perHome(delegations, home).get(capabilityId);
}

/** GET /api/metering/terms — everything needed to price and verify before committing. */
export function termsQuote(args: {
  providerAddress: string; refundAddressHint?: string; askMicroPer1k: number;
  scheduleVersion: string; coefficientsDigest: string; policyDigest?: string;
  meterMode: string; safeHeadBlock: number | null; chainId?: number;
}) {
  const terms = stage3Terms(args.providerAddress, args.refundAddressHint ?? "<buyer-supplied, locked at tab open>", args.askMicroPer1k, args.scheduleVersion, args.chainId ?? 8453);
  // Buyer-found: a quote WITH ?refundAddress binds that address, so its digest
  // legitimately differs from the unbound placeholder quote. Two digests for
  // "the terms" with no signal which is which reads as drift, or worse as
  // tampering. Say which one this is, in the payload itself.
  const bound = !!args.refundAddressHint;
  return {
    quoteVersion: "stage3-quote/v2",
    terms,
    termsDigest: termsDigest(terms),
    refundAddressBound: bound,
    digestKind: bound ? "bound-terms (refundAddress fixed; this is the digest a tab will carry)"
                      : "placeholder-terms (no refundAddress supplied; digest WILL change once you supply one)",
    bindings: { scheduleDigest: args.coefficientsDigest, priceVectorDigest: args.policyDigest ?? args.coefficientsDigest },
    // Buyer-requested: the lifetime ceiling is a provider POLICY constant, not a
    // protocol truth, so it must be advertised and versioned rather than
    // discovered by having a proof rejected.
    bindingPolicy: {
      policyVersion: "binding-policy/v1",
      domain: BINDING_DOMAIN,
      maxLifetimeMs: MAX_BINDING_LIFETIME_MS,
      maxLifetimeDays: MAX_BINDING_LIFETIME_MS / 86_400_000,
      chainId: args.chainId ?? 8453,
      note: "A binding proof is checked against this ceiling before signature recovery. Rejections never reveal whether a principal is registered.",
    },
    // Buyer-requested: a counterparty must not have to guess a billable request
    // envelope, a delegation route string, or a signature preimage from a chat
    // message. Everything needed to construct and countersign a metered read is
    // published here, versioned, next to the terms it prices.
    meteredRead: {
      schemaVersion: "metered-read/v1",
      route: "POST /api/metering/read",
      // This EXACT string must appear in delegation.routes, or the capability
      // does not authorise the call.
      delegationRoute: "POST /api/metering/read",
      request: {
        required: ["delegation", "sparql"],
        optional: ["bindingProof", "contextGraphId", "view", "maxMicroTrac", "scopeQuads", "revocationCheckpoint", "nodeClass", "settlementId", "priceVectorDigest"],
        note: "maxMicroTrac is YOUR per-call ceiling; a read priced above it is refused with E_OVER_BUYER_CEILING, never silently discounted.",
      },
      countersign: {
        route: "POST /api/metering/countersign",
        domain: CAPABILITY_DOMAIN,
        // preimage = domain + "\n" + ("sha256:" + sha256(canonicalize(leg)))
        // over the leg EXACTLY as delivered, with no field surgery.
        preimage: `${CAPABILITY_DOMAIN}\n` + "sha256:<sha256 of RFC-8785-canonicalized leg, verbatim as delivered>",
        signWith: "the sessionPublicKeyPem named in your delegation",
        required: ["leg", "countersignature", "sessionPublicKeyPem"],
      },
      canonicalization: {
        rule: "RFC 8785 (JCS) with an INTEGER-ONLY restriction: every number in signed material must be an integer, or canonicalization throws E_CANON_NON_INTEGER.",
        unitsField: "meter.unitsTenths (integer tenths of U)",
        breakdownField: "meter.breakdownScaled (integers, with an explicit `scale`)",
      },
    },
    meterMode: args.meterMode,
    // Honesty rule from /api/status: never let a shadow node look like it bills.
    billing: args.meterMode === "enforce" ? "per-principal enforcement active" : "none (metering only)",
    chain: { safeHeadBlock: args.safeHeadBlock, confirmationDepth: terms.confirmationDepth },
    note: "A tab opens only when the buyer signs a delegation over these exact bindings. Settlement of any leg additionally requires the buyer's countersignature (D14).",
  };
}

/** POST /api/metering/handshake — zero-value preflight. Never touches a ledger. */
export function handshake(home: string, body: {
  delegation: SignedDelegation; walletPublicKeyPem: string;
  request: { route: string; nodeClass: string; settlementId: string; scheduleDigest: string; priceVectorDigest: string; sequence?: number };
  revocationCheckpoint: { observedAt: number | null; maxCheckpointAgeMs: number };
}) {
  const state = capabilityState(home, body.delegation.capabilityId);
  const verdict = zeroValuePreflight({
    delegation: body.delegation,
    walletPublicKeyPem: body.walletPublicKeyPem,
    state,
    now: Date.now(),
    request: { ...body.request, sequence: body.request.sequence ?? state.sequence + 1 },
    revocationCheckpoint: body.revocationCheckpoint,
  });
  return {
    preflight: "zero-value",
    estimatedMicroTrac: 0,
    verdict: verdict.code,
    ok: verdict.ok,
    ledgerTouched: false,
    capabilityId: body.delegation.capabilityId,
    expectedNextSequence: state.sequence + 1,
  };
}

/** POST /api/metering/tab/open — register the opening artifact + delegation. */
export function openTab(home: string, body: {
  delegation: SignedDelegation; walletPublicKeyPem: string; refundAddress: string;
  providerAddress: string; askMicroPer1k: number; scheduleVersion: string;
  request: { route: string; nodeClass: string; settlementId: string; scheduleDigest: string; priceVectorDigest: string };
  revocationCheckpoint: { observedAt: number | null; maxCheckpointAgeMs: number };
}) {
  // The delegation must verify before a tab exists at all.
  const state = capabilityState(home, body.delegation.capabilityId);
  const v = verifyCapability({
    delegation: body.delegation, walletPublicKeyPem: body.walletPublicKeyPem, state, now: Date.now(),
    request: { ...body.request, sequence: state.sequence + 1, estimatedMicroTrac: 0 },
    revocationCheckpoint: body.revocationCheckpoint,
  });
  if (!v.ok) return { opened: false, code: v.code };

  const terms = stage3Terms(body.providerAddress, body.refundAddress, body.askMicroPer1k, body.scheduleVersion);
  const artifact = buildOpeningArtifact(body.delegation.tabPrincipal, terms);
  registerOpening(home, artifact);
  perHome(delegations, home).set(body.delegation.capabilityId, body.delegation);
  return {
    opened: true,
    artifact,
    // The buyer countersigns THIS digest; it binds the terms he agreed to.
    countersignDigest: "sha256:" + sha256(canonicalize(artifact as unknown as Record<string, unknown>)),
    depositTo: terms.providerAddress,
    minimumCreditTrac: terms.minimumCreditTrac,
    confirmationDepth: terms.confirmationDepth,
    expiresAt: artifact.expiresAt,
  };
}

/** Credit an observed on-chain transfer, subject to every buyer-set rule. */
export function creditObservedDeposit(home: string, principal: string, transfer: ObservedTransfer) {
  const artifact = activeOpening(home, principal);
  if (!artifact) return { credited: false, code: "E_NO_OPEN_TAB" };
  const verdict = evaluateDeposit(transfer, artifact);
  if (!verdict.ok) return { credited: false, code: verdict.code, detail: verdict.detail };
  const b = creditDeposit(home, transfer, artifact, verdict);
  return { credited: true, balance: b.balance, confirmations: transfer.safeHeadBlock - transfer.blockNumber + 1 };
}

/** GET /api/metering/tab — what the buyer sees. */
export function tabView(home: string, principal: string, safeHeadBlock: number | null) {
  const artifact = activeOpening(home, principal);
  const b = balance(home, principal);
  const settled = settlementOf(home, principal);
  return {
    principal,
    balanceMicroTrac: b.balance,
    sequence: b.sequence,
    lastLegHash: b.lastHash,
    // A settled tab is closed and unclaimable regardless of a lingering opening
    // artifact — the on-chain payout is the final word (buyer-found, Bo).
    tabOpen: !!artifact && !settled,
    settled: !!settled,
    settlement: settled ? { withdrawalId: settled.withdrawalId, txHash: settled.txHash, netPaidMicroTrac: settled.netPaidMicroTrac, at: settled.at } : null,
    expiresAt: artifact?.expiresAt ?? null,
    expired: artifact ? Date.now() > Date.parse(artifact.expiresAt) : null,
    refundAddress: artifact?.terms.refundAddress ?? null,
    termsDigest: artifact?.termsDigest ?? null,
    chain: { safeHeadBlock },
  };
}
