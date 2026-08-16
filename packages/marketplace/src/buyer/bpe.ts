// Buyer-local byte-level BPE — the independent token recount engine.
//
// Two formats, covering both provenance classes:
//   · HF tokenizer.json (vocab + merges + pre-tokenizer) — Qwen family (⛓).
//     Same algorithm the Iteration-2 recount used to independently reproduce
//     Hermes's 32-token count from source.
//   · tiktoken .tiktoken (base64-token → rank) with a known pattern — o200k_base
//     etc. for ☁ upstream-claimed counts.
//
// No network, no provider endpoints: the engine runs entirely from bundle bytes
// the buyer fetched and digest-verified itself.

// ── GPT-2 byte↔unicode table (shared by both formats' byte-level handling) ──
function bytesToUnicode(): Record<number, string> {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const map: Record<number, string> = {};
  bs.forEach((b, i) => { map[b] = String.fromCodePoint(cs[i]); });
  return map;
}
const B2U = bytesToUnicode();
const toByteLevel = (s: string): string => [...Buffer.from(s, "utf8")].map((b) => B2U[b]).join("");

// Qwen2.5 pre-tokenizer: GPT-2-style split + individual digits.
const QWEN_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
// o200k_base pattern (from tiktoken), close transcription.
const O200K_SPLIT = /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?:'s|'t|'re|'ve|'m|'ll|'d)?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?:'s|'t|'re|'ve|'m|'ll|'d)?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n\/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

export interface BpeEngine {
  kind: "hf" | "tiktoken";
  encodeCount(text: string): number;      // token COUNT — what pricing needs
  encode(text: string): number[];         // full ids (hf only meaningful vs vocab)
  unknownPieces(text: string): number;    // pieces not in vocab (must be 0)
}

// ── HF tokenizer.json engine (merge-rank BPE on byte-level unicode) ──
export function hfEngine(tokenizerJson: string): BpeEngine {
  const tk = JSON.parse(tokenizerJson) as {
    model: { vocab: Record<string, number>; merges: Array<string | [string, string]> };
  };
  const vocab = tk.model.vocab;
  const merges = tk.model.merges.map((m) => (Array.isArray(m) ? m : (m.split(" ") as [string, string])));
  const rank = new Map(merges.map(([a, b], i) => [a + " " + b, i]));

  function bpe(token: string): string[] {
    let word = [...token];
    if (word.length <= 1) return word;
    for (;;) {
      let best: [string, string] | null = null, bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const r = rank.get(word[i] + " " + word[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; best = [word[i], word[i + 1]]; }
      }
      if (!best) break;
      const merged = best[0] + best[1];
      const out: string[] = [];
      for (let i = 0; i < word.length;) {
        if (i < word.length - 1 && word[i] === best[0] && word[i + 1] === best[1]) { out.push(merged); i += 2; }
        else { out.push(word[i]); i++; }
      }
      word = out;
    }
    return word;
  }

  function pieces(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(QWEN_SPLIT)) {
      const chunk = m[0];
      // individual_digits: split numeric runs to single digits (Qwen)
      const subs: string[] = [];
      let buf = "";
      for (const ch of chunk) {
        if (/\p{N}/u.test(ch)) { if (buf) { subs.push(buf); buf = ""; } subs.push(ch); }
        else buf += ch;
      }
      if (buf) subs.push(buf);
      for (const s of subs) out.push(...bpe(toByteLevel(s)));
    }
    return out;
  }

  return {
    kind: "hf",
    encodeCount: (t) => pieces(t).length,
    encode: (t) => pieces(t).map((p) => vocab[p] ?? -1),
    unknownPieces: (t) => pieces(t).filter((p) => vocab[p] === undefined).length,
  };
}

// ── tiktoken engine (rank-table BPE directly on bytes) ──
export function tiktokenEngine(tiktokenFile: string): BpeEngine {
  // each line: <base64 bytes> <rank>
  const ranks = new Map<string, number>();
  for (const line of tiktokenFile.split("\n")) {
    if (!line.trim()) continue;
    const [b64, r] = line.split(" ");
    ranks.set(Buffer.from(b64, "base64").toString("latin1"), Number(r));
  }

  function bpeCount(chunk: Buffer): { count: number; unknown: number } {
    let parts: string[] = [...chunk].map((b) => String.fromCharCode(b));
    if (parts.length === 0) return { count: 0, unknown: 0 };
    for (;;) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = ranks.get(parts[i] + parts[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
      }
      if (best < 0) break;
      parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
    }
    return { count: parts.length, unknown: parts.filter((p) => !ranks.has(p)).length };
  }

  function run(text: string): { count: number; unknown: number } {
    let count = 0, unknown = 0;
    for (const m of text.matchAll(O200K_SPLIT)) {
      const r = bpeCount(Buffer.from(m[0], "utf8"));
      count += r.count; unknown += r.unknown;
    }
    return { count, unknown };
  }

  return {
    kind: "tiktoken",
    encodeCount: (t) => run(t).count,
    encode: () => { throw new Error("tiktoken engine exposes counts, not ids"); },
    unknownPieces: (t) => run(t).unknown,
  };
}
