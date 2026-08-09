// Inference meter — gates, including the recount attacks Bo (buyer seat) named.
//
// The property under test is the one Bo insisted on: recount is DECODE the
// billable token-IDs and match the delivered bytes — never re-run the model.
// The attacks: a provider padding the billable sequence with empty-decode
// tokens, a special/EOS token smuggled into the billable output, a byte
// mismatch between the decoded sequence and what was delivered.
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const M = await import(join(dist, "metering/inference-meter.js"));
const { canonicalize } = await import(join(dist, "metering/ledger.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };
const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");

// ── a deterministic stub tokenizer: word ↔ id, plus adversarial tokens ──
// id 1000 = EOS (special), id 2000 = an EMPTY-DECODE token (decodes to "").
const VOCAB = ["", "the", "cat", "sat", "on", "mat", " ", "hello", "world"];
const idOf = (w) => { const i = VOCAB.indexOf(w); return i >= 0 ? i : VOCAB.push(w) - 1; };
const tokenizer = {
  encode(text, _opts) {
    // split preserving spaces into tokens the vocab can round-trip
    return [...text.matchAll(/ |[^ ]+/g)].map((m) => idOf(m[0]));
  },
  decode(ids, _opts) {
    return ids.map((id) => {
      if (id === 1000) return "";      // EOS decodes to nothing (special)
      if (id === 2000) return "";      // empty-decode padding token (special)
      if (id === 3000) return "";      // empty-decode token that is NOT special
      return VOCAB[id] ?? "";
    }).join("");
  },
};
const SPECIAL = [1000, 2000];  // provider must not bill these
const MODEL = { modelId: "stub/qwen", weightsDigest: "sha256:w", tokenizerDigest: "sha256:t", chatTemplateDigest: "sha256:c" };

console.log("\nInference meter — pricing + recount contract (Bo-ratified)\n");

console.log("pricing:");
ok("policy digest is stable", M.inferencePolicyDigest() === M.inferencePolicyDigest());
ok("cost = 2·in + 6·out (output dearer)", M.inferenceCostMicroTrac(10, 5) === 2 * 10 + 6 * 5);
ok("cost never negative", M.inferenceCostMicroTrac(-3, -3) === 0);

// ── build an HONEST leg: prompt "the cat" → completion "sat on mat" ──
const rendered = "the cat";
const completion = "sat on mat";
const inIds = tokenizer.encode(rendered, { add_special_tokens: false });
const outIds = tokenizer.encode(completion, { add_special_tokens: false });
const evidence = M.buildInferenceEvidence({ requestCanonical: { m: "x" }, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: outIds, model: MODEL });

console.log("\nhonest recount:");
{
  const v = M.verifyInferenceRecount({ tokenizer, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: outIds, evidence, specialTokenIds: SPECIAL });
  ok("an honest leg recounts and prices", v.ok && v.costMicroTrac === M.inferenceCostMicroTrac(inIds.length, outIds.length), JSON.stringify(v));
  ok("recount is by DECODE, not by re-running the model", v.ok);  // no model call anywhere in this file
}

console.log("\nBo's attacks:");
{
  // Attack 1: pad the billable output with a NON-special empty-decode token
  // (id 3000). A decode-and-compare check would pass (bytes unchanged) and the
  // special-token check does not apply — only billing the canonical re-encode
  // catches it. Count inflated 3→5, bytes identical.
  const padded = [...outIds, 3000, 3000];
  const evPad = M.buildInferenceEvidence({ requestCanonical: { m: "x" }, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: padded, model: MODEL });
  const v = M.verifyInferenceRecount({ tokenizer, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: padded, evidence: evPad, specialTokenIds: SPECIAL });
  ok("padding billable output with a NON-special empty-decode token is REJECTED (canonical re-encode, not decode-compare)",
    v.ok === false && v.code === "E_RECOUNT_OUTPUT_SEQ", JSON.stringify(v));
}
{
  // Attack 2: smuggle an EOS (id 1000) into the billable output.
  const withEos = [...outIds, 1000];
  const evEos = M.buildInferenceEvidence({ requestCanonical: { m: "x" }, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: withEos, model: MODEL });
  const v = M.verifyInferenceRecount({ tokenizer, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: withEos, evidence: evEos, specialTokenIds: SPECIAL });
  ok("a special/EOS token appended to billable output is REJECTED (not in canonical re-encode)",
    v.ok === false && (v.code === "E_RECOUNT_OUTPUT_SEQ" || v.code === "E_RECOUNT_SPECIAL_TOKEN"), JSON.stringify(v));
}
{
  // Attack 3: output token-IDs whose decode does NOT match the delivered bytes.
  const wrong = tokenizer.encode("hello world", { add_special_tokens: false });
  const evWrong = M.buildInferenceEvidence({ requestCanonical: { m: "x" }, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: wrong, model: MODEL });
  // (evidence built over `wrong`, but delivered was "sat on mat")
  const v = M.verifyInferenceRecount({ tokenizer, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: wrong, evidence: evWrong, specialTokenIds: SPECIAL });
  ok("a claimed output sequence ≠ canonical re-encode of delivered bytes is REJECTED",
    v.ok === false && v.code === "E_RECOUNT_OUTPUT_SEQ", JSON.stringify(v));
}
{
  // Attack 4: tamper the delivered bytes but keep the honest sequence.
  const v = M.verifyInferenceRecount({ tokenizer, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: "sat on MAT", outputTokenIds: outIds, evidence, specialTokenIds: SPECIAL });
  ok("altered delivered bytes are REJECTED (bytes bound to sequence)",
    v.ok === false && v.code === "E_RECOUNT_OUTPUT_BYTES", JSON.stringify(v));
}
{
  // Attack 5: inflate the input count by claiming a different prompt.
  const v = M.verifyInferenceRecount({ tokenizer, renderedPrompt: "the cat sat", inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: outIds, evidence, specialTokenIds: SPECIAL });
  ok("a rendered prompt that does not match the bound digest is REJECTED",
    v.ok === false && v.code === "E_RECOUNT_INPUT_BYTES", JSON.stringify(v));
}
{
  // Attack 6: count field disagrees with the sequence length.
  const evBadCount = { ...evidence, outputTokens: evidence.outputTokens + 5 };
  const v = M.verifyInferenceRecount({ tokenizer, renderedPrompt: rendered, inputTokenIds: inIds, deliveredCompletion: completion, outputTokenIds: outIds, evidence: evBadCount, specialTokenIds: SPECIAL });
  ok("a leg count that disagrees with the sequence length is REJECTED",
    v.ok === false && (v.code === "E_RECOUNT_OUTPUT_SEQ" || v.code === "E_RECOUNT_COUNT_MISMATCH"), JSON.stringify(v));
}

console.log(`\n${pass}/${pass + fail} inference-meter gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
