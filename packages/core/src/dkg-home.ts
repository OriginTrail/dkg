/**
 * Shared helpers for resolving DKG_HOME, API port, PID, and auth tokens.
 *
 * These were previously duplicated across cli, mcp-server, and adapter-openclaw.
 * Centralizing them here ensures consistent behavior everywhere.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** Resolve the DKG home directory ($DKG_HOME or ~/.dkg). */
export function dkgHomeDir(): string {
  return process.env.DKG_HOME ?? join(homedir(), '.dkg');
}

/** Read the daemon PID from $DKG_HOME/daemon.pid. Returns null if missing or invalid. */
export async function readDaemonPid(dkgHome?: string): Promise<number | null> {
  try {
    const raw = await readFile(join(dkgHome ?? dkgHomeDir(), 'daemon.pid'), 'utf-8');
    return parseStrictPosInt(raw.trim());
  } catch {
    return null;
  }
}

/** Check whether a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the API port from $DKG_API_PORT env or $DKG_HOME/api.port file.
 * If $DKG_API_PORT is set but invalid, returns null immediately (does not
 * fall through to the file) to avoid silently connecting to a stale port.
 */
export async function readDkgApiPort(dkgHome?: string): Promise<number | null> {
  if (process.env.DKG_API_PORT !== undefined) {
    return parsePort(process.env.DKG_API_PORT.trim());
  }

  try {
    const raw = await readFile(join(dkgHome ?? dkgHomeDir(), 'api.port'), 'utf-8');
    return parsePort(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Load the first non-comment, non-blank line from $DKG_HOME/auth.token.
 * Returns undefined if the file does not exist or is unreadable.
 */
export function loadAuthTokenSync(dkgHome?: string): string | undefined {
  const filePath = join(dkgHome ?? dkgHomeDir(), 'auth.token');
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith('#')) return t;
    }
  } catch { /* unreadable */ }
  return undefined;
}

const DECIMAL_INT_RE = /^[0-9]+$/;

/**
 * Parse a string as a strict positive decimal integer.
 * Rejects empty strings, hex (0x...), scientific notation (1e3), floats, and negative values.
 */
function parseStrictPosInt(value: string): number | null {
  if (!DECIMAL_INT_RE.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
}

/** Parse a string as a valid TCP port (1–65535). Only accepts decimal digit strings. */
function parsePort(value: string): number | null {
  const n = parseStrictPosInt(value);
  if (n === null || n > 65535) return null;
  return n;
}

/** Async variant of loadAuthTokenSync. */
export async function loadAuthToken(dkgHome?: string): Promise<string | undefined> {
  const filePath = join(dkgHome ?? dkgHomeDir(), 'auth.token');
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = await readFile(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith('#')) return t;
    }
  } catch { /* unreadable */ }
  return undefined;
}

const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/;

/**
 * T62 / T63 — EIP-55 mixed-case checksum for an eth address.
 *
 * Originally added to convert lowercase keystore JSON keys to checksum form
 * because the daemon stores chat-turn graph URIs in EIP-55 case. T63 retired
 * that path: the adapter now HTTP-probes `/api/agent/identity` and gets the
 * canonical form directly from the daemon, so this helper's keystore-read
 * use is gone.
 *
 * Retained narrow purpose: normalize the `DKG_AGENT_ADDRESS` env override on
 * remote-daemon deployments (where there's no keystore + no HTTP probe to
 * derive the canonical case). Operators are likely to supply lowercase
 * (matches the keystore JSON they peeked at); silent SPARQL miss is a
 * worse failure mode than a one-shot normalization.
 *
 * @param address - hex-encoded eth address, with or without `0x` prefix.
 *                  Case-insensitive on input.
 * @returns The address in EIP-55 mixed-case form, with `0x` prefix.
 */
export function toEip55Checksum(address: string): string {
  const lower = address.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) {
    throw new Error(`toEip55Checksum: not a 40-hex-digit eth address: ${address}`);
  }
  // EIP-55 hashes the lowercase HEX STRING (ASCII bytes), then uppercases each
  // alpha character in the address whose corresponding hash nibble is >= 8.
  const hashBytes = keccak_256(new TextEncoder().encode(lower));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (ch >= 'a' && ch <= 'f') {
      // Each byte yields two hex nibbles. Even index → high nibble.
      const byte = hashBytes[i >> 1];
      const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
      out += nibble >= 8 ? ch.toUpperCase() : ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Thrown by `loadAgentAuthToken*` when the keystore contains more than one
 * eth-address top-level key and no `explicitAddress` override was provided.
 *
 * The single-agent path is the common gateway/dev shape; multi-agent
 * deployments must explicitly disambiguate (typically via the
 * `DKG_AGENT_ADDRESS` env var) so the WM-view scope can never silently route
 * memory writes to one identity and reads to another.
 */
export class MultipleAgentsError extends Error {
  readonly addresses: readonly string[];
  constructor(addresses: readonly string[]) {
    super(
      `agent-keystore.json contains ${addresses.length} agent identities (${addresses.join(', ')}); ` +
      `set DKG_AGENT_ADDRESS to disambiguate.`,
    );
    this.name = 'MultipleAgentsError';
    this.addresses = addresses;
  }
}

/**
 * Filter and lowercase eth-address keys from the keystore JSON. Non-eth-shaped
 * keys are dropped (defensive against future schema mixins / corrupted files).
 *
 * T46 — Deduped after lowercasing. A keystore that recorded the same identity
 * under both checksum and lowercase form (e.g. operator hand-edited the file,
 * or two writer paths used different normalisation) would otherwise be flagged
 * as multi-agent and disable WM lookup even though it's a single identity.
 * `Set` over the post-lowercase keys collapses the duplicate to one entry
 * before the multi-agent guardrail counts them.
 *
 * T63 — No longer applies EIP-55 checksumming. The adapter resolves the
 * canonical eth via the daemon's `/api/agent/identity` HTTP probe; this
 * helper is now only used to enumerate keys for the multi-agent guardrail
 * and for case-insensitive matching against an explicit env override.
 */
function extractEthAddressKeys(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const lc = Object.keys(parsed as Record<string, unknown>)
    .map((k) => k.toLowerCase())
    .filter((k) => ETH_ADDR_RE.test(k));
  return Array.from(new Set(lc));
}

/**
 * Resolve an explicit override (typically `process.env.DKG_AGENT_ADDRESS`)
 * against the eth-address shape.
 *
 * T63 — Returns the LOWERCASE form for case-insensitive comparison against
 * keystore keys. Callers that need the canonical EIP-55 form for downstream
 * use (the remote-daemon `nodeAgentAddress` set-direct path) should call
 * `toEip55Checksum` themselves on the result.
 *
 * Returns `undefined` if the override is absent or not a valid eth address —
 * the helper's caller then falls through to the keystore read path.
 */
function resolveExplicitAddress(explicit: string | undefined): string | undefined {
  if (typeof explicit !== 'string') return undefined;
  const t = explicit.trim().toLowerCase();
  if (!ETH_ADDR_RE.test(t)) return undefined;
  return t;
}

/**
 * Load the agent's auth token from `<DKG_HOME>/agent-keystore.json`.
 *
 * T63 — Replaces `loadAgentEthAddressSync`. The adapter no longer derives
 * the eth address from the keystore JSON key; instead it reads the agent's
 * auth token here, then HTTP-probes the daemon's `/api/agent/identity`
 * endpoint with that token to get the canonical eth (the daemon already
 * stores it in EIP-55 form via `verifyWallet.address`). Single source of
 * truth, no case-conversion plumbing in the adapter.
 *
 * The keystore is written by `packages/agent/src/dkg-agent.ts:saveToKeystore`
 * as `{ <lowercase-eth>: { authToken, privateKey? } }`.
 *
 * - Single-agent keystore: returns `{ authToken: parsed[onlyKey].authToken }`.
 * - Multi-agent keystore + no `explicitAddress`: throws `MultipleAgentsError`
 *   (refuse to guess — silent mis-routing across identities is a
 *   security/correctness footgun).
 * - Multi-agent keystore + `explicitAddress` matching one entry (case-
 *   insensitive): returns that entry's `authToken`.
 * - Missing/empty/malformed keystore: returns `undefined` (caller's
 *   "keystore absent" path takes over).
 * - Missing `authToken` field on a present eth entry: returns `undefined`
 *   (treated as malformed entry).
 *
 * `opts.explicitAddress` (typically `process.env.DKG_AGENT_ADDRESS`) is the
 * disambiguator for multi-agent setups. The eth address sent on the wire
 * comes from the daemon's HTTP response, NOT from this argument — operators
 * who want to override the daemon's reported identity entirely (remote-daemon
 * deployments) handle that at the call site, not here.
 */
export function loadAgentAuthTokenSync(
  dkgHome?: string,
  opts?: { explicitAddress?: string },
): { authToken: string } | undefined {
  const filePath = join(dkgHome ?? dkgHomeDir(), 'agent-keystore.json');
  if (!existsSync(filePath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }

  return resolveAuthTokenFromParsed(parsed, opts?.explicitAddress);
}

/** Async variant of `loadAgentAuthTokenSync`. */
export async function loadAgentAuthToken(
  dkgHome?: string,
  opts?: { explicitAddress?: string },
): Promise<{ authToken: string } | undefined> {
  const filePath = join(dkgHome ?? dkgHomeDir(), 'agent-keystore.json');
  if (!existsSync(filePath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return undefined;
  }

  return resolveAuthTokenFromParsed(parsed, opts?.explicitAddress);
}

/**
 * Shared resolution body for sync + async `loadAgentAuthToken*`.
 * Walks the parsed keystore, applies the multi-agent guardrail, picks the
 * matching entry, and extracts its `authToken` field.
 */
function resolveAuthTokenFromParsed(
  parsed: unknown,
  explicitAddress: string | undefined,
): { authToken: string } | undefined {
  const keys = extractEthAddressKeys(parsed);
  if (keys.length === 0) return undefined;

  let chosenKey: string;
  if (keys.length === 1) {
    chosenKey = keys[0];
  } else {
    const explicit = resolveExplicitAddress(explicitAddress);
    if (!explicit) throw new MultipleAgentsError(keys);
    const match = keys.find((k) => k === explicit);
    if (!match) throw new MultipleAgentsError(keys);
    chosenKey = match;
  }

  // The keystore JSON's keys may be in any case (typically lowercase per
  // `saveToKeystore` normalization, but defensively also accept others).
  // We've already lowercased and deduped via `extractEthAddressKeys`; pull
  // the entry by case-insensitive lookup against the original parsed object.
  const obj = parsed as Record<string, unknown>;
  const entry = Object.entries(obj).find(([k]) => k.toLowerCase() === chosenKey)?.[1];
  if (!entry || typeof entry !== 'object') return undefined;
  const tok = (entry as Record<string, unknown>).authToken;
  if (typeof tok !== 'string' || tok.length === 0) return undefined;
  return { authToken: tok };
}
