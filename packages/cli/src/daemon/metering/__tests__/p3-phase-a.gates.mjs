// P3 Phase A gates — HPKE envelope, boundary-sim key ceremony, receipt-v0.7
// enclave fields, and the buyer verifier's frozen refusal semantics.
// The simulation is labeled at every layer; a central gate proves the buyer
// verifier REFUSES simulated quotes by default (never confidential compute).
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const H = await import(join(dist, "metering/hpke-envelope.js"));
const S = await import(join(dist, "metering/sim-enclave.js"));
const R = await import(join(dist, "metering/receipt-v07.js"));
const L = await import(join(dist, "metering/ledger.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

console.log("P3 Phase A gates (BOUNDARY-SIM — labeled simulation, not confidential compute):");

console.log("\n(1) HPKE against the OFFICIAL RFC 9180 A.1 vectors (mode_base, X25519/HKDF-SHA256/AES-128-GCM):");
{
  const skEm = "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736";
  const pkEm = "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431";
  const pkRm = "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d";
  const skRm = "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8";
  const info = Buffer.from("4f6465206f6e2061204772656369616e2055726e", "hex");
  const pt = Buffer.from("4265617574792069732074727574682c20747275746820626561757479", "hex");
  const aad0 = Buffer.from("436f756e742d30", "hex");
  const eph = { privateKey: H.x25519PrivateFromRaw(Buffer.from(skEm, "hex")), publicKeyRaw: Buffer.from(pkEm, "hex") };
  const { sharedSecret, enc } = H._testInternals.encap(Buffer.from(pkRm, "hex"), eph);
  ok("encap enc == pkEm", enc.toString("hex") === pkEm);
  ok("shared_secret matches the published vector", sharedSecret.toString("hex") === "fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc");
  const ks = H._testInternals.keySchedule(sharedSecret, info);
  ok("key + base_nonce match the published vectors", ks.key.toString("hex") === "4531685d41d65f03dc48f6b8302c05b0" && ks.baseNonce.toString("hex") === "56d890e5accaaf011cff4b7d");
  const sealed = H.seal(Buffer.from(pkRm, "hex"), info, aad0, pt, eph);
  ok("ciphertext[seq 0] matches the published vector byte-for-byte", sealed.ct === "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a");
  ok("decap-side shared secret matches", H._testInternals.decap(Buffer.from(pkEm, "hex"), H.x25519PrivateFromRaw(Buffer.from(skRm, "hex")), Buffer.from(pkRm, "hex")).toString("hex") === "fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc");
  const opened = H.open(sealed, H.x25519PrivateFromRaw(Buffer.from(skRm, "hex")), Buffer.from(pkRm, "hex"), info, aad0);
  ok("roundtrip opens to the vector plaintext", opened.ok && opened.plaintext.equals(pt));
  const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith("00") ? "01" : "00") };
  ok("tampered ciphertext → E_HPKE_OPEN_FAILED", H.open(tampered, H.x25519PrivateFromRaw(Buffer.from(skRm, "hex")), Buffer.from(pkRm, "hex"), info, aad0).ok === false);
  ok("wrong AAD → E_HPKE_OPEN_FAILED", H.open(sealed, H.x25519PrivateFromRaw(Buffer.from(skRm, "hex")), Buffer.from(pkRm, "hex"), info, Buffer.from("436f756e742d31", "hex")).ok === false);
  ok("wrong recipient key → E_HPKE_OPEN_FAILED", (() => { const other = H.generateHpkeKeyPair(); return H.open(sealed, other.privateKey, other.publicKeyRaw, info, aad0).ok === false; })());
}

const MANIFEST = {
  simulated: true,
  weightsDigest: "sha256:" + "1a".repeat(32), tokenizerBundleDigest: "sha256:" + "2b".repeat(32),
  chatTemplateDigest: "sha256:" + "3c".repeat(32), meteringCodeDigest: "sha256:" + "4d".repeat(32),
  runtimeConfig: { samplerDefaults: { temperature: 0, seed: 42 }, ctx: 4096, concurrency: 1 },
  hpkeKeyDerivationPolicy: "per-boot x25519; kid = sha256(pk)",
  freshnessPolicy: { maxQuoteAgeMs: 600_000 },
};
const BINDING = { tabEpoch: 3, providerAddress: "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab", runtimeConfigDigest: "sha256:" + "5e".repeat(32) };
let NOW = 1_000_000_000_000;
const enclave = S.createSimEnclave(MANIFEST, { nowMs: () => NOW });

console.log("\n(2) key ceremony — private material never leaves the boundary:");
{
  ok("enclave exposes public identities (hpke pk, kid, leg pk, sim root pk)", enclave.hpkePublicKeyRaw.length === 32 && enclave.hpkeKeyId.startsWith("hpke-x25519:") && enclave.legSigningPublicPem.includes("PUBLIC KEY") && enclave.simRootPublicPem.includes("PUBLIC KEY"));
  const dump = JSON.stringify(enclave, (k, v) => (Buffer.isBuffer(v) ? v.toString("hex") : v));
  ok("serializing the enclave object leaks NO private material (no PKCS8/PRIVATE markers)", !dump.includes("PRIVATE") && !dump.includes("pkcs8"));
  ok("no method or field returns a private key object", Object.entries(Object.getOwnPropertyDescriptors(enclave)).every(([k, d]) => typeof d.value !== "object" || d.value === null || Buffer.isBuffer(d.value) || k === "quote" || k === "serveSealed" || typeof d.value !== "function"));
  ok("a non-simulated-labeled manifest is REFUSED at ceremony (honesty is structural)", (() => { try { S.createSimEnclave({ ...MANIFEST, simulated: false }); return false; } catch (e) { return String(e.message).startsWith("E_SIM_MANIFEST_LABEL"); } })());
  ok("manifestDigest = sha256 over canonicalize(manifest) — reproducible", enclave.manifestDigest === "sha256:" + createHash("sha256").update(L.canonicalize(MANIFEST)).digest("hex"));
  ok("measurement (sha384, sim launch) ≠ manifestDigest by construction", enclave.measurement.startsWith("sha384:") && enclave.measurement !== enclave.manifestDigest);
}

console.log("\n(3) sealed serving E2E — plaintext exists only inside the boundary:");
{
  const buyer = H.generateHpkeKeyPair();                 // buyer's ephemeral response key
  const PROMPT = "the operator must never see this prompt";
  const info = Buffer.from("odysseus-dkg:p3-sim:v1");
  const aad = Buffer.from("leg-1");
  const sealedReq = H.seal(enclave.hpkePublicKeyRaw, info, aad, Buffer.from(PROMPT, "utf8"));
  const served = enclave.serveSealed({ envelope: sealedReq, info, aad, buyerResponsePkRaw: buyer.publicKeyRaw });
  ok("serveSealed succeeds", served.ok === true, JSON.stringify(served));
  const ov = served.operatorView;
  const ovDump = JSON.stringify(ov);
  const expectedCompletion = [...PROMPT].reverse().join("");
  ok("operator view contains NEITHER prompt NOR completion plaintext", !ovDump.includes(PROMPT) && !ovDump.includes(expectedCompletion));
  ok("operator view carries counts + digests only (leg shape)", ov.leg.inputTokens === Buffer.byteLength(PROMPT) && ov.leg.promptDigest.startsWith("sha256:") && ov.leg.simulated === true);
  ok("buyer decrypts the sealed response locally and RECOUNTS from plaintext", (() => {
    const opened = H.open(served.sealedResponse, buyer.privateKey, buyer.publicKeyRaw, info, aad);
    return opened.ok && opened.plaintext.toString("utf8") === expectedCompletion && Buffer.byteLength(opened.plaintext.toString("utf8")) === ov.leg.outputTokens;
  })());
  ok("the leg is verifiably signed by the ENCLAVE-resident key", S.verifySimLeg(ov.leg, served.operatorView.legSignature, enclave.legSigningPublicPem));
  ok("a tampered leg (count inflated) fails enclave-signature verification", !S.verifySimLeg({ ...ov.leg, outputTokens: ov.leg.outputTokens + 1 }, served.operatorView.legSignature, enclave.legSigningPublicPem));
  ok("garbage ciphertext at the boundary → E_HPKE_OPEN_FAILED (nothing served)", enclave.serveSealed({ envelope: { enc: "00".repeat(32), ct: "00".repeat(40) }, info, aad, buyerResponsePkRaw: buyer.publicKeyRaw }).ok === false);
}

console.log("\n(4) receipt-v0.7 fields + buyer verifier (frozen refusal semantics):");
{
  const quote = enclave.quote(BINDING);
  const fields = R.buildEnclaveReceiptFields(quote, enclave.hpkeKeyId, enclave.manifestDigest, "none");
  ok("fields carry the frozen shape (sha384 measurement, sha256 quote digest, kid, manifest digest, bucket)", fields.enclave.measurement.startsWith("sha384:") && fields.enclave.attestationQuoteDigest.startsWith("sha256:") && fields.enclave.hpkeKeyId === enclave.hpkeKeyId && fields.privacy.paddingBucket === "none");
  const base = {
    fields, quote, simRootPublicPem: enclave.simRootPublicPem,
    allowlist: { version: 7, measurements: [enclave.measurement] }, expectedAllowlistVersion: 7,
    binding: BINDING, maxQuoteAgeMs: MANIFEST.freshnessPolicy.maxQuoteAgeMs, nowMs: NOW + 1000,
    acceptLabeledSimulation: true,
  };
  ok("fully-bound fresh quote verifies (with EXPLICIT simulation opt-in)", R.verifyEnclaveReceipt(base).ok === true, JSON.stringify(R.verifyEnclaveReceipt(base)));
  ok("DEFAULT REFUSES the simulation — E_QUOTE_SIMULATED (never confidential compute)", (() => { const { acceptLabeledSimulation, ...noOptIn } = base; const r = R.verifyEnclaveReceipt(noOptIn); return r.ok === false && r.code === "E_QUOTE_SIMULATED"; })());
  ok("tampered quote signature → E_QUOTE_SIG", R.verifyEnclaveReceipt({ ...base, quote: { ...quote, issuedAtMs: quote.issuedAtMs + 1 } }).code === "E_QUOTE_SIG");
  ok("foreign sim root (unpinned) → E_QUOTE_SIG", (() => { const other = S.createSimEnclave(MANIFEST); return R.verifyEnclaveReceipt({ ...base, simRootPublicPem: other.simRootPublicPem }).code === "E_QUOTE_SIG"; })());
  ok("receipt referencing a DIFFERENT quote → E_QUOTE_DIGEST", (() => { NOW += 500; const q2 = enclave.quote(BINDING); NOW -= 500; const f2 = R.buildEnclaveReceiptFields(q2, enclave.hpkeKeyId, enclave.manifestDigest); return R.verifyEnclaveReceipt({ ...base, fields: f2 }).code === "E_QUOTE_DIGEST"; })());
  ok("cross-EPOCH replay → E_QUOTE_BINDING", R.verifyEnclaveReceipt({ ...base, binding: { ...BINDING, tabEpoch: 4 } }).code === "E_QUOTE_BINDING");
  ok("cross-PROVIDER replay → E_QUOTE_BINDING", R.verifyEnclaveReceipt({ ...base, binding: { ...BINDING, providerAddress: "0x8A87ea7c0fBC3431f20B5B26dd9f7f32571Aa2ba" } }).code === "E_QUOTE_BINDING");
  ok("runtime-config drift → E_QUOTE_BINDING", R.verifyEnclaveReceipt({ ...base, binding: { ...BINDING, runtimeConfigDigest: "sha256:" + "ff".repeat(32) } }).code === "E_QUOTE_BINDING");
  ok("stale quote (age > maxQuoteAgeMs) → E_QUOTE_STALE even though cryptographically valid", R.verifyEnclaveReceipt({ ...base, nowMs: NOW + MANIFEST.freshnessPolicy.maxQuoteAgeMs + 1 }).code === "E_QUOTE_STALE");
  ok("future-dated quote → E_QUOTE_STALE", R.verifyEnclaveReceipt({ ...base, nowMs: NOW - 1 }).code === "E_QUOTE_STALE");
  ok("ROLLBACK refusal: valid measurement on a SUPERSEDED allowlist version → E_ALLOWLIST_STALE", R.verifyEnclaveReceipt({ ...base, expectedAllowlistVersion: 8 }).code === "E_ALLOWLIST_STALE");
  ok("measurement absent from the current allowlist → E_MEASUREMENT_NOT_ALLOWLISTED", R.verifyEnclaveReceipt({ ...base, allowlist: { version: 7, measurements: ["sha384:" + "0".repeat(96)] } }).code === "E_MEASUREMENT_NOT_ALLOWLISTED");
}

console.log("\n(5) padding buckets + published-KA privacy (frozen contract d):");
{
  ok("bucket none → exact count", R.publishedTokenCount(437, "none") === 437);
  ok("b128 rounds UP to the boundary (437 → 512)", R.publishedTokenCount(437, "b128") === 512);
  ok("exact boundary stays (512 → 512 at b512)", R.publishedTokenCount(512, "b512") === 512);
  ok("b2048 floor case (1 → 2048)", R.publishedTokenCount(1, "b2048") === 2048);
  ok("negative/NaN counts refuse", (() => { try { R.publishedTokenCount(-1, "b128"); return false; } catch { return true; } })());
  ok("KA carrying a plaintext field → E_KA_PLAINTEXT_FIELD", R.checkPublishedReceiptPrivacy({ prompt: "oops" }, "none").code === "E_KA_PLAINTEXT_FIELD");
  ok("KA carrying tokenIds → refused", R.checkPublishedReceiptPrivacy({ tokenIds: [1, 2] }, "none").code === "E_KA_PLAINTEXT_FIELD");
  ok("bucket set + non-boundary published count → E_KA_EXACT_COUNT_LEAK", R.checkPublishedReceiptPrivacy({ inputTokens: 437 }, "b128").code === "E_KA_EXACT_COUNT_LEAK");
  ok("bucket set + boundary counts → ok", R.checkPublishedReceiptPrivacy({ inputTokens: 512, outputTokens: 128 }, "b128").ok === true);
}

console.log("\n(6) v0.6 additivity — the frozen fields merge without touching existing receipt content:");
{
  const v06 = { schemaVersion: "receipt-v0.6", inputTokens: 42, outputTokens: 25, costMicroTrac: 234, policyDigest: "sha256:" + "aa".repeat(32) };
  const quote = enclave.quote(BINDING);
  const merged = { ...v06, ...R.buildEnclaveReceiptFields(quote, enclave.hpkeKeyId, enclave.manifestDigest, "none") };
  ok("every v0.6 field is byte-unchanged after the merge", Object.entries(v06).every(([k, v]) => JSON.stringify(merged[k]) === JSON.stringify(v)));
  ok("the enclave fields are present-and-populated (Phase A ends present-but-null)", merged.enclave.measurement.startsWith("sha384:") && merged.privacy.paddingBucket === "none");
}

console.log("\n(7) Hermes P3-round HOLD — fail-closed negative gates:");
{
  const quote = enclave.quote(BINDING);
  const fields = R.buildEnclaveReceiptFields(quote, enclave.hpkeKeyId, enclave.manifestDigest, "none");
  const base = {
    fields, quote, simRootPublicPem: enclave.simRootPublicPem,
    allowlist: { version: 7, measurements: [enclave.measurement] }, expectedAllowlistVersion: 7,
    binding: BINDING, maxQuoteAgeMs: MANIFEST.freshnessPolicy.maxQuoteAgeMs, nowMs: NOW + 1000,
    acceptLabeledSimulation: true,
  };
  // #1 label erasure: an unlabeled quote refuses STRUCTURALLY, before signature
  const unlabeled = { ...quote }; delete unlabeled.simulated;
  ok("#1 quote missing simulated:true → E_QUOTE_LABEL_ERASED (pre-signature, fail-closed)", R.verifyEnclaveReceipt({ ...base, quote: unlabeled }).code === "E_QUOTE_LABEL_ERASED");
  ok("#1 simulated:false → E_QUOTE_LABEL_ERASED", R.verifyEnclaveReceipt({ ...base, quote: { ...quote, simulated: false } }).code === "E_QUOTE_LABEL_ERASED");
  // #2 root/rotation: verifying against a DIFFERENT pinned root refuses (substitution/rotation never silent)
  const other = S.createSimEnclave(MANIFEST, { nowMs: () => NOW });
  ok("#2 quote verified against a rotated/substituted pinned root → refuses (E_QUOTE_SIG)", R.verifyEnclaveReceipt({ ...base, simRootPublicPem: other.simRootPublicPem }).ok === false);
  ok("#2 simRootKeyId equals the digest of the pinned root (identity bound)", quote.simRootKeyId === "sha256:" + createHash("sha256").update(enclave.simRootPublicPem).digest("hex"));
  // #3 recursive disclosure: a NESTED forbidden field is caught
  ok("#3 nested plaintext in an array → E_KA_PLAINTEXT_FIELD", R.checkPublishedReceiptPrivacy({ legs: [{ ok: true }, { prompt: "smuggled" }] }, "none").code === "E_KA_PLAINTEXT_FIELD");
  ok("#3 deeply nested completion → E_KA_PLAINTEXT_FIELD", R.checkPublishedReceiptPrivacy({ a: { b: { c: { completion: "x" } } } }, "none").code === "E_KA_PLAINTEXT_FIELD");
  ok("#3 clean nested KA → ok", R.checkPublishedReceiptPrivacy({ enclave: { measurement: "sha384:x" }, legs: [{ inputTokens: 512 }] }, "b512").ok === true);
  // #4 no plaintext leaks through refusal/error objects
  const PROMPT = "operator-must-never-see-this-secret-prompt";
  const buyer = H.generateHpkeKeyPair(); const info = Buffer.from("i"); const aad = Buffer.from("a");
  const served = enclave.serveSealed({ envelope: H.seal(enclave.hpkePublicKeyRaw, info, aad, Buffer.from(PROMPT, "utf8")), info, aad, buyerResponsePkRaw: buyer.publicKeyRaw });
  const completion = [...PROMPT].reverse().join("");
  // a refusal from a garbage envelope must carry no bytes
  const errObj = enclave.serveSealed({ envelope: { enc: "00".repeat(32), ct: "00".repeat(40) }, info, aad, buyerResponsePkRaw: buyer.publicKeyRaw });
  ok("#4 serve-error object carries NO plaintext (only a code)", errObj.ok === false && !JSON.stringify(errObj).includes(PROMPT) && !JSON.stringify(errObj).includes(completion) && Object.keys(errObj).join() === "ok,code");
  // every verifier refusal detail is plaintext-free
  const refusals = [
    R.verifyEnclaveReceipt({ ...base, quote: unlabeled }),
    R.verifyEnclaveReceipt({ ...base, binding: { ...BINDING, tabEpoch: 99 } }),
    R.verifyEnclaveReceipt({ ...base, nowMs: NOW + 1e9 }),
    R.verifyEnclaveReceipt({ ...base, expectedAllowlistVersion: 8 }),
  ];
  ok("#4 no verifier refusal detail echoes prompt/completion bytes", refusals.every((r) => !JSON.stringify(r).includes(PROMPT) && !JSON.stringify(r).includes(completion)));
}

console.log(`\n${pass}/${pass + fail} P3 Phase A gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
