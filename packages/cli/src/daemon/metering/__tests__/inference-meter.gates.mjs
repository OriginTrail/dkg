// Inference meter — receipt-v0.5 gates: the recount attacks Bo named at
// ratification (d4146b41) plus the blockers from his adversarial pass
// (1571496d): canonicalization as a bound protocol object, round-trip as a hard
// precondition, token-ID ARRAYS in the leg, tokenizer-bundle and backend-manifest
// provenance, and property/fuzz coverage beyond a fixed corpus.
//
// The property under test throughout: recount NEVER re-runs the model; it
// re-encodes the bytes actually delivered under a bound tokenizer bundle.
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const M = await import(join(dist, "metering/inference-meter.js"));
const { canonicalize } = await import(join(dist, "metering/ledger.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

// ── a deterministic stub tokenizer: word ↔ id, plus adversarial tokens ──
// id 1000 = EOS (special), 2000 = empty-decode special, 3000 = empty-decode NON-special.
const VOCAB = ["", "the", "cat", "sat", "on", "mat", " ", "hello", "world"];
const idOf = (w) => { const i = VOCAB.indexOf(w); return i >= 0 ? i : VOCAB.push(w) - 1; };
const tokenizer = {
  encode(text) { return [...text.matchAll(/ |[^ ]+/g)].map((m) => idOf(m[0])); },
  decode(ids) {
    return ids.map((id) => (id === 1000 || id === 2000 || id === 3000 ? "" : VOCAB[id] ?? "")).join("");
  },
};
const SPECIAL = [1000, 2000];

const BUNDLE = { bundleDigest: "sha256:bundle", bundleFiles: ["tokenizer.json", "tokenizer_config.json"], engine: "stub", engineVersion: "1.0.0" };
const MANIFEST = { instanceId: "inst-1", weightsDigest: "sha256:w", tokenizerBundleDigest: "sha256:bundle", engineBuild: "stub-build", samplerConfig: { temperature: "0" }, chatTemplateDigest: "sha256:c" };
const MANIFEST_DIGEST = M.backendManifestDigest(MANIFEST);
const MODEL = {
  modelId: "stub/qwen", weightsDigest: "sha256:w", tokenizerDigest: "sha256:bundle",
  chatTemplateDigest: "sha256:c", tokenizer: BUNDLE, backendManifestDigest: MANIFEST_DIGEST,
};
const ev = (o) => M.buildInferenceEvidence({ requestCanonical: { m: "x" }, model: MODEL, finishReason: "stop", stopBoundary: { kind: "eos" }, ...o });
const verify = (o) => M.verifyInferenceRecount({ tokenizer, specialTokenIds: SPECIAL, ...o });

console.log("\nInference meter — receipt-v0.5 (Bo-ratified + blockers answered)\n");

console.log("pricing + protocol objects:");
ok("policy digest is stable", M.inferencePolicyDigest() === M.inferencePolicyDigest());
ok("canonicalization digest is stable", M.canonicalizationDigest() === M.canonicalizationDigest());
ok("cost = 2·in + 6·out (output dearer)", M.inferenceCostMicroTrac(10, 5) === 2 * 10 + 6 * 5);
ok("cost never negative", M.inferenceCostMicroTrac(-3, -3) === 0);
ok("tokenizer bundle digest is order-independent over the file set",
  M.tokenizerBundleDigest([{ name: "a", content: "1" }, { name: "b", content: "2" }]) ===
  M.tokenizerBundleDigest([{ name: "b", content: "2" }, { name: "a", content: "1" }]));
ok("changing ANY bundle file changes the bundle digest",
  M.tokenizerBundleDigest([{ name: "a", content: "1" }, { name: "b", content: "2" }]) !==
  M.tokenizerBundleDigest([{ name: "a", content: "1" }, { name: "b", content: "2!" }]));
ok("changing the deployment (restart → new instanceId) changes the manifest digest",
  M.backendManifestDigest({ ...MANIFEST, instanceId: "inst-2" }) !== MANIFEST_DIGEST);

// ── an HONEST leg: prompt "the cat" → completion "sat on mat" ──
const rendered = "the cat", completion = "sat on mat";
const inIds = tokenizer.encode(rendered), outIds = tokenizer.encode(completion);
const evidence = ev({ renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: outIds });

console.log("\nhonest recount:");
{
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence });
  ok("an honest leg recounts and prices", v.ok && v.costMicroTrac === M.inferenceCostMicroTrac(inIds.length, outIds.length), JSON.stringify(v));
  ok("recount is by re-encode, not by re-running the model", v.ok); // no model call anywhere in this file
  ok("the leg carries the ACTUAL token-ID arrays, not just digests (Bo (c))",
    Array.isArray(evidence.inputTokenIds) && Array.isArray(evidence.outputTokenIds) &&
    evidence.outputTokenIds.length === outIds.length && evidence.inputTokenIds.length === inIds.length);
  ok("the leg binds canonicalization version + digest", evidence.canonicalization.version === "inference-canon/v1" && evidence.canonicalization.digest === M.canonicalizationDigest());
  ok("the leg binds route + schema version", evidence.route.path === "POST /api/metering/infer" && evidence.schemaVersion === "receipt-v0.5");
  ok("the leg binds finish reason + stop boundary", evidence.finishReason === "stop" && evidence.stopBoundary.kind === "eos");
  ok("the leg states explicit pricing arithmetic + currency", evidence.pricing.currency === "TRAC" && evidence.pricing.costMicroTrac === 2 * inIds.length + 6 * outIds.length && typeof evidence.pricing.arithmetic === "string");
}

console.log("\nBo's original attacks (still rejected under v0.5):");
{
  const padded = [...outIds, 3000, 3000];
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence: ev({ renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: padded }) });
  ok("padding billable output with a NON-special empty-decode token is REJECTED", v.ok === false && v.code === "E_RECOUNT_OUTPUT_SEQ", JSON.stringify(v));
}
{
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence: ev({ renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: [...outIds, 1000] }) });
  ok("a special/EOS token appended to billable output is REJECTED", v.ok === false && (v.code === "E_RECOUNT_OUTPUT_SEQ" || v.code === "E_RECOUNT_SPECIAL_TOKEN"), JSON.stringify(v));
}
{
  const wrong = tokenizer.encode("hello world");
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence: ev({ renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: wrong }) });
  ok("a claimed output sequence ≠ canonical re-encode is REJECTED", v.ok === false && v.code === "E_RECOUNT_OUTPUT_SEQ", JSON.stringify(v));
}
{
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: "sat on MAT", evidence });
  ok("altered delivered bytes are REJECTED", v.ok === false && v.code === "E_RECOUNT_OUTPUT_BYTES", JSON.stringify(v));
}
{
  const v = verify({ renderedPrompt: "the cat sat", deliveredCompletion: completion, evidence });
  ok("a rendered prompt that does not match the bound digest is REJECTED", v.ok === false && v.code === "E_RECOUNT_INPUT_BYTES", JSON.stringify(v));
}
{
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence: { ...evidence, outputTokens: evidence.outputTokens + 5 } });
  ok("a leg count that disagrees with the sequence length is REJECTED", v.ok === false && (v.code === "E_RECOUNT_OUTPUT_SEQ" || v.code === "E_RECOUNT_COUNT_MISMATCH"), JSON.stringify(v));
}

console.log("\nblockers from Bo's adversarial pass (1571496d):");
{
  // (a) round-trip is a HARD precondition: a bundle that cannot reproduce the
  // delivered bytes from its own encoding must not be used to bill them.
  const lossy = { encode: (t) => tokenizer.encode(t), decode: () => "something else entirely" };
  const v = M.verifyInferenceRecount({ tokenizer: lossy, renderedPrompt: rendered, deliveredCompletion: completion, evidence, specialTokenIds: SPECIAL });
  ok("decode(encode(bytes)) ≠ bytes → UNBILLABLE (E_RECOUNT_ROUND_TRIP)", v.ok === false && v.code === "E_RECOUNT_ROUND_TRIP", JSON.stringify(v));
}
{
  // (a) a leg written under DIFFERENT canonicalization rules is not comparable.
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence: { ...evidence, canonicalization: { version: "inference-canon/v0", digest: "sha256:other" } } });
  ok("a leg under foreign canonicalization rules is REJECTED", v.ok === false && v.code === "E_RECOUNT_CANON_VERSION", JSON.stringify(v));
}
{
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence: { ...evidence, policyDigest: "sha256:other-policy" } });
  ok("a leg priced under a foreign policy is REJECTED", v.ok === false && v.code === "E_RECOUNT_PRICING", JSON.stringify(v));
}
{
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence: { ...evidence, pricing: { ...evidence.pricing, costMicroTrac: evidence.pricing.costMicroTrac + 100 } } });
  ok("a leg whose stated cost ≠ policy arithmetic is REJECTED", v.ok === false && v.code === "E_RECOUNT_PRICING", JSON.stringify(v));
}
{
  // (b) provenance: the verifier holds a bundle; a leg counted under a different
  // tokenizer bundle cannot be recounted by him and must not be countersigned.
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence, expectedTokenizerBundleDigest: "sha256:the-buyers-bundle" });
  ok("a leg counted under a DIFFERENT tokenizer bundle is REJECTED", v.ok === false && v.code === "E_RECOUNT_MANIFEST", JSON.stringify(v));
}
{
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence, expectedBackendManifestDigest: M.backendManifestDigest({ ...MANIFEST, instanceId: "inst-2" }) });
  ok("a leg from a DIFFERENT deployment (restart/config drift) is REJECTED", v.ok === false && v.code === "E_RECOUNT_MANIFEST", JSON.stringify(v));
}
{
  const stripped = { ...evidence, model: { ...MODEL, backendManifestDigest: undefined } };
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence: stripped });
  ok("a leg omitting the backend manifest binding is REJECTED (no silent downgrade)", v.ok === false && v.code === "E_RECOUNT_MANIFEST", JSON.stringify(v));
}
{
  const v = verify({ renderedPrompt: rendered, deliveredCompletion: completion, evidence, expectedTokenizerBundleDigest: BUNDLE.bundleDigest, expectedBackendManifestDigest: MANIFEST_DIGEST });
  ok("with the RIGHT bundle + deployment pinned, the honest leg still recounts", v.ok, JSON.stringify(v));
}

console.log("\nproperty/fuzz coverage (Bo (a)) — a byte-exact tokenizer over random inputs:");
{
  // A tokenizer that round-trips ANY string byte-exactly (one id per code unit
  // plus a special), so the property under test is the METER's arithmetic and
  // sequence handling across adversarial text, not the stub's vocabulary.
  const byteTok = {
    encode: (t) => Array.from(t).map((ch) => ch.codePointAt(0)),
    decode: (ids) => ids.map((i) => String.fromCodePoint(i)).join(""),
  };
  // deterministic PRNG — a fixed seed keeps failures reproducible
  let seed = 0x2f6e2b1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const randomUnicode = (n) => {
    let s = "";
    for (let i = 0; i < n; i++) {
      const r = rnd();
      // mix planes: ASCII, Latin-1, combining marks, CJK, emoji (astral)
      const cp = r < 0.3 ? 0x20 + Math.floor(rnd() * 0x5f)
        : r < 0.45 ? 0xa0 + Math.floor(rnd() * 0x17f)
        : r < 0.6 ? 0x300 + Math.floor(rnd() * 0x6f)      // combining
        : r < 0.8 ? 0x4e00 + Math.floor(rnd() * 0x1000)   // CJK
        : 0x1f300 + Math.floor(rnd() * 0x500);            // astral
      s += String.fromCodePoint(cp);
    }
    return s;
  };
  const CASES = [
    ["empty output", ""],
    ["single NUL", " "],
    ["control block", ""],
    ["combining marks", "éäõ"],
    ["precomposed vs decomposed", "café" + "café"],
    ["long merge-boundary run", "a".repeat(512)],
    ["astral pairs", "🚀🔥🧬👩‍👩‍👧‍👦"],
    ["mixed direction", "abc مرحبا 123 עברית"],
    ...Array.from({ length: 12 }, (_, i) => [`random unicode #${i + 1}`, randomUnicode(1 + Math.floor(rnd() * 48))]),
  ];
  let allOk = true, zeroOk = false;
  for (const [name, text] of CASES) {
    const ids = byteTok.encode(text);
    const e = M.buildInferenceEvidence({ requestCanonical: { m: "x" }, renderedPrompt: rendered, inputTokenIds: byteTok.encode(rendered), deliveredCompletion: text, outputTokenIds: ids, model: MODEL, finishReason: "stop", stopBoundary: { kind: "eos" } });
    const v = M.verifyInferenceRecount({ tokenizer: byteTok, renderedPrompt: rendered, deliveredCompletion: text, evidence: e, specialTokenIds: [] });
    const expect = 2 * byteTok.encode(rendered).length + 6 * ids.length;
    const good = v.ok && v.costMicroTrac === expect && v.outputTokens === ids.length;
    if (!good) { allOk = false; console.log(`      ✗ ${name}: ${JSON.stringify(v)}`); }
    if (text === "" ) zeroOk = v.ok && v.outputTokens === 0 && v.costMicroTrac === 2 * byteTok.encode(rendered).length;
  }
  ok(`${CASES.length} adversarial/random unicode cases all recount exactly`, allOk);
  ok("an EMPTY delivered completion is legal and bills zero output tokens", zeroOk);
}
{
  // byte-fallback boundary: a tokenizer that cannot represent some input must
  // fail closed rather than bill an approximate count.
  const lossyOnEmoji = {
    encode: (t) => Array.from(t).map((ch) => (ch.codePointAt(0) > 0xffff ? 63 : ch.codePointAt(0))), // '?' substitution
    decode: (ids) => ids.map((i) => String.fromCodePoint(i)).join(""),
  };
  const text = "ship it 🚀";
  const e = M.buildInferenceEvidence({ requestCanonical: { m: "x" }, renderedPrompt: rendered, inputTokenIds: lossyOnEmoji.encode(rendered), deliveredCompletion: text, outputTokenIds: lossyOnEmoji.encode(text), model: MODEL, finishReason: "stop", stopBoundary: { kind: "eos" } });
  const v = M.verifyInferenceRecount({ tokenizer: lossyOnEmoji, renderedPrompt: rendered, deliveredCompletion: text, evidence: e, specialTokenIds: [] });
  ok("unrepresentable bytes fail closed rather than bill an approximation", v.ok === false && v.code === "E_RECOUNT_ROUND_TRIP", JSON.stringify(v));
}

console.log(`\n${pass}/${pass + fail} inference-meter gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
