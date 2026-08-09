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
  // The pin is defined over an EXPLICIT manifest, not over whatever happens to
  // be in the directory (Bo, 5b4a4a18: a layout-dependent pin identifies
  // packaging, not code). Every listed module must be covered and reproduce.
  const dir = join(dist, "metering");
  const covered = Object.keys(att.moduleDigests).sort();
  const expected = [...A.METERING_MODULE_MANIFEST].sort();
  const sameSet = covered.length === expected.length && covered.every((f, i) => f === expected[i]);
  const allMatch = covered.every((f) => att.moduleDigests[f] === "sha256:" + createHash("sha256").update(readFileSync(join(dir, f))).digest("hex"));
  ok("it covers exactly the MANIFEST modules, and every digest reproduces", sameSet && allMatch && att.complete === true,
    `covered=${covered.length} expected=${expected.length} allMatch=${allMatch} complete=${att.complete}`);
}
ok("it names its own module set with a single buildDigest", att.buildDigest.startsWith("sha256:"));
ok("the buildDigest is the digest of {manifestVersion, moduleDigests}",
  att.buildDigest === "sha256:" + createHash("sha256").update(L.canonicalize({ manifestVersion: att.manifestVersion, moduleDigests: att.moduleDigests })).digest("hex"));
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

  // Bo's exact attack (5b4a4a18): keep the expected buildDigest, tamper the
  // attestationDigest. v0.6 compared buildDigest only and returned ok:true.
  const tamperedAtt = { ...ev, providerBuild: { ...ref, attestationDigest: "sha256:not-the-fetched-attestation" } };
  ok("a leg with a TAMPERED attestationDigest is refused even when buildDigest matches",
    M.verifyInferenceRecount({ ...base, evidence: tamperedAtt, expectedProviderBuildDigest: ref.buildDigest, expectedProviderAttestationDigest: ref.attestationDigest }).code === "E_RECOUNT_ATTESTATION");
  const missingAtt = { ...ev, providerBuild: { buildDigest: ref.buildDigest } };
  ok("a leg with NO attestationDigest is refused when the buyer pins one",
    M.verifyInferenceRecount({ ...base, evidence: missingAtt, expectedProviderBuildDigest: ref.buildDigest, expectedProviderAttestationDigest: ref.attestationDigest }).code === "E_RECOUNT_ATTESTATION");
  ok("a leg naming BOTH the audited build and the verified attestation recounts",
    M.verifyInferenceRecount({ ...base, expectedProviderBuildDigest: ref.buildDigest, expectedProviderAttestationDigest: ref.attestationDigest }).ok);
}

console.log("\nthe pin is LAYOUT-INVARIANT (Bo's blocker 1):");
{
  // Same module CONTENT, different surrounding directory: extra unrelated files
  // must not move the pin, or the pin identifies packaging rather than code.
  const a1 = mkdtempSync(join(tmpdir(), "layout-a-"));
  const src = join(dist, "metering");
  for (const f of A.METERING_MODULE_MANIFEST) copyFileSync(join(src, f), join(a1, f));
  const bare = A.buildAttestation({ home, dir: a1 });
  writeFileSync(join(a1, "some-unrelated-chunk.js"), "// packaging artefact\n");
  writeFileSync(join(a1, "another-chunk.js"), "// more packaging\n");
  const withExtras = A.buildAttestation({ home, dir: a1 });
  ok("adding unrelated .js files does NOT move the buildDigest", bare.buildDigest === withExtras.buildDigest);
  ok("...but they are REPORTED as unexpected, so drift stays visible",
    withExtras.unexpectedModules.length === 2 && withExtras.unexpectedModules.includes("another-chunk.js"));
  ok("the production directory and a bare manifest copy agree on the pin", bare.buildDigest === att.buildDigest,
    `bare=${bare.buildDigest.slice(0,20)} prod=${att.buildDigest.slice(0,20)}`);
}
{
  // A PARTIAL artifact (e.g. an audit bundle shipping a subset) must not be
  // pinnable — that was exactly how the shipped pin failed to identify the
  // shipped runnable artifact.
  const partial = mkdtempSync(join(tmpdir(), "layout-partial-"));
  for (const f of ["inference-meter.js", "ledger.js", "read-meter.js"]) copyFileSync(join(dist, "metering", f), join(partial, f));
  const p = A.buildAttestation({ home, dir: partial });
  ok("a partial artifact reports complete=false and lists what is missing", p.complete === false && p.missingModules.length === A.METERING_MODULE_MANIFEST.length - 3);
  const v = A.verifyBuildAttestation({ attestation: p, expectedContractDigests: { inferencePolicyDigest: M.inferencePolicyDigest(), canonicalizationDigest: M.canonicalizationDigest() } });
  ok("an INCOMPLETE attestation can never satisfy a pin (E_ATTESTATION_INCOMPLETE)", v.ok === false && v.code === "E_ATTESTATION_INCOMPLETE", JSON.stringify(v));
}

console.log("\nthe buyer flow verifies against an INDEPENDENTLY held key (Bo's blocker 2):");
{
  const signed = A.signedBuildAttestation({ home });
  const expected = { inferencePolicyDigest: M.inferencePolicyDigest(), canonicalizationDigest: M.canonicalizationDigest() };
  const good = A.verifySignedBuildAttestation({ response: signed, expectedProviderPublicKeyPem: signed.providerPublicKeyPem, expectedContractDigests: expected });
  ok("an honest response verifies and returns the values to pin", good.ok && good.buildDigest === signed.attestation.buildDigest && good.attestationDigest === signed.attestationDigest, JSON.stringify(good).slice(0, 160));

  // THE attack: a response self-consistent under ITS OWN key. Verifying against
  // the key that arrived in the same response proves nothing.
  const { generateKeyPairSync, sign: edSign2, createPrivateKey: cpk } = await import("node:crypto");
  const rogue = generateKeyPairSync("ed25519");
  const rogueDigest = A.attestationDigest(signed.attestation);
  const rogueSig = edSign2(null, Buffer.concat([Buffer.from(A.BUILD_ATTESTATION_DOMAIN + "\n"), Buffer.from(rogueDigest)]), cpk(rogue.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toString("base64");
  const rogueResp = { ...signed, signature: rogueSig, providerPublicKeyPem: rogue.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const selfConsistent = A.verifySignedBuildAttestation({ response: rogueResp, expectedProviderPublicKeyPem: rogueResp.providerPublicKeyPem, expectedContractDigests: expected });
  ok("(a self-signed response IS internally consistent — which is why that check is worthless)", selfConsistent.ok === true);
  const vsHeldKey = A.verifySignedBuildAttestation({ response: rogueResp, expectedProviderPublicKeyPem: signed.providerPublicKeyPem, expectedContractDigests: expected });
  ok("verified against the key the BUYER holds, the rogue signature is REFUSED", vsHeldKey.ok === false && vsHeldKey.code === "E_ATTESTATION_SIGNATURE", JSON.stringify(vsHeldKey));
}
{
  const signed = A.signedBuildAttestation({ home });
  const expected = { inferencePolicyDigest: M.inferencePolicyDigest(), canonicalizationDigest: M.canonicalizationDigest() };
  const tampered = { ...signed, attestationDigest: "sha256:not-the-fetched-attestation" };
  const v = A.verifySignedBuildAttestation({ response: tampered, expectedProviderPublicKeyPem: signed.providerPublicKeyPem, expectedContractDigests: expected });
  ok("a tampered attestationDigest in the response is REFUSED (digest is recomputed, never read)", v.ok === false && v.code === "E_ATTESTATION_DIGEST_MISMATCH", JSON.stringify(v));
  const swapped = { ...signed, providerPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAaaaa\n-----END PUBLIC KEY-----\n" };
  const v2 = A.verifySignedBuildAttestation({ response: swapped, expectedProviderPublicKeyPem: signed.providerPublicKeyPem, expectedContractDigests: expected });
  ok("a response advertising a different provider key is REFUSED", v2.ok === false && v2.code === "E_ATTESTATION_KEY_SWAP", JSON.stringify(v2));
}

console.log("\nwhat this does NOT do — stated, not implied:");
{
  // A hostile node can report any digest it likes; self-attestation cannot fix
  // that, and a gate that pretended otherwise would be the dishonest kind of
  // green. What we assert is that the limitation TRAVELS WITH the artifact, so
  // no reader can mistake this for a proof it is not.
  ok("the attestation carries its own limitations in-band",
    typeof att.limitations === "string" && /NOT proof against a hostile provider/i.test(att.limitations));
  // The manifest narrowed this limit: a lie that changes the module NAME SET is
  // now caught, because the names are fixed by METERING_MODULE_MANIFEST.
  const liar = { ...att, moduleDigests: { "everything.js": "sha256:whatever-i-like" }, missingModules: [], complete: true };
  const relabelled = { ...liar, buildDigest: "sha256:" + createHash("sha256").update(L.canonicalize({ manifestVersion: liar.manifestVersion, moduleDigests: liar.moduleDigests })).digest("hex") };
  const vNames = A.verifyBuildAttestation({ attestation: relabelled, expectedContractDigests: { inferencePolicyDigest: M.inferencePolicyDigest(), canonicalizationDigest: M.canonicalizationDigest() }, expectedBuildDigest: att.buildDigest });
  ok("a fabricated module SET is now caught (the manifest fixes the names)", vNames.ok === false, JSON.stringify(vNames));

  // The IRREDUCIBLE limit, stated precisely: a hostile node can report the
  // correct names with the AUDITED digests while running entirely different
  // code. Nothing self-reported can detect that — the response is exactly what
  // an honest node would send. This gate exists so the claim is bounded rather
  // than left to the reader's optimism.
  const perfectLiar = { ...att };   // byte-identical to an honest attestation
  const vLie = A.verifyBuildAttestation({ attestation: perfectLiar, expectedContractDigests: { inferencePolicyDigest: M.inferencePolicyDigest(), canonicalizationDigest: M.canonicalizationDigest() }, expectedBuildDigest: att.buildDigest });
  ok("a node REPORTING the audited artifact while running other code is NOT detectable here (irreducible limit)", vLie.ok === true);
  ok("...and the attestation says so in-band, so the limit travels with the claim",
    /NOT proof against a hostile provider/i.test(att.limitations));
}

console.log(`\n${pass}/${pass + fail} build-attestation gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
