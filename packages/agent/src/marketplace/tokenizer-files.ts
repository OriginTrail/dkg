/**
 * Tokenizer FILE loading for the pinned count engines (the pure engines live
 * in `@origintrail-official/dkg-marketplace`). The seller loads its offering's
 * pin at mount (the digest of the loaded bytes IS the published pin); the
 * buyer loads `buyer.tokenizers` lazily on first use into a digest-indexed
 * registry — a file that fails to load is logged once and skipped (its
 * offers then recount `unverifiable` / `no-engine` and are sized by the
 * strict byte bound).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  TokenizerRegistry,
  createTokenCountEngine,
  isTokenizerKind,
  type OfferMetering,
  type TokenCountEngine,
  type TokenizerKind,
} from '@origintrail-official/dkg-marketplace';
import type { MarketplaceLogger } from './seller-service.js';

/** Load one engine; throws a content-free Error naming the path. */
export function loadTokenizerEngine(kind: TokenizerKind, path?: string): TokenCountEngine {
  if (!isTokenizerKind(kind)) throw new Error(`unknown tokenizer kind ${JSON.stringify(kind)}`);
  if (kind === 'stub-words-v1') return createTokenCountEngine(kind);
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error(`a ${kind} tokenizer needs an absolute file path`);
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`tokenizer file ${path} is missing or unreadable`);
  }
  try {
    return createTokenCountEngine(kind, bytes);
  } catch (error) {
    throw new Error(`tokenizer file ${path} is not a usable ${kind} file: ${(error as Error).message}`.slice(0, 300));
  }
}

/** The buyer's recount engines: `stub-words-v1` plus the configured files, loaded once on first use. */
export class BuyerTokenizers {
  readonly #files: ReadonlyArray<{ kind: TokenizerKind; path: string }>;
  readonly #log: MarketplaceLogger;
  #registry: TokenizerRegistry | undefined;

  constructor(files: ReadonlyArray<{ kind: TokenizerKind; path: string }> | undefined, log: MarketplaceLogger) {
    this.#files = files ?? [];
    this.#log = log;
  }

  registry(): TokenizerRegistry {
    if (this.#registry) return this.#registry;
    const registry = new TokenizerRegistry();
    for (const file of this.#files) {
      try {
        const engine = loadTokenizerEngine(file.kind, file.path);
        registry.register(engine);
        this.#log.info(`[marketplace] buyer tokenizer loaded: ${engine.kind} ${engine.digest}`);
      } catch (error) {
        this.#log.warn(`[marketplace] buyer tokenizer skipped: ${(error as Error).message}`);
      }
    }
    this.#registry = registry;
    return registry;
  }

  /** The engine an offer's pin names, when this buyer holds it. */
  engineFor(metering: OfferMetering | undefined): TokenCountEngine | undefined {
    if (metering?.basis !== 'pinned') return undefined;
    return this.registry().get(metering.tokenizer.kind, metering.tokenizer.digest);
  }
}
