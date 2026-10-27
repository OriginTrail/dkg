/**
 * TEST ORACLE ONLY — the verbatim fork merge loops (`buyer/bpe.ts`
 * `hfEngine` / `tiktokenEngine`, counting paths only). They are O(n²) per
 * pre-tokenized piece, which is why `src/bpe-core.ts` replaces them; they are
 * kept here so the differential test can prove the heap implementation
 * counts identically.
 */

function bytesToUnicode(): Record<number, string> {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++)
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  const map: Record<number, string> = {};
  bs.forEach((b, i) => {
    map[b] = String.fromCodePoint(cs[i]);
  });
  return map;
}
const B2U = bytesToUnicode();
const toByteLevel = (s: string): string => [...Buffer.from(s, 'utf8')].map((b) => B2U[b]).join('');

const QWEN_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
const O200K_SPLIT =
  /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?:'s|'t|'re|'ve|'m|'ll|'d)?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?:'s|'t|'re|'ve|'m|'ll|'d)?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

export function oracleHfCount(tokenizerJson: string): (text: string) => number {
  const tk = JSON.parse(tokenizerJson) as {
    model: { merges: Array<string | [string, string]> };
  };
  const merges = tk.model.merges.map((m) => (Array.isArray(m) ? m : (m.split(' ') as [string, string])));
  const rank = new Map(merges.map(([a, b], i) => [a + ' ' + b, i]));

  function bpe(token: string): string[] {
    let word = [...token];
    if (word.length <= 1) return word;
    for (;;) {
      let best: [string, string] | null = null,
        bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const r = rank.get(word[i] + ' ' + word[i + 1]);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = [word[i], word[i + 1]];
        }
      }
      if (!best) break;
      const merged = best[0] + best[1];
      const out: string[] = [];
      for (let i = 0; i < word.length; ) {
        if (i < word.length - 1 && word[i] === best[0] && word[i + 1] === best[1]) {
          out.push(merged);
          i += 2;
        } else {
          out.push(word[i]);
          i++;
        }
      }
      word = out;
    }
    return word;
  }

  function pieces(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(QWEN_SPLIT)) {
      const chunk = m[0];
      const subs: string[] = [];
      let buf = '';
      for (const ch of chunk) {
        if (/\p{N}/u.test(ch)) {
          if (buf) {
            subs.push(buf);
            buf = '';
          }
          subs.push(ch);
        } else buf += ch;
      }
      if (buf) subs.push(buf);
      for (const s of subs) out.push(...bpe(toByteLevel(s)));
    }
    return out;
  }

  return (text) => pieces(text).length;
}

export function oracleTiktokenCount(tiktokenFile: string): (text: string) => number {
  const ranks = new Map<string, number>();
  for (const line of tiktokenFile.split('\n')) {
    if (!line.trim()) continue;
    const [b64, r] = line.split(' ');
    ranks.set(Buffer.from(b64, 'base64').toString('latin1'), Number(r));
  }

  function bpeCount(chunk: Buffer): number {
    let parts: string[] = [...chunk].map((b) => String.fromCharCode(b));
    if (parts.length === 0) return 0;
    for (;;) {
      let best = -1,
        bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = ranks.get(parts[i] + parts[i + 1]);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      parts = [...parts.slice(0, best), parts[best] + parts[best + 1], ...parts.slice(best + 2)];
    }
    return parts.length;
  }

  return (text) => {
    let count = 0;
    for (const m of text.matchAll(O200K_SPLIT)) count += bpeCount(Buffer.from(m[0], 'utf8'));
    return count;
  };
}
