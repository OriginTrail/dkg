/**
 * Token count engines for pinned-tokenizer metering. Both seats (the seller
 * that bills and the buyer that recounts) run the same engine over the same
 * committed bytes, so a count is reproducible without carrying token ids.
 *
 * Three kinds:
 *   - `hf-bpe-v1`: a HF `tokenizer.json` (byte-level BPE, Qwen2 pre-split with
 *     individual digits) — port of the fork's `hfEngine`.
 *   - `tiktoken-o200k-v1`: a `.tiktoken` rank file with the o200k pre-split —
 *     port of the fork's `tiktokenEngine`.
 *   - `stub-words-v1`: whitespace word count, no file. The devnet engine; it
 *     reproduces the llm-stub `usage` formula exactly.
 *
 * The pin digest of a file kind is `sha256:` + sha256 of the ONE file the
 * engine loads — exactly the bytes that determine the count. Every engine
 * counts at most one unit per UTF-8 byte, which is what makes the buyer's
 * strict byte upper bound (`chatPromptUpperBound`) safe for any pin.
 */
import { createHash } from 'node:crypto';
import { BpeScratch, mergeCount, type MergeTables, type PairLookup } from './bpe-core.js';

export const TOKENIZER_KINDS = ['hf-bpe-v1', 'tiktoken-o200k-v1', 'stub-words-v1'] as const;

export type TokenizerKind = (typeof TOKENIZER_KINDS)[number];

export function isTokenizerKind(v: unknown): v is TokenizerKind {
  return typeof v === 'string' && (TOKENIZER_KINDS as readonly string[]).includes(v);
}

/** Every content digest in RDF, JSON and APIs: `sha256:<64 lowercase hex>`. */
export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** `sha256:` + hex sha256 of raw bytes, or of the UTF-8 encoding of a string. */
export function sha256Digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Pin digest of the file-less `stub-words-v1` engine. */
export const STUB_WORDS_DIGEST = sha256Digest('dkg-mkt-count/stub-words-v1');

export interface TokenCountEngine {
  readonly kind: TokenizerKind;
  /** The pin digest (see the module comment). */
  readonly digest: string;
  /** Deterministic and pure; `encodeCount(text) ≤ utf8Bytes(text)` for every kind. */
  encodeCount(text: string): number;
}

/** A tokenizer file that cannot be parsed as the declared kind. */
export class TokenizerFileError extends Error {
  constructor(kind: TokenizerKind, detail: string) {
    super(`${kind} tokenizer file is unusable: ${detail}`);
    this.name = 'TokenizerFileError';
  }
}

const utf8Encoder = new TextEncoder();

// ── GPT-2 byte↔unicode table (verbatim fork `bytesToUnicode`) ───────────────
function bytesToUnicode(): Record<number, string> {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const map: Record<number, string> = {};
  bs.forEach((b, i) => {
    map[b] = String.fromCodePoint(cs[i]);
  });
  return map;
}
const B2U = bytesToUnicode();

// Qwen2.5 pre-tokenizer: GPT-2-style split + individual digits (verbatim fork).
const QWEN_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
// o200k_base pattern (verbatim fork transcription).
const O200K_SPLIT =
  /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?:'s|'t|'re|'ve|'m|'ll|'d)?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?:'s|'t|'re|'ve|'m|'ll|'d)?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const DIGIT = /\p{N}/u;

/** Bound on per-call pair-lookup memo entries (cleared, never wrong, when hit). */
const PAIR_MEMO_CAP = 1 << 20;

function decodeUtf8File(kind: TokenizerKind, bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TokenizerFileError(kind, 'file bytes are required');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TokenizerFileError(kind, 'file is not valid UTF-8');
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseHfMerge(kind: TokenizerKind, merge: unknown, index: number): [string, string] {
  if (typeof merge === 'string') {
    // Fork semantics: `"a b".split(" ")`, first two fields.
    const parts = merge.split(' ');
    if (parts.length >= 2) return [parts[0], parts[1]];
  } else if (Array.isArray(merge) && merge.length === 2 && typeof merge[0] === 'string' && typeof merge[1] === 'string') {
    return [merge[0], merge[1]];
  }
  throw new TokenizerFileError(kind, `model.merges[${index}] is neither "a b" nor [a, b]`);
}

/** HF `tokenizer.json` engine: merge-rank BPE over byte-level unicode symbols. */
export function createHfBpeEngine(tokenizerJson: Uint8Array): TokenCountEngine {
  const kind: TokenizerKind = 'hf-bpe-v1';
  const text = decodeUtf8File(kind, tokenizerJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TokenizerFileError(kind, 'file is not JSON');
  }
  const model = isPlainObject(parsed) ? parsed.model : undefined;
  if (!isPlainObject(model)) throw new TokenizerFileError(kind, 'missing model object');
  if (model.type !== undefined && model.type !== 'BPE') {
    throw new TokenizerFileError(kind, `model.type ${JSON.stringify(model.type)} is not BPE`);
  }
  if (!isPlainObject(model.vocab)) throw new TokenizerFileError(kind, 'model.vocab must be an object');
  if (!Array.isArray(model.merges)) throw new TokenizerFileError(kind, 'model.merges must be an array');

  // Symbols are interned to integer ids so a merge never hashes a long string.
  const ids = new Map<string, number>();
  const intern = (symbol: string): number => {
    let id = ids.get(symbol);
    if (id === undefined) {
      id = ids.size;
      ids.set(symbol, id);
    }
    return id;
  };
  const merges = model.merges as unknown[];
  const leftIds = new Int32Array(merges.length);
  const rightIds = new Int32Array(merges.length);
  const resultOf = new Int32Array(merges.length);
  const rankOf = new Float64Array(merges.length);
  for (let i = 0; i < merges.length; i++) {
    const [a, b] = parseHfMerge(kind, merges[i], i);
    leftIds[i] = intern(a);
    rightIds[i] = intern(b);
    resultOf[i] = intern(a + b);
    rankOf[i] = i;
  }
  const width = ids.size;
  // A repeated pair keeps its LAST rank — the fork's `new Map(entries)` rule.
  const pairs = new Map<number, number>();
  for (let i = 0; i < merges.length; i++) pairs.set(leftIds[i] * width + rightIds[i], i);
  const byteSymbol = new Int32Array(256);
  for (let b = 0; b < 256; b++) byteSymbol[b] = ids.get(B2U[b]) ?? -1;
  const lookup: PairLookup = (left, right) => pairs.get(left * width + right) ?? -1;
  const tables: MergeTables = { rankOf, resultOf };

  const countPiece = (scratch: BpeScratch, piece: string): number => {
    const bytes = utf8Encoder.encode(piece);
    scratch.ensure(bytes.length);
    for (let i = 0; i < bytes.length; i++) scratch.sym[i] = byteSymbol[bytes[i]];
    return mergeCount(scratch, bytes.length, lookup, tables);
  };

  return Object.freeze({
    kind,
    digest: sha256Digest(tokenizerJson),
    encodeCount(input: string): number {
      const scratch = new BpeScratch();
      let count = 0;
      for (const match of input.matchAll(QWEN_SPLIT)) {
        const chunk = match[0];
        if (!DIGIT.test(chunk)) {
          count += countPiece(scratch, chunk);
          continue;
        }
        // individual_digits: every numeric code point is its own piece (Qwen).
        let buffer = '';
        for (const ch of chunk) {
          if (DIGIT.test(ch)) {
            if (buffer) {
              count += countPiece(scratch, buffer);
              buffer = '';
            }
            count += countPiece(scratch, ch);
          } else {
            buffer += ch;
          }
        }
        if (buffer) count += countPiece(scratch, buffer);
      }
      return count;
    },
  });
}

const BASE64_FIELD = /^[A-Za-z0-9+/]+={0,2}$/;
const RANK_FIELD = /^\d+$/;
const BYTE_STRINGS = Array.from({ length: 256 }, (_, b) => String.fromCharCode(b));

/** tiktoken engine: rank-table BPE directly on UTF-8 bytes, o200k pre-split. */
export function createTiktokenO200kEngine(rankFile: Uint8Array): TokenCountEngine {
  const kind: TokenizerKind = 'tiktoken-o200k-v1';
  const text = decodeUtf8File(kind, rankFile);
  // each line: <base64 bytes> <rank>; a repeated token keeps its last rank.
  const ranks = new Map<string, number>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const [b64, rawRank] = line.split(' ');
    const rank = rawRank?.trim();
    if (!BASE64_FIELD.test(b64) || rank === undefined || !RANK_FIELD.test(rank) || !Number.isSafeInteger(Number(rank))) {
      throw new TokenizerFileError(kind, `line ${i + 1} is not "<base64> <rank>"`);
    }
    const token = Buffer.from(b64, 'base64');
    if (token.length === 0) throw new TokenizerFileError(kind, `line ${i + 1} decodes to an empty token`);
    ranks.set(token.toString('latin1'), Number(rank));
  }
  if (ranks.size === 0) throw new TokenizerFileError(kind, 'no ranks');

  // Symbol ids: 0..255 are raw bytes, 256 + t is token t of the rank table.
  const tokenStrings: string[] = [];
  const tokenIndex = new Map<string, number>();
  const rankOf = new Float64Array(ranks.size);
  const resultOf = new Int32Array(ranks.size);
  for (const [token, rank] of ranks) {
    const index = tokenStrings.length;
    tokenStrings.push(token);
    tokenIndex.set(token, index);
    rankOf[index] = rank;
    resultOf[index] = 256 + index;
  }
  const width = 256 + tokenStrings.length;
  const symbolString = (id: number): string => (id < 256 ? BYTE_STRINGS[id] : tokenStrings[id - 256]);
  const tables: MergeTables = { rankOf, resultOf };

  return Object.freeze({
    kind,
    digest: sha256Digest(rankFile),
    encodeCount(input: string): number {
      const scratch = new BpeScratch();
      // Per-call memo: a pair is resolved by string once, then by integer key.
      const memo = new Map<number, number>();
      const lookup: PairLookup = (left, right) => {
        const key = left * width + right;
        let merge = memo.get(key);
        if (merge === undefined) {
          merge = tokenIndex.get(symbolString(left) + symbolString(right)) ?? -1;
          if (memo.size >= PAIR_MEMO_CAP) memo.clear();
          memo.set(key, merge);
        }
        return merge;
      };
      let count = 0;
      for (const match of input.matchAll(O200K_SPLIT)) {
        const bytes = utf8Encoder.encode(match[0]);
        scratch.ensure(bytes.length);
        for (let i = 0; i < bytes.length; i++) scratch.sym[i] = bytes[i];
        count += mergeCount(scratch, bytes.length, lookup, tables);
      }
      return count;
    },
  });
}

const STUB_WORDS_ENGINE: TokenCountEngine = Object.freeze({
  kind: 'stub-words-v1' as const,
  digest: STUB_WORDS_DIGEST,
  encodeCount(text: string): number {
    // Byte-identical to `words(text).length` in the devnet llm-stub.
    const trimmed = text.trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  },
});

/** The file-less devnet engine: whitespace-separated word count. */
export function createStubWordsEngine(): TokenCountEngine {
  return STUB_WORDS_ENGINE;
}

/** Build an engine by kind; throws `TokenizerFileError` when a file kind lacks bytes or they are unusable. */
export function createTokenCountEngine(kind: TokenizerKind, fileBytes?: Uint8Array): TokenCountEngine {
  switch (kind) {
    case 'stub-words-v1':
      return createStubWordsEngine();
    case 'hf-bpe-v1':
      if (!fileBytes) throw new TokenizerFileError(kind, 'file bytes are required');
      return createHfBpeEngine(fileBytes);
    case 'tiktoken-o200k-v1':
      if (!fileBytes) throw new TokenizerFileError(kind, 'file bytes are required');
      return createTiktokenO200kEngine(fileBytes);
    default:
      throw new TokenizerFileError(kind, 'unknown tokenizer kind');
  }
}

/** Digest-keyed engine lookup; `stub-words-v1` is pre-registered. */
export class TokenizerRegistry {
  readonly #engines = new Map<string, TokenCountEngine>();

  constructor() {
    this.register(createStubWordsEngine());
  }

  register(engine: TokenCountEngine): void {
    if (!isTokenizerKind(engine.kind)) throw new Error(`unknown tokenizer kind: ${String(engine.kind)}`);
    if (!SHA256_DIGEST_PATTERN.test(engine.digest)) throw new Error(`invalid tokenizer digest: ${engine.digest}`);
    this.#engines.set(`${engine.kind}|${engine.digest}`, engine);
  }

  get(kind: TokenizerKind, digest: string): TokenCountEngine | undefined {
    return this.#engines.get(`${kind}|${digest}`);
  }
}
