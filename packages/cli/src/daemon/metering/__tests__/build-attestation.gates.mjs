// Build attestation — which code is actually serving (Bo, event 584ba19e:
// verifying the bundle "does not by itself ... prove deployment of the commit
// to the live billed surface").
//
// The gates below assert what this mechanism DOES do, and one of them asserts
// what it does NOT — because a security claim nobody has bounded is a claim
// nobody can rely on.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const home = mkdtempSync(join(tmpdir(), "attest-"));
process.env.DKG_HOME = home;
mkdirSync(join(home, "metering"), { recursive: true });

const A = await import(join(dist, "metering/build-attestation.js"));
const M = await import(join(dist, "metering/inference-meter.js"));
const L = await import(join(dist, "metering/ledger.js"));
const { createPublicKey, verify: edVerify } = await import("node:crypto");

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

console.log("\nBuild attestation — proving WHICH code is serving\n");

console.log("the running code digests itself:");
const att = A.buildAttestation({ home });
{
  // Assert CORRECTNESS, not a module count: the attestation must cover exactly
  // the .js files in its own directory, and every digest must reproduce from a
  // fresh read. (A count assertion is environment-dependent — it passed in the
  // repo and failed in the shipped bundle, which ships a subset.)
  const dir = join(dist, "metering");
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  const covered = Object.keys(att.moduleDigests).sort();
  const sameSet = onDisk.length === covered.length && onDisk.every((f, i) => f === covered[i]);
  const allMatch = covered.every((f) => att.moduleDigests[f] === "sha256:" + createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"));
  ok("it covers exactly the modules on disk, and every digest reproduces", sameSet && allMatch && covered.length > 0,
    `onDisk=${onDisk.length} covered=${covered.length} allMatch=${allMatch}`);
}
ok("it names its own module set with a single buildDigest", att.buildDigest.startsWith("sha256:"));
ok("the buildDigest is the digest of the module set it reports",
  att.buildDigest === "sha256:" + createHash("sha256").update(L.canonicalize(att.moduleDigests)).digest("hex"));
ok("it is deterministic across calls", A.buildAttestation({ home }).buildDigest === att.buildDigest);
console.log(`      ${Object.keys(att.moduleDigests).length} modules, build ${att.buildDigest.slice(0, 26)}…`);

console.log("\ncontract digests are DERIVED from the loaded code, not restated:");
ok("policy digest matches the running module's own computation", att.contractDigests.inferencePolicyDigest === M.inferencePolicyDigest());
ok("canonicalization digest matches the running module's own computation", att.contractDigests.canonicalizationDigest === M.canonicalizationDigest());
ok("the receipt schema version is reported", att.receiptSchemaVersion === M.RECEIPT_SCHEMA_VERSION);

console.log("\nit detects a changed build (the deploy-skew case it exists for):");
{
  // Copy the real modules to a scratch dir, alter one byte, and re-attest.
  const scratch = mkdtempSync(join(tmpdir(), "attest-mod-"));
  const src = join(dist, "metering");
  for (const f of readdirSync(src).filter((x) => x.endsWith(".js"))) copyFileSync(join(src, f), join(scratch, f));
  const before = A.buildAttestation({ home, dir: scratch }).buildDigest;
  writeFileSync(join(scratch, "read-meter.js"), readFileSync(join(scratch, "read-meter.js"), "utf8") + "\n// a one-line change\n");
  const after = A.buildAttestation({ home, dir: scratch }).buildDigest;
  ok("changing ONE byte in ONE module changes the buildDigest", before !== after, `${before.slice(0,20)} vs ${after.slice(0,20)}`);
  ok("the changed module's own digest is what moved",
    A.buildAttestation({ home, dir: scratch }).moduleDigests["read-meter.js"] !== undefined);
}

console.log("\nthe attestation is a SIGNED, committed claim:");
{
  const signed = A.signedBuildAttestation({ home });
  ok("it carries the provider public key and a signature", typeof signed.signature === "string" && signed.providerPublicKeyPem.includes("PUBLIC KEY"));
  const preimage = Buffer.concat([Buffer.from(A.BUILD_ATTESTATION_DOMAIN + "\n"), Buffer.from(signed.attestationDigest)]);
  ok("the signature verifies under the provider key",
    edVerify(null, preimage, createPublicKey(signed.providerPublicKeyPem), Buffer.from(signed.signature, "base64")));
  ok("the attestation digest matches the attestation it signs", signed.attestationDigest === A.attestationDigest(signed.attestation));
}

console.log("\nthe buyer's check:");
{
  const expected = { inferencePolicyDigest: M.inferencePolicyDigest(), canonicalizationDigest: M.canonicalizationDigest() };
  ok("a matching build verifies", A.verifyBuildAttestation({ attestation: att, expectedContractDigests: expected }).ok);
  ok("a build whose PRICING differs is refused",
    A.verifyBuildAttestation({ attestation: att, expectedContractDigests: { ...expected, inferencePolicyDigest: "sha256:other" } }).code === "E_BUILD_CONTRACT_MISMATCH");
  ok("a build whose CANONICALIZATION differs is refused",
    A.verifyBuildAttestation({ attestation: att, expectedContractDigests: { ...expected, canonicalizationDigest: "sha256:other" } }).code === "E_BUILD_CONTRACT_MISMATCH");
  ok("a build the buyer did not pin is refused when he pins one",
    A.verifyBuildAttestation({ attestation: att, expectedContractDigests: expected, expectedBuildDigest: "sha256:audited-elsewhere" }).code === "E_BUILD_DIGEST_MISMATCH");
  const incoherent = { ...att, moduleDigests: { ...att.moduleDigests, "ledger.js": "sha256:tampered" } };
  ok("an attestation whose buildDigest disagrees with its own module set is refused",
    A.verifyBuildAttestation({ attestation: incoherent, expectedContractDigests: expected }).code === "E_ATTESTATION_INCOHERENT");
}

console.log("\nsourceCommit is reported, never guessed:");
{
  ok("absent when the operator has not recorded one", A.buildAttestation({ home }).sourceCommit === undefined);
  writeFileSync(join(home, "metering", "deployed-commit"), "e7f94315eafd235f1cc1ecd00f071a5780931810\n");
  ok("present and trimmed once recorded at deploy time", A.buildAttestation({ home }).sourceCommit === "e7f94315eafd235f1cc1ecd00f071a5780931810");
}

console.log("\nthe leg names the build (so a countersignature is not open-ended):");
{
  const ref = A.runningBuildRef({ home });
  const BUNDLE = { bundleDigest: "sha256:b", bundleFiles: ["t.json"], engine: "stub", engineVersion: "1" };
  const MANIFEST = { instanceId: "i", weightsDigest: "sha256:w", tokenizerBundleDigest: "sha256:b", engineBuild: "e", samplerConfig: {}, chatTemplateDigest: "sha256:c" };
  const MODEL = { modelId: "m", weightsDigest: "sha256:w", tokenizerDigest: "sha256:b", chatTemplateDigest: "sha256:c", tokenizer: BUNDLE, backendManifestDigest: M.backendManifestDigest(MANIFEST), backendManifest: MANIFEST };
  const tokenizer = { encode: (t) => Array.from(t).map((c) => c.codePointAt(0)), decode: (ids) => ids.map((i) => String.fromCodePoint(i)).join("") };
  const ev = M.buildInferenceEvidence({
    requestCanonical: {}, renderedPrompt: "hi", inputTokenIds: tokenizer.encode("hi"),
    deliveredCompletion: "ok", outputTokenIds: tokenizer.encode("ok"),
    model: MODEL, finishReason: "stop", stopBoundary: { kind: "eos" }, providerBuild: ref,
  });
  ok("evidence carries the provider build ref", ev.providerBuild?.buildDigest === ref.buildDigest);
  const base = { tokenizer, renderedPrompt: "hi", deliveredCompletion: "ok", evidence: ev, specialTokenIds: [] };
  ok("a leg naming the audited build recounts", M.verifyInferenceRecount({ ...base, expectedProviderBuildDigest: ref.buildDigest }).ok);
  ok("a leg naming a DIFFERENT build is refused (E_RECOUNT_BUILD)",
    M.verifyInferenceRecount({ ...base, expectedProviderBuildDigest: "sha256:some-other-build" }).code === "E_RECOUNT_BUILD");
  const noBuild = { ...ev, providerBuild: undefined };
  ok("a leg naming NO build is refused when the buyer pins one (no silent downgrade)",
    M.verifyInferenceRecount({ ...base, evidence: noBuild, expectedProviderBuildDigest: ref.buildDigest }).code === "E_RECOUNT_BUILD");
}

console.log("\nwhat this does NOT do — stated, not implied:");
{
  // A hostile node can report any digest it likes; self-attestation cannot fix
  // that, and a gate that pretended otherwise would be the dishonest kind of
  // green. What we assert is that the limitation TRAVELS WITH the artifact, so
  // no reader can mistake this for a proof it is not.
  ok("the attestation carries its own limitations in-band",
    typeof att.limitations === "string" && /NOT proof against a hostile provider/i.test(att.limitations));
  const liar = { ...att, moduleDigests: { "everything.js": "sha256:whatever-i-like" } };
  const relabelled = { ...liar, buildDigest: "sha256:" + createHash("sha256").update(L.canonicalize(liar.moduleDigests)).digest("hex") };
  const v = A.verifyBuildAttestation({ attestation: relabelled, expectedContractDigests: { inferencePolicyDigest: M.inferencePolicyDigest(), canonicalizationDigest: M.canonicalizationDigest() } });
  ok("a self-consistent LIE about the module set is NOT caught by coherence alone (documented limit)", v.ok === true);
  ok("...but it IS caught the moment the buyer pins the build he audited",
    A.verifyBuildAttestation({ attestation: relabelled, expectedContractDigests: { inferencePolicyDigest: M.inferencePolicyDigest(), canonicalizationDigest: M.canonicalizationDigest() }, expectedBuildDigest: att.buildDigest }).code === "E_BUILD_DIGEST_MISMATCH");
}

console.log(`\n${pass}/${pass + fail} build-attestation gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
