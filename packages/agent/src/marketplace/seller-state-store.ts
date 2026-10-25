/**
 * Durable seller-side marketplace state under the node data dir (the same
 * placement as the buyer's `marketplace/session-key.json`):
 *
 *  - `seller-consumed-auth.jsonl` — one consumed authDigest per line,
 *    append-only on every serve admission so a restart cannot double-serve a
 *    single-use authorization it already burned. Compacted in place (atomic
 *    tmp + rename) once it grows past twice the retention bound.
 *  - `seller-pending-claims.json` — atomic JSON snapshot of the batcher's
 *    unsubmitted `ReceiptClaimInput`s (bigints as decimal strings), rewritten
 *    on every batcher mutation so a crash or restart forfeits nothing.
 *
 * Every operation is best-effort: persistence failures are warned about and
 * swallowed, because the in-memory guard plus the contract's own
 * `consumedAuth` replay guard stay authoritative — a disk fault must degrade
 * durability, never serving.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ReceiptClaimInput } from '@origintrail-official/dkg-marketplace';

const CONSUMED_AUTH_FILE = 'seller-consumed-auth.jsonl';
const PENDING_CLAIMS_FILE = 'seller-pending-claims.json';

const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;

interface PersistedClaim {
  buyer: string;
  epoch: string;
  offeringId: string;
  callId: string;
  maxUnits: string;
  askPerUnitWei: string;
  expiry: string;
  servedUnits: string;
  resultCommitment: string;
  authSignature: string;
}

function toPersistedClaim(claim: ReceiptClaimInput): PersistedClaim {
  return {
    buyer: claim.buyer,
    epoch: claim.epoch.toString(),
    offeringId: claim.offeringId,
    callId: claim.callId,
    maxUnits: claim.maxUnits.toString(),
    askPerUnitWei: claim.askPerUnitWei.toString(),
    expiry: claim.expiry.toString(),
    servedUnits: claim.servedUnits.toString(),
    resultCommitment: claim.resultCommitment,
    authSignature: claim.authSignature,
  };
}

function fromPersistedClaim(raw: unknown): ReceiptClaimInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('claim must be an object');
  const claim = raw as Record<string, unknown>;
  const str = (field: string): string => {
    const value = claim[field];
    if (typeof value !== 'string' || value.length === 0) throw new Error(`claim.${field} must be a string`);
    return value;
  };
  return {
    buyer: str('buyer'),
    epoch: BigInt(str('epoch')),
    offeringId: str('offeringId'),
    callId: str('callId'),
    maxUnits: BigInt(str('maxUnits')),
    askPerUnitWei: BigInt(str('askPerUnitWei')),
    expiry: BigInt(str('expiry')),
    servedUnits: BigInt(str('servedUnits')),
    resultCommitment: str('resultCommitment'),
    authSignature: str('authSignature'),
  };
}

/** Atomic small-file write: same-directory temp + rename. */
function writeAtomic(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, contents, { mode: 0o600 });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export class MarketplaceSellerStateStore {
  readonly #consumedAuthPath: string;
  readonly #pendingClaimsPath: string;
  readonly #bound: number;
  readonly #warn: (message: string) => void;
  /** Lines in the consumed-auth file; compaction trips at 2× the bound. */
  #consumedAuthLines = 0;

  constructor(dir: string, bound: number, warn: (message: string) => void) {
    this.#consumedAuthPath = path.join(dir, CONSUMED_AUTH_FILE);
    this.#pendingClaimsPath = path.join(dir, PENDING_CLAIMS_FILE);
    this.#bound = bound;
    this.#warn = warn;
  }

  /** The persisted consumed authDigests, oldest first, capped to the bound. */
  loadConsumedAuth(): string[] {
    try {
      const raw = fs.readFileSync(this.#consumedAuthPath, 'utf8');
      const digests = raw
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => BYTES32_PATTERN.test(line));
      this.#consumedAuthLines = digests.length;
      return digests.slice(-this.#bound);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.#warn(`[marketplace] could not read ${this.#consumedAuthPath} — replay cache starts cold: `
          + `${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    }
  }

  /** Append one burned digest; compacts to the newest `bound` lines at 2×. */
  appendConsumedAuth(authDigest: string): void {
    try {
      fs.mkdirSync(path.dirname(this.#consumedAuthPath), { recursive: true });
      fs.appendFileSync(this.#consumedAuthPath, `${authDigest.toLowerCase()}\n`, { mode: 0o600 });
      this.#consumedAuthLines += 1;
      if (this.#consumedAuthLines > this.#bound * 2) this.#compactConsumedAuth();
    } catch (error) {
      this.#warn(`[marketplace] could not persist a consumed authDigest (replay guard stays in-memory): `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #compactConsumedAuth(): void {
    const kept = this.loadConsumedAuth();
    writeAtomic(this.#consumedAuthPath, kept.length > 0 ? `${kept.join('\n')}\n` : '');
    this.#consumedAuthLines = kept.length;
  }

  /** Unsubmitted claims persisted by the last run; invalid files load empty. */
  loadPendingClaims(): ReceiptClaimInput[] {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.#pendingClaimsPath, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('pending-claims file must hold a JSON array');
      return raw.map((entry) => fromPersistedClaim(entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.#warn(`[marketplace] could not read ${this.#pendingClaimsPath} — pending receipts not restored: `
          + `${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    }
  }

  /** Atomic snapshot of the batcher's pending claims. */
  savePendingClaims(claims: readonly ReceiptClaimInput[]): void {
    try {
      writeAtomic(this.#pendingClaimsPath, `${JSON.stringify(claims.map(toPersistedClaim))}\n`);
    } catch (error) {
      this.#warn(`[marketplace] could not persist pending receipt claims: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
