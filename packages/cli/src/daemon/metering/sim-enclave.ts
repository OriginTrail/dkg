// P3 Phase A — BOUNDARY-SIM enclave.
//
// ███ THIS IS A SOFTWARE SIMULATION. IT IS NOT CONFIDENTIAL COMPUTE. ███
// Everything is real — the HPKE envelope, the key ceremony, the in-boundary
// metering, the attestation SHAPE, the receipt-v0.7 fields, the buyer
// verifier — EXCEPT the hardware root of trust (Phase B: SEV-SNP/CoCo).
// Every artifact this module produces carries `simulated: true` and the
// attestation-SIM domain; the buyer verifier REFUSES simulated quotes unless
// the caller explicitly opts into the labeled simulation. Nothing here may be
// presented as confidential compute (frozen honest-prototype rule).
//
// What the simulation DOES enforce, structurally:
//   * the key ceremony happens "inside": HPKE + leg-signing private keys are
//     generated in-closure and no method, field, or serialization exposes them;
//   * plaintext exists only inside serveSealed(): the operator-view object it
//     returns carries ciphertexts, digests, and token COUNTS — never bytes;
//   * legs are signed by the enclave-resident key whose provenance the
//     (simulated) quote binds via report_data.
import {
  createHash, generateKeyPairSync, sign as edSign, verify as edVerify,
  createPublicKey, type KeyObject,
} from "node:crypto";
import { canonicalize } from "./ledger.js";
import { generateHpkeKeyPair, hpkeKeyId, open as hpkeOpen, seal as hpkeSeal, type SealedEnvelope } from "./hpke-envelope.js";

export const SIM_ATTESTATION_DOMAIN = "odysseus-dkg:attestation-SIM:v1";
export const SIM_LEG_DOMAIN = "odysseus-dkg:leg-SIM:v1";
const sha256 = (b: Buffer | string) => "sha256:" + createHash("sha256").update(b).digest("hex");
const sha384 = (b: Buffer | string) => "sha384:" + createHash("sha384").update(b).digest("hex");
const pem = (k: KeyObject, pub: boolean) => k.export({ type: pub ? "spki" : "pkcs8", format: "pem" }).toString();

// ── attested deployment manifest (frozen receipt-v0.7 contract d) ──
export interface AttestedManifest {
  simulated: true;                      // Phase A label, in the manifest itself
  weightsDigest: string;
  tokenizerBundleDigest: string;
  chatTemplateDigest: string;
  meteringCodeDigest: string;           // the exact module that counts and signs
  runtimeConfig: { samplerDefaults: Record<string, unknown>; ctx: number; concurrency: number };
  hpkeKeyDerivationPolicy: string;      // e.g. "per-boot x25519; kid = sha256(pk)"
  freshnessPolicy: { maxQuoteAgeMs: number };
}
export const manifestDigestOf = (m: AttestedManifest): string =>
  sha256(canonicalize(m as unknown as Record<string, unknown>));
/** SIMULATED launch measurement of the serving image: sha384 over a
 *  sim-image preimage derived from the manifest — distinct from
 *  manifestDigest by construction, as on real hardware. */
export const simMeasurementOf = (m: AttestedManifest): string =>
  sha384("BOUNDARY-SIM-IMAGE\n" + canonicalize(m as unknown as Record<string, unknown>));

export interface SimQuote {
  simulated: true;
  domain: string;                       // SIM_ATTESTATION_DOMAIN
  measurement: string;                  // sha384:… (simulated launch measurement)
  reportData: string;                   // sha256 over the canonical binding set
  issuedAtMs: number;
  simRootKeyId: string;
  signature: string;                    // base64 Ed25519 by the SIM root — NOT a hardware chain
}
export const quoteBinding = (b: { hpkeKeyId: string; manifestDigest: string; tabEpoch: number; providerAddress: string; runtimeConfigDigest: string }) =>
  sha256(canonicalize(b as unknown as Record<string, unknown>));
export const quoteDigestOf = (q: SimQuote): string => sha256(canonicalize(q as unknown as Record<string, unknown>));

export interface OperatorView {
  requestCiphertext: SealedEnvelope;    // what the operator's wire sees inbound
  responseCiphertext: SealedEnvelope;   // …and outbound
  leg: {
    domain: string; simulated: true;
    promptDigest: string; completionDigest: string;
    inputTokens: number; outputTokens: number;
    hpkeKeyId: string; manifestDigest: string;
  };
  legSignature: string;                 // by the enclave-resident key
}

/** The key ceremony + sealed boundary. All private material lives in this
 *  closure; the returned object exposes public identities and operations only. */
export function createSimEnclave(manifest: AttestedManifest, opts?: {
  /** deterministic in-boundary "model" for gates; default reverses the prompt */
  serve?: (prompt: string) => string;
  /** deterministic in-boundary token counter (the manifest binds the real
   *  tokenizer digest; Phase A gates use a byte-exact counter) */
  countTokens?: (s: string) => number;
  nowMs?: () => number;
}) {
  if (manifest.simulated !== true) throw new Error("E_SIM_MANIFEST_LABEL: Phase A manifests MUST carry simulated:true");
  const hpke = generateHpkeKeyPair();                       // ceremony: inside
  const leg = generateKeyPairSync("ed25519");               // ceremony: inside
  const simRoot = generateKeyPairSync("ed25519");           // the SIM "vendor root" — pinned by the buyer in gates
  const mDigest = manifestDigestOf(manifest);
  const measurement = simMeasurementOf(manifest);
  const kid = hpkeKeyId(hpke.publicKeyRaw);
  const now = opts?.nowMs ?? (() => Date.now());
  const serve = opts?.serve ?? ((p: string) => [...p].reverse().join(""));
  const count = opts?.countTokens ?? ((s: string) => Buffer.byteLength(s, "utf8"));

  return {
    simulated: true as const,
    hpkePublicKeyRaw: hpke.publicKeyRaw,
    hpkeKeyId: kid,
    manifestDigest: mDigest,
    measurement,
    legSigningPublicPem: pem(leg.publicKey, true),
    simRootPublicPem: pem(simRoot.publicKey, true),

    /** The (simulated) attestation quote binding this enclave's HPKE key and
     *  manifest to an exact tab epoch / provider / runtime — the frozen
     *  freshness set. Signed by the SIM root; labeled simulated throughout. */
    quote(binding: { tabEpoch: number; providerAddress: string; runtimeConfigDigest: string }): SimQuote {
      const body = {
        simulated: true as const, domain: SIM_ATTESTATION_DOMAIN, measurement,
        reportData: quoteBinding({ hpkeKeyId: kid, manifestDigest: mDigest, ...binding }),
        issuedAtMs: now(), simRootKeyId: sha256(pem(simRoot.publicKey, true)),
      };
      const signature = edSign(null, Buffer.from(SIM_ATTESTATION_DOMAIN + "\n" + canonicalize(body as unknown as Record<string, unknown>)), simRoot.privateKey).toString("base64");
      return { ...body, signature };
    },

    /** Serve one sealed request entirely inside the boundary. Returns the
     *  operator-visible surface (ciphertexts + counts, NEVER plaintext) and
     *  the buyer-sealed response. */
    serveSealed(args: { envelope: SealedEnvelope; info: Buffer; aad: Buffer; buyerResponsePkRaw: Buffer }):
      { ok: true; operatorView: OperatorView; sealedResponse: SealedEnvelope } | { ok: false; code: string } {
      const opened = hpkeOpen(args.envelope, hpke.privateKey, hpke.publicKeyRaw, args.info, args.aad);
      if (!opened.ok) return { ok: false, code: "E_HPKE_OPEN_FAILED" };
      const prompt = opened.plaintext.toString("utf8");
      const completion = serve(prompt);
      const legBody = {
        domain: SIM_LEG_DOMAIN, simulated: true as const,
        promptDigest: sha256(prompt), completionDigest: sha256(completion),
        inputTokens: count(prompt), outputTokens: count(completion),
        hpkeKeyId: kid, manifestDigest: mDigest,
      };
      const legSignature = edSign(null, Buffer.from(SIM_LEG_DOMAIN + "\n" + canonicalize(legBody as unknown as Record<string, unknown>)), leg.privateKey).toString("base64");
      const sealedResponse = hpkeSeal(args.buyerResponsePkRaw, args.info, args.aad, Buffer.from(completion, "utf8"));
      return { ok: true, operatorView: { requestCiphertext: args.envelope, responseCiphertext: sealedResponse, leg: legBody, legSignature }, sealedResponse };
    },
  };
}

/** Verify an enclave-signed SIM leg (buyer side, after decrypting locally). */
export function verifySimLeg(legBody: OperatorView["leg"], signature: string, legSigningPublicPem: string): boolean {
  try {
    return edVerify(null, Buffer.from(SIM_LEG_DOMAIN + "\n" + canonicalize(legBody as unknown as Record<string, unknown>)),
      createPublicKey(legSigningPublicPem), Buffer.from(signature, "base64"));
  } catch { return false; }
}
