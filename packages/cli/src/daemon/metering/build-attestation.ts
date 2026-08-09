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
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, providerSign, providerPublicPem } from "./ledger.js";
import {
  inferencePolicyDigest, canonicalizationDigest, INFERENCE_POLICY_CANONICAL,
  CANONICALIZATION_CANONICAL, RECEIPT_SCHEMA_VERSION,
} from "./inference-meter.js";

const sha256 = (b: string | Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex");

export const BUILD_ATTESTATION_DOMAIN = "odysseus-dkg:build-attestation:v2";

// ── the production artifact, named explicitly (Bo, event 5b4a4a18) ──────────
// v1 digested "every .js file in my own directory", which made the pin
// LAYOUT-DEPENDENT: the same audited source produced a different buildDigest
// from the audit bundle's dist copy (4 files), from an esbuild route bundle
// (10 chunks), and from a full production directory (15 files). A pin that
// changes with packaging identifies packaging, not code, and cannot be used as
// the promised comparison against GET /api/metering/build.
//
// The pin is therefore defined over THIS explicit list and nothing else.
// Files present but unlisted are REPORTED (so drift is visible) but do not move
// the pin; a listed file that is MISSING makes the attestation incomplete, and
// an incomplete attestation can never satisfy a pin.
export const METERING_MODULE_MANIFEST = Object.freeze([
  "build-attestation.js",
  "buyer-registry.js",
  "capability.js",
  "deposit-rail.js",
  "evm-binding.js",
  "http-core.js",
  "infer-http-core.js",
  "inference-meter.js",
  "ledger.js",
  "metered-inference.js",
  "metered-read.js",
  "odysseus-backend.js",
  "read-meter.js",
  "settlement.js",
  "stage3-endpoint.js",
]);
export const METERING_MANIFEST_VERSION = "metering-artifact/v1";

export interface BuildAttestation {
  domain: string;
  receiptSchemaVersion: string;
  /** which explicit artifact manifest the pin is defined over. */
  manifestVersion: string;
  /** digest per MANIFEST-LISTED module, as it exists on disk right now. */
  moduleDigests: Record<string, string>;
  /** manifest modules that are absent here — makes the attestation incomplete. */
  missingModules: string[];
  /** .js files present but NOT in the manifest: visible, but outside the pin. */
  unexpectedModules: string[];
  /** false when any manifest module is missing; an incomplete attestation can
   *  never satisfy a pin, so a partial artifact cannot masquerade as the real one. */
  complete: boolean;
  /** digest over {manifestVersion, moduleDigests} — LAYOUT-INVARIANT. */
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
export function computeModuleDigests(dir = moduleDir()): {
  moduleDigests: Record<string, string>; missingModules: string[]; unexpectedModules: string[];
} {
  const moduleDigests: Record<string, string> = {};
  const missingModules: string[] = [];
  const present = existsSync(dir) ? new Set(readdirSync(dir).filter((f) => f.endsWith(".js"))) : new Set<string>();
  for (const f of [...METERING_MODULE_MANIFEST].sort()) {
    if (!present.has(f)) { missingModules.push(f); continue; }
    try { moduleDigests[f] = sha256(readFileSync(join(dir, f))); }
    catch { missingModules.push(f); }              // unreadable is missing, never silently skipped
  }
  const listed = new Set<string>(METERING_MODULE_MANIFEST);
  const unexpectedModules = [...present].filter((f) => !listed.has(f)).sort();
  return { moduleDigests, missingModules, unexpectedModules };
}

export function buildAttestation(opts?: { home?: string; dir?: string; sourceCommit?: string }): BuildAttestation {
  const { moduleDigests, missingModules, unexpectedModules } = computeModuleDigests(opts?.dir);
  const att: BuildAttestation = {
    domain: BUILD_ATTESTATION_DOMAIN,
    receiptSchemaVersion: RECEIPT_SCHEMA_VERSION,
    manifestVersion: METERING_MANIFEST_VERSION,
    moduleDigests,
    missingModules,
    unexpectedModules,
    complete: missingModules.length === 0,
    // The pin covers the manifest version and the named modules ONLY, so
    // repackaging the same code cannot move it.
    buildDigest: sha256(canonicalize({ manifestVersion: METERING_MANIFEST_VERSION, moduleDigests })),
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
  if (a.buildDigest !== sha256(canonicalize({ manifestVersion: a.manifestVersion, moduleDigests: a.moduleDigests }))) {
    return { ok: false, code: "E_ATTESTATION_INCOHERENT", detail: "buildDigest ≠ digest of the manifest+module set it reports" };
  }
  if (a.manifestVersion !== METERING_MANIFEST_VERSION) {
    return { ok: false, code: "E_ATTESTATION_MANIFEST_VERSION", detail: `attestation manifest ${a.manifestVersion} ≠ ${METERING_MANIFEST_VERSION}` };
  }
  // An incomplete artifact must never satisfy a pin: a partial copy of the code
  // is not the code, and treating it as pinnable is how a bundle's dist subset
  // ends up impersonating a production deployment.
  if (a.complete !== true || (a.missingModules?.length ?? 0) > 0) {
    return { ok: false, code: "E_ATTESTATION_INCOMPLETE", detail: `missing: ${(a.missingModules ?? []).join(", ") || "(unknown)"}` };
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

/**
 * THE BUYER'S FLOW, done properly (Bo, event 5b4a4a18).
 *
 * The defect this replaces: verifying a signature against the public key that
 * arrived in the SAME response proves only that the response is internally
 * consistent — the identical class of bug as accepting a delegation "signed by
 * the key that came with it". The expected key must be held INDEPENDENTLY.
 *
 * Returns the values the buyer may then pin into a countersignature. Nothing
 * self-reported is trusted: the attestation digest is RECOMPUTED here, never
 * read from the response.
 */
export function verifySignedBuildAttestation(args: {
  response: { attestation: BuildAttestation; attestationDigest?: string; providerPublicKeyPem?: string; signature: string };
  /** the provider key the buyer already holds, out of band. NOT the response's. */
  expectedProviderPublicKeyPem: string;
  expectedContractDigests: { inferencePolicyDigest: string; canonicalizationDigest: string };
  expectedBuildDigest?: string;
}): { ok: true; buildDigest: string; attestationDigest: string } | { ok: false; code: string; detail: string } {
  const r = args.response;
  if (!r?.attestation || typeof r.signature !== "string") {
    return { ok: false, code: "E_ATTESTATION_MALFORMED", detail: "missing attestation or signature" };
  }
  // 1. Recompute the digest. A self-reported attestationDigest is a claim; if it
  //    is present and wrong, that is a tamper signal, not a rounding error.
  const digest = attestationDigest(r.attestation);
  if (r.attestationDigest !== undefined && r.attestationDigest !== digest) {
    return { ok: false, code: "E_ATTESTATION_DIGEST_MISMATCH", detail: "reported attestationDigest ≠ digest of the attestation it accompanies" };
  }
  // 2. Verify against the INDEPENDENTLY held key. If the response also carries a
  //    key, it is ignored for verification — its only use is spotting a swap.
  let sigOk = false;
  try {
    sigOk = edVerify(
      null,
      Buffer.concat([Buffer.from(BUILD_ATTESTATION_DOMAIN + "\n"), Buffer.from(digest)]),
      createPublicKey(args.expectedProviderPublicKeyPem),
      Buffer.from(r.signature, "base64"),
    );
  } catch { sigOk = false; }
  if (!sigOk) {
    return { ok: false, code: "E_ATTESTATION_SIGNATURE", detail: "signature does not verify under the provider key the buyer holds" };
  }
  if (r.providerPublicKeyPem !== undefined && r.providerPublicKeyPem.trim() !== args.expectedProviderPublicKeyPem.trim()) {
    return { ok: false, code: "E_ATTESTATION_KEY_SWAP", detail: "response advertises a provider key other than the one the buyer holds" };
  }
  // 3. Only now, the content checks.
  const v = verifyBuildAttestation({
    attestation: r.attestation,
    expectedContractDigests: args.expectedContractDigests,
    expectedBuildDigest: args.expectedBuildDigest,
  });
  if (!v.ok) return v;
  return { ok: true, buildDigest: r.attestation.buildDigest, attestationDigest: digest };
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
