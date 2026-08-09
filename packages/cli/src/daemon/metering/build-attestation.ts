// V2 — provider build attestation: which code is actually serving.
//
// Bo's carve-out (event 584ba19e): verifying the audit bundle "does not by
// itself ... prove deployment of the commit to the live billed surface." He is
// right, and nothing before this let a buyer check that the node taking his
// money runs the code he audited.
//
// WHAT THIS IS, PLAINLY: the running code digests ITSELF — its own metering
// modules on disk — and derives the contract digests from the objects actually
// loaded in memory, then signs the result with the provider key.
//
// WHAT THIS IS NOT: proof against a hostile provider. A node that wants to lie
// can serve any bytes it likes and report any digest it likes; self-attestation
// cannot fix that, and claiming otherwise would be worse than not shipping it.
// What it does buy, precisely:
//   1. DEPLOY SKEW becomes visible. The overwhelmingly likely failure is honest
//      — a node running yesterday's build while quoting today's audit. That is
//      caught immediately and cheaply.
//   2. A LIE BECOMES EVIDENCE. The attestation is provider-signed and its digest
//      is bound into every leg, so a buyer who countersigns is countersigning
//      against a NAMED build. If the provider is later shown to have served
//      different code, the signed leg is the proof — it is no longer the buyer's
//      word against the provider's.
//   3. The contract digests are DERIVED from the loaded objects, not restated
//      from a constant, so a build whose pricing or canonicalization differs
//      from the audited one cannot report the audited digests without actually
//      containing them.
//
// Real independence still comes from the buyer's own recount (receipt-v0.5:
// arrays, content-addressed tokenizer bundle, buyer-local re-encode). This adds
// accountability for WHICH build produced the bytes; it does not replace that.
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, providerSign, providerPublicPem } from "./ledger.js";
import {
  inferencePolicyDigest, canonicalizationDigest, INFERENCE_POLICY_CANONICAL,
  CANONICALIZATION_CANONICAL, RECEIPT_SCHEMA_VERSION,
} from "./inference-meter.js";

const sha256 = (b: string | Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex");

export const BUILD_ATTESTATION_DOMAIN = "odysseus-dkg:build-attestation:v1";

export interface BuildAttestation {
  domain: string;
  receiptSchemaVersion: string;
  /** digest per metering module file, as they exist on disk right now. */
  moduleDigests: Record<string, string>;
  /** digest over the whole module set — the single value to compare. */
  buildDigest: string;
  /** derived from the objects LOADED IN MEMORY, not restated constants. */
  contractDigests: {
    inferencePolicyDigest: string;
    canonicalizationDigest: string;
  };
  /** written at deploy time if the operator records it; absent is honest. */
  sourceCommit?: string;
  /** what this attestation cannot do — carried in-band so it is never lost. */
  limitations: string;
}

/** The directory holding the running metering modules (this file's own dir). */
function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Digest the metering modules as they exist on disk. Deterministic: sorted by
 * name, name and content both covered, so a rename is as visible as an edit.
 */
export function computeModuleDigests(dir = moduleDir()): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".js")) continue;              // the built modules only
    const p = join(dir, f);
    try { out[f] = sha256(readFileSync(p)); } catch { /* unreadable → omitted, visible by absence */ }
  }
  return out;
}

export function buildAttestation(opts?: { home?: string; dir?: string; sourceCommit?: string }): BuildAttestation {
  const moduleDigests = computeModuleDigests(opts?.dir);
  const att: BuildAttestation = {
    domain: BUILD_ATTESTATION_DOMAIN,
    receiptSchemaVersion: RECEIPT_SCHEMA_VERSION,
    moduleDigests,
    buildDigest: sha256(canonicalize(moduleDigests)),
    contractDigests: {
      // Derived from the loaded objects: a build that reports these must
      // actually contain them.
      inferencePolicyDigest: inferencePolicyDigest(),
      canonicalizationDigest: canonicalizationDigest(),
    },
    // Absent optionals are OMITTED, never set to undefined: the canonical form
    // is integer-and-defined-only, and `{k: undefined}` is not the same document
    // as `{}` (it throws rather than silently differing — the D12 rule).
    limitations: "Self-attestation. Detects deploy skew and makes a false claim into signed evidence bound to each leg; it is NOT proof against a hostile provider. Independent assurance comes from the buyer's own recount under receipt-v0.5.",
  };
  const commit = opts?.sourceCommit ?? readDeployedCommit(opts?.home);
  if (commit) att.sourceCommit = commit;
  return att;
}

/** Operator-written at deploy time. Absent is reported as absent, never guessed. */
function readDeployedCommit(home?: string): string | undefined {
  const h = home ?? process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;
  const f = join(h, "metering", "deployed-commit");
  try { return existsSync(f) ? readFileSync(f, "utf8").trim() || undefined : undefined; } catch { return undefined; }
}

/** The digest a leg binds, so a countersignature names a specific build. */
export function attestationDigest(att: BuildAttestation): string {
  return sha256(canonicalize(att as unknown as Record<string, unknown>));
}

/** Provider-signed attestation: a committed claim, not a casual assertion. */
export function signedBuildAttestation(opts?: { home?: string; dir?: string; sourceCommit?: string }): {
  attestation: BuildAttestation;
  attestationDigest: string;
  providerPublicKeyPem: string;
  signature: string;
} {
  const home = opts?.home ?? process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;
  const attestation = buildAttestation({ ...opts, home });
  const digest = attestationDigest(attestation);
  return {
    attestation,
    attestationDigest: digest,
    providerPublicKeyPem: providerPublicPem(home),
    signature: providerSign(home, BUILD_ATTESTATION_DOMAIN, digest),
  };
}

/**
 * The buyer's check: does the build this node claims match the one he audited?
 * Compares the DERIVED contract digests (which a divergent build cannot fake
 * without containing the audited objects) and, when the buyer pins one, the
 * whole build digest.
 */
export function verifyBuildAttestation(args: {
  attestation: BuildAttestation;
  expectedContractDigests: { inferencePolicyDigest: string; canonicalizationDigest: string };
  expectedBuildDigest?: string;
}): { ok: true } | { ok: false; code: string; detail: string } {
  const a = args.attestation;
  if (a?.domain !== BUILD_ATTESTATION_DOMAIN) {
    return { ok: false, code: "E_ATTESTATION_DOMAIN", detail: "not a build attestation" };
  }
  if (attestationDigest(a) === undefined) {
    return { ok: false, code: "E_ATTESTATION_MALFORMED", detail: "undigestable" };
  }
  if (a.buildDigest !== sha256(canonicalize(a.moduleDigests))) {
    return { ok: false, code: "E_ATTESTATION_INCOHERENT", detail: "buildDigest ≠ digest of the module set it reports" };
  }
  if (a.contractDigests?.inferencePolicyDigest !== args.expectedContractDigests.inferencePolicyDigest) {
    return { ok: false, code: "E_BUILD_CONTRACT_MISMATCH", detail: "running pricing policy ≠ the audited one" };
  }
  if (a.contractDigests?.canonicalizationDigest !== args.expectedContractDigests.canonicalizationDigest) {
    return { ok: false, code: "E_BUILD_CONTRACT_MISMATCH", detail: "running canonicalization ≠ the audited one" };
  }
  if (args.expectedBuildDigest !== undefined && a.buildDigest !== args.expectedBuildDigest) {
    return { ok: false, code: "E_BUILD_DIGEST_MISMATCH", detail: `node runs ${a.buildDigest}, buyer pinned ${args.expectedBuildDigest}` };
  }
  return { ok: true };
}

/** Convenience for the leg: the running build's identity, cheap to embed. */
export function runningBuildRef(opts?: { home?: string; dir?: string }): { buildDigest: string; attestationDigest: string; sourceCommit?: string } {
  const att = buildAttestation(opts);
  const ref: { buildDigest: string; attestationDigest: string; sourceCommit?: string } = {
    buildDigest: att.buildDigest, attestationDigest: attestationDigest(att),
  };
  if (att.sourceCommit) ref.sourceCommit = att.sourceCommit;   // omit, never undefined
  return ref;
}

export { INFERENCE_POLICY_CANONICAL, CANONICALIZATION_CANONICAL };
