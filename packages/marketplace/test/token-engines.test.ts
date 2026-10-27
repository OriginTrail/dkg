import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createHfBpeEngine,
  createStubWordsEngine,
  createTiktokenO200kEngine,
  createTokenCountEngine,
  isTokenizerKind,
  sha256Digest,
  SHA256_DIGEST_PATTERN,
  STUB_WORDS_DIGEST,
  TOKENIZER_KINDS,
  TokenizerFileError,
  TokenizerRegistry,
} from '../src/index.js';
import { oracleHfCount, oracleTiktokenCount } from './oracle-bpe.js';

const HF_FIXTURE = readFileSync(new URL('./fixtures/tiny-tokenizer.json', import.meta.url));
const TIKTOKEN_FIXTURE = readFileSync(new URL('./fixtures/tiny-o200k.tiktoken', import.meta.url));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(next: () => number, alphabet: readonly string[], maxLength: number): string {
  const length = Math.floor(next() * (maxLength + 1));
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}

describe('stub-words-v1 (GV-1)', () => {
  const stub = createStubWordsEngine();

  it('counts whitespace-separated words exactly like the llm-stub', () => {
    const cases: Array<[string, number]> = [
      ['', 0],
      ['   ', 0],
      ['hello marketplace world', 3],
      ['  multiple   spaces\tand\nnewlines  ', 4],
      ['STUB:WORLD MARKETPLACE HELLO :: ok', 5],
      ['{"a":1}', 1],
    ];
    for (const [text, expected] of cases) expect(stub.encodeCount(text), JSON.stringify(text)).toBe(expected);
  });

  it('pins kind and digest', () => {
    expect(stub.kind).toBe('stub-words-v1');
    expect(STUB_WORDS_DIGEST).toBe('sha256:77c4f56809020ef019a66d94aeb5e2f45cd300521472a4418c7ab4e502215c95');
    expect(stub.digest).toBe(STUB_WORDS_DIGEST);
    expect(createTokenCountEngine('stub-words-v1')).toBe(stub);
  });
});

describe('hf-bpe-v1 (tiny-tokenizer.json fixture)', () => {
  const hf = createHfBpeEngine(HF_FIXTURE);

  it('digests the raw file bytes', () => {
    expect(hf.kind).toBe('hf-bpe-v1');
    expect(hf.digest).toBe('sha256:814067c4216253a6fc3e496acf22cd69a7dad1677ab8a2c91cc9cd17652a6c18');
    expect(hf.digest).toBe(sha256Digest(HF_FIXTURE));
  });

  it('pins hand-checked counts (merges a b → ab c → Ġ a)', () => {
    const cases: Array<[string, number]> = [
      ['', 0],
      ['abc', 1], // a b → ab, ab c → abc
      [' a', 1], // Ġ a → Ġa
      [' abc', 2], // a b ranks before Ġ a: Ġ + abc
      ['abcabc', 2], // one letter piece, every occurrence merges
      ['aaa', 3], // no a a merge
      ['x', 1], // unknown piece counts one
      ['é', 2], // two UTF-8 bytes, no merges
      ['12', 2], // individual digits
      ['hello world', 11],
    ];
    for (const [text, expected] of cases) expect(hf.encodeCount(text), JSON.stringify(text)).toBe(expected);
  });

  it('accepts [a, b] merge pairs identically to "a b" strings', () => {
    const pairs = createHfBpeEngine(
      utf8(JSON.stringify({ model: { type: 'BPE', vocab: {}, merges: [['a', 'b'], ['ab', 'c'], ['Ġ', 'a']] } })),
    );
    for (const text of ['abc', ' abc', ' a', 'abcabc ab']) expect(pairs.encodeCount(text)).toBe(hf.encodeCount(text));
  });

  it('refuses unparseable files', () => {
    const bad = (s: string | Uint8Array) => () => createHfBpeEngine(typeof s === 'string' ? utf8(s) : s);
    expect(bad('not json')).toThrow(TokenizerFileError);
    expect(bad('{}')).toThrow('missing model object');
    expect(bad(JSON.stringify({ model: { vocab: {} } }))).toThrow('model.merges');
    expect(bad(JSON.stringify({ model: { merges: [] } }))).toThrow('model.vocab');
    expect(bad(JSON.stringify({ model: { type: 'Unigram', vocab: {}, merges: [] } }))).toThrow('not BPE');
    expect(bad(JSON.stringify({ model: { vocab: {}, merges: ['ab'] } }))).toThrow('model.merges[0]');
    expect(bad(JSON.stringify({ model: { vocab: {}, merges: [['a']] } }))).toThrow('model.merges[0]');
    expect(bad(Uint8Array.from([0xff, 0xfe]))).toThrow('not valid UTF-8');
    expect(() => createTokenCountEngine('hf-bpe-v1')).toThrow('file bytes are required');
  });
});

describe('tiktoken-o200k-v1 (tiny-o200k.tiktoken fixture)', () => {
  const tk = createTiktokenO200kEngine(TIKTOKEN_FIXTURE);

  it('digests the raw file bytes', () => {
    expect(tk.kind).toBe('tiktoken-o200k-v1');
    expect(tk.digest).toBe('sha256:efa66a1f402dc42b6fd0fee4fc3dd0d4affa38c7283efff42b70d0317bd281a1');
    expect(tk.digest).toBe(sha256Digest(TIKTOKEN_FIXTURE));
  });

  it('pins hand-checked counts (ranks a b c space ab abc)', () => {
    const cases: Array<[string, number]> = [
      ['', 0],
      ['abc', 1],
      [' a', 2], // " a" is not a token
      [' abc', 2], // " " + abc
      ['aaa', 3],
      ['x', 1], // unknown byte counts one
      ['é', 2], // multi-byte character
      ['12', 2],
      ["it's", 4], // one o200k piece, four unmerged bytes
      ['abc\n\nabc', 4],
    ];
    for (const [text, expected] of cases) expect(tk.encodeCount(text), JSON.stringify(text)).toBe(expected);
  });

  it('refuses unparseable rank files', () => {
    const bad = (s: string) => () => createTiktokenO200kEngine(utf8(s));
    expect(bad('')).toThrow('no ranks');
    expect(bad('YQ==\n')).toThrow('line 1');
    expect(bad('YQ== x\n')).toThrow('line 1');
    expect(bad('YQ== 0\n*** 1\n')).toThrow('line 2');
    expect(bad('YQ== -1\n')).toThrow('line 1');
    expect(() => createTokenCountEngine('tiktoken-o200k-v1')).toThrow('file bytes are required');
  });
});

describe('engine invariants', () => {
  const engines = [createStubWordsEngine(), createHfBpeEngine(HF_FIXTURE), createTiktokenO200kEngine(TIKTOKEN_FIXTURE)];
  const alphabet = ['a', 'b', 'c', 'x', ' ', '  ', '\t', '\n', '1', '9', 'é', '👋', '漢', '́', "'", '!', ' ', '　'];

  it('count ≤ utf8Bytes for random strings (fixed seed), every engine', () => {
    const next = prng(0x5eed);
    for (let i = 0; i < 400; i++) {
      const text = randomString(next, alphabet, 64);
      for (const engine of engines) expect(engine.encodeCount(text)).toBeLessThanOrEqual(utf8Bytes(text));
    }
  });

  it('registry: stub-words pre-registered, file engines by kind and digest', () => {
    const registry = new TokenizerRegistry();
    expect(registry.get('stub-words-v1', STUB_WORDS_DIGEST)).toBe(createStubWordsEngine());
    const hf = createTokenCountEngine('hf-bpe-v1', HF_FIXTURE);
    expect(registry.get('hf-bpe-v1', hf.digest)).toBeUndefined();
    registry.register(hf);
    expect(registry.get('hf-bpe-v1', hf.digest)).toBe(hf);
    expect(registry.get('tiktoken-o200k-v1', hf.digest)).toBeUndefined();
    expect(() => registry.register({ kind: 'stub-words-v1', digest: 'sha256:nope', encodeCount: () => 0 })).toThrow(
      'invalid tokenizer digest',
    );
  });

  it('kind guards and the digest pattern', () => {
    expect(TOKENIZER_KINDS).toEqual(['hf-bpe-v1', 'tiktoken-o200k-v1', 'stub-words-v1']);
    expect(isTokenizerKind('hf-bpe-v1')).toBe(true);
    expect(isTokenizerKind('cl100k')).toBe(false);
    expect(isTokenizerKind(undefined)).toBe(false);
    expect(SHA256_DIGEST_PATTERN.test(STUB_WORDS_DIGEST)).toBe(true);
    expect(SHA256_DIGEST_PATTERN.test(STUB_WORDS_DIGEST.toUpperCase())).toBe(false);
  });
});

/** A BPE-consistent random merge list: every merge combines symbols that already exist. */
function randomConsistentMerges(next: () => number, letters: readonly string[], count: number): Array<[string, string]> {
  const symbols = [...letters];
  const seen = new Set<string>();
  const merges: Array<[string, string]> = [];
  while (merges.length < count) {
    const a = symbols[Math.floor(next() * symbols.length)];
    const b = symbols[Math.floor(next() * symbols.length)];
    if (seen.has(`${a} ${b}`) || (a + b).length > 6) continue;
    seen.add(`${a} ${b}`);
    merges.push([a, b]);
    if (!symbols.includes(a + b)) symbols.push(a + b);
  }
  return merges;
}

describe('differential test against the verbatim fork loops', () => {
  it('fixtures: equal counts on hand cases and 500 seeded random strings', () => {
    const hf = createHfBpeEngine(HF_FIXTURE);
    const tk = createTiktokenO200kEngine(TIKTOKEN_FIXTURE);
    const hfOracle = oracleHfCount(HF_FIXTURE.toString('utf8'));
    const tkOracle = oracleTiktokenCount(TIKTOKEN_FIXTURE.toString('utf8'));
    const next = prng(2027);
    const alphabet = ['a', 'b', 'c', ' ', 'x', '1', 'é', '\n'];
    const texts = ['abc', ' abc', 'abcabcab cab', 'ab ab abc', ...Array.from({ length: 500 }, () => randomString(next, alphabet, 40))];
    for (const text of texts) {
      expect(hf.encodeCount(text), JSON.stringify(text)).toBe(hfOracle(text));
      expect(tk.encodeCount(text), JSON.stringify(text)).toBe(tkOracle(text));
    }
  });

  it('random BPE-consistent vocabularies: equal counts (HF and tiktoken)', () => {
    const next = prng(77);
    const letters = ['a', 'b', 'c', 'd'];
    for (let round = 0; round < 8; round++) {
      const merges = randomConsistentMerges(next, letters, 24);
      const tokenizerJson = JSON.stringify({ model: { type: 'BPE', vocab: {}, merges: merges.map(([a, b]) => `${a} ${b}`) } });
      const tokens = [...letters, ...merges.map(([a, b]) => a + b)];
      const unique = [...new Set(tokens)];
      const rankFile = unique.map((t, i) => `${Buffer.from(t, 'latin1').toString('base64')} ${i}`).join('\n');
      const hf = createHfBpeEngine(utf8(tokenizerJson));
      const tk = createTiktokenO200kEngine(utf8(rankFile));
      const hfOracle = oracleHfCount(tokenizerJson);
      const tkOracle = oracleTiktokenCount(rankFile);
      for (let i = 0; i < 60; i++) {
        const text = randomString(next, ['a', 'b', 'c', 'd', 'aa', 'ab', 'cd'], 48);
        expect(hf.encodeCount(text), `round ${round} ${text}`).toBe(hfOracle(text));
        expect(tk.encodeCount(text), `round ${round} ${text}`).toBe(tkOracle(text));
      }
    }
  });
});

describe('bounded cost (O(n log n) merge loops)', () => {
  /**
   * 26 letters, then merges forming every prefix of a 4096-letter
   * pseudo-random sequence. The sequence never repeats its opening bigram, so
   * every repetition of it merges through the whole 4095-deep chain into
   * exactly one token — the worst case for a rescan-per-merge loop.
   */
  function chainVocab(): { sequence: string; tokenizerJson: Uint8Array; rankFile: Uint8Array } {
    const next = prng(4096);
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let sequence = 'ab';
    while (sequence.length < 4095) {
      const letter = letters[Math.floor(next() * 26)];
      if (sequence.endsWith('a') && letter === 'b') continue;
      sequence += letter;
    }
    sequence += 'z'; // the repetition boundary never forms the opening bigram either
    const merges: string[] = [];
    for (let k = 1; k < sequence.length; k++) merges.push(`${sequence.slice(0, k)} ${sequence[k]}`);
    const tokenizerJson = utf8(JSON.stringify({ model: { type: 'BPE', vocab: {}, merges } }));
    const tokens = new Set<string>(letters);
    for (let k = 2; k <= sequence.length; k++) tokens.add(sequence.slice(0, k));
    const rankFile = utf8([...tokens].map((t, i) => `${Buffer.from(t, 'latin1').toString('base64')} ${i}`).join('\n'));
    return { sequence, tokenizerJson, rankFile };
  }

  it('a 2 MiB single-piece input counts in < 3 s on both engines', () => {
    const { sequence, tokenizerJson, rankFile } = chainVocab();
    const hf = createHfBpeEngine(tokenizerJson);
    const tk = createTiktokenO200kEngine(rankFile);
    // The heap engines agree with the oracle on this vocabulary (short input).
    const small = `${sequence.slice(0, 300)}${sequence.slice(0, 200)}q${sequence.slice(0, 120)}`;
    expect(hf.encodeCount(small)).toBe(oracleHfCount(new TextDecoder().decode(tokenizerJson))(small));
    expect(tk.encodeCount(small)).toBe(oracleTiktokenCount(new TextDecoder().decode(rankFile))(small));
    expect(hf.encodeCount(small)).toBe(4);

    const repetitions = (2 * 1024 * 1024) / sequence.length;
    const input = sequence.repeat(repetitions);
    expect(utf8Bytes(input)).toBe(2 * 1024 * 1024);
    for (const engine of [hf, tk]) {
      const started = performance.now();
      const count = engine.encodeCount(input);
      const elapsed = performance.now() - started;
      expect(count, engine.kind).toBe(repetitions); // 512 one-token repetitions
      expect(elapsed, `${engine.kind} took ${elapsed.toFixed(0)} ms`).toBeLessThan(3000);
    }
  });
});
