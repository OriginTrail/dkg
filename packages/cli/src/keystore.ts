/**
 * Encrypted keystore for DKG node private keys.
 *
 * Encrypts key material at rest using AES-256-GCM with a key derived from a
 * user passphrase via scrypt. Compatible with the Ethereum keystore V3 pattern
 * but simplified for our use case.
 *
 * Usage:
 *   const ks = await encryptKeystore(privateKeyHex, passphrase);
 *   await writeFile('keystore.json', JSON.stringify(ks));
 *   ...
 *   const key = await decryptKeystore(ks, passphrase);
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

export interface EncryptedKeystore {
  version: 1;
  crypto: {
    cipher: 'aes-256-gcm';
    ciphertext: string;
    iv: string;
    tag: string;
    kdf: 'scrypt';
    kdfparams: {
      n: number;
      r: number;
      p: number;
      dklen: number;
      salt: string;
    };
  };
  /** Hex-encoded SHA-256 of the derived key, used for quick passphrase validation. */
  id: string;
}

/**
 * Single owner of the scrypt KDF policy: production parameters, lower and upper
 * bounds, the derived execution budget, and the cost validation that guards it.
 * Encryption, derivation, validation, and the tests all consume THIS object —
 * there is deliberately no second representation to drift from it.
 *
 * Lower bounds (CLI-1): what we MUST enforce on the (untrusted) `kdfparams`
 * block before deriving a key. Without these, an attacker who can write a
 * keystore file can advertise toy scrypt parameters (e.g. N=256, r=1) and force
 * the loader to brute-force in O(1). Production scrypt minimums per draft RFC
 * and OWASP cheat-sheet: N ≥ 2^15, r ≥ 8, p ≥ 1, dklen == 32 (AES-256-GCM),
 * salt ≥ 16 bytes.
 *
 * Upper bounds: the counterpart. The minimums stop a keystore advertising a
 * cost cheap enough to attack; the maximums stop one advertising a cost too
 * expensive to service, which would let a file exhaust the process before any
 * passphrase is checked.
 *
 * The acceptance ceiling and the execution budget are ONE policy. Splitting
 * them is what made two prior revisions wrong:
 *  - `deriveKey` passed a hardcoded `maxmem` of 256 MiB while production writes
 *    N=2^18, r=8 — a working set of *exactly* 256 MiB. OpenSSL enforces
 *    `workingSet + overhead <= maxmem`, so the module's own production
 *    parameters failed with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` ("memory limit
 *    exceeded"). The suite never caught it because it lowers N to 2^15.
 *  - An acceptance ceiling above the execution budget would admit parameters
 *    that then fail inside OpenSSL rather than at our diagnosable boundary.
 * So `executionMaxmemBytes` is derived from `maxWorkingSetBytes` plus an
 * allowance for OpenSSL's own overhead (measured at ~0.3% of the working set;
 * 8 MiB is generous at the ceiling).
 */
export interface ScryptKdfPolicy {
  /** Parameters this module writes when creating a keystore. */
  readonly production: { readonly n: number; readonly r: number; readonly p: number };
  readonly minN: number;
  readonly minR: number;
  readonly minP: number;
  readonly maxP: number;
  readonly requiredDklen: number;
  readonly minSaltBytes: number;
  /** Largest scrypt working set (128 * N * r bytes) we accept. */
  readonly maxWorkingSetBytes: number;
  /** `maxmem` handed to OpenSSL: the ceiling plus its bounded overhead. */
  readonly executionMaxmemBytes: number;
  /** scrypt's working set — the quantity both the ceiling and OpenSSL bound. */
  workingSetBytes(n: number, r: number): number;
  /**
   * Throws a diagnosable error for any parameter set we will not service, so
   * nothing reaches OpenSSL that could only fail there. (Lower bounds live in
   * `decryptKeystore` beside their established "weak keystore" wording.)
   */
  assertCostWithinLimits(n: number, r: number, p: number): void;
}

const SCRYPT_OVERHEAD_ALLOWANCE_BYTES = 8 * 1024 * 1024;

/** scrypt requires N to be a power of two; a non-power-of-two throws deep in OpenSSL. */
function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export const SCRYPT_KDF_POLICY: ScryptKdfPolicy = Object.freeze({
  production: Object.freeze({ n: 2 ** 18, r: 8, p: 1 }),
  minN: 2 ** 15,
  minR: 8,
  minP: 1,
  maxP: 16,
  requiredDklen: 32,
  minSaltBytes: 16,
  maxWorkingSetBytes: 512 * 1024 * 1024,
  executionMaxmemBytes: 512 * 1024 * 1024 + SCRYPT_OVERHEAD_ALLOWANCE_BYTES,
  workingSetBytes(n: number, r: number): number {
    return 128 * n * r;
  },
  assertCostWithinLimits(n: number, r: number, p: number): void {
    if (!isPowerOfTwo(n)) {
      throw new Error(
        `Refusing to load keystore: scrypt N must be a power of two (got n=${n}).`,
      );
    }
    // JSON admits fractional numbers, and `8.5` passes every >=/<= comparison
    // below while OpenSSL rejects it with an opaque ERR_OUT_OF_RANGE. Integer
    // checks here keep the whole contract at this boundary: nothing reaches
    // scrypt that can only fail inside it. (`n` is covered by the power-of-two
    // check above, which implies a safe integer.)
    if (!Number.isSafeInteger(r)) {
      throw new Error(
        `Refusing to load keystore: scrypt r must be an integer (got r=${r}).`,
      );
    }
    if (!Number.isSafeInteger(p)) {
      throw new Error(
        `Refusing to load keystore: scrypt p must be an integer (got p=${p}).`,
      );
    }
    const workingSetBytes = SCRYPT_KDF_POLICY.workingSetBytes(n, r);
    if (!Number.isSafeInteger(workingSetBytes) || workingSetBytes > SCRYPT_KDF_POLICY.maxWorkingSetBytes) {
      throw new Error(
        `Refusing to load keystore: KDF memory cost above maximum (n=${n}, r=${r} implies ${workingSetBytes} bytes > ${SCRYPT_KDF_POLICY.maxWorkingSetBytes}). scrypt memory cost too high.`,
      );
    }
    if (p > SCRYPT_KDF_POLICY.maxP) {
      throw new Error(
        `Refusing to load keystore: KDF parameters above maximum (p=${p} > ${SCRYPT_KDF_POLICY.maxP}). scrypt p too high.`,
      );
    }
  },
});

// The policy's production cost must itself be serviceable — enforced at module
// load so the invariant cannot silently rot behind a constant edit.
SCRYPT_KDF_POLICY.assertCostWithinLimits(
  SCRYPT_KDF_POLICY.production.n,
  SCRYPT_KDF_POLICY.production.r,
  SCRYPT_KDF_POLICY.production.p,
);

/**
 * The N actually used for NEW keystores. Initialized from the immutable policy;
 * only the test seam below may change it (production N ~ 256 MiB per derivation
 * OOMs CI workers running parallel shards). The production default itself lives
 * on `SCRYPT_KDF_POLICY.production` and cannot be reassigned.
 */
let activeScryptN = SCRYPT_KDF_POLICY.production.n;

/** @internal Allow tests to use lighter scrypt params to avoid memory limits */
export function _setScryptN(n: number) { activeScryptN = n; }

function deriveKey(
  passphrase: string,
  salt: Buffer,
  params?: { N?: number; r?: number; p?: number; dklen?: number },
): Buffer {
  return scryptSync(passphrase, salt, params?.dklen ?? SCRYPT_KDF_POLICY.requiredDklen, {
    N: params?.N ?? activeScryptN,
    r: params?.r ?? SCRYPT_KDF_POLICY.production.r,
    p: params?.p ?? SCRYPT_KDF_POLICY.production.p,
    maxmem: SCRYPT_KDF_POLICY.executionMaxmemBytes,
  });
}

export async function encryptKeystore(
  privateKeyHex: string,
  passphrase: string,
): Promise<EncryptedKeystore> {
  const salt = randomBytes(32);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(privateKeyHex, 'hex');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);

  return {
    version: 1,
    crypto: {
      cipher: 'aes-256-gcm',
      ciphertext: encrypted.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      kdf: 'scrypt',
      kdfparams: {
        n: activeScryptN,
        r: SCRYPT_KDF_POLICY.production.r,
        p: SCRYPT_KDF_POLICY.production.p,
        dklen: SCRYPT_KDF_POLICY.requiredDklen,
        salt: salt.toString('hex'),
      },
    },
    id,
  };
}

export async function decryptKeystore(
  keystore: EncryptedKeystore,
  passphrase: string,
): Promise<string> {
  if (keystore.version !== 1) {
    throw new Error(`Unsupported keystore version: ${keystore.version}`);
  }

  const { kdfparams } = keystore.crypto;

  // CLI-1 (
  // calling scryptSync. Previously, weak params either (a) produced a
  // generic "Decryption failed" (because `deriveKey` always re-derived
  // with the module-global N regardless of what the file advertised —
  // a related bug) or (b) handed pathological values to OpenSSL and
  // crashed with ERR_OUT_OF_RANGE. Either way the operator had no way
  // to know the keystore was forged with an attackable cost factor.
  // We now reject up-front with a crisp "weak keystore" error so the
  // caller can refuse to load the file instead of silently accepting
  // a downgraded KDF.
  if (typeof kdfparams.n !== "number" || kdfparams.n < SCRYPT_KDF_POLICY.minN) {
    throw new Error(
      `Refusing to load weak keystore: KDF parameters below minimum (n=${kdfparams.n} < ${SCRYPT_KDF_POLICY.minN}). scrypt cost too low.`,
    );
  }
  if (typeof kdfparams.r !== "number" || kdfparams.r < SCRYPT_KDF_POLICY.minR) {
    throw new Error(
      `Refusing to load weak keystore: KDF parameters below minimum (r=${kdfparams.r} < ${SCRYPT_KDF_POLICY.minR}). scrypt r too low.`,
    );
  }
  if (typeof kdfparams.p !== "number" || kdfparams.p < SCRYPT_KDF_POLICY.minP) {
    throw new Error(
      `Refusing to load weak keystore: KDF parameters below minimum (p=${kdfparams.p} < ${SCRYPT_KDF_POLICY.minP}). scrypt p too low.`,
    );
  }
  // Counterpart to the minimums above. Single policy owner — see
  // `SCRYPT_KDF_POLICY.assertCostWithinLimits`; nothing that could only fail
  // inside OpenSSL is allowed past this point.
  SCRYPT_KDF_POLICY.assertCostWithinLimits(kdfparams.n, kdfparams.r, kdfparams.p);
  if (kdfparams.dklen !== SCRYPT_KDF_POLICY.requiredDklen) {
    throw new Error(
      `Refusing to load weak keystore: dklen must be ${SCRYPT_KDF_POLICY.requiredDklen} for AES-256-GCM (got ${kdfparams.dklen}). invalid dklen.`,
    );
  }
  // compute saltHex into a local FIRST, defensively
  // falling back to '' for missing/non-string values. The previous
  // `kdfparams.salt.length / 2` expression in the throw message would
  // itself throw (TypeError: Cannot read properties of undefined) when
  // `salt` was missing or non-string — turning a "weak keystore"
  // validation error into an uncaught runtime crash that surfaced as
  // "scrypt failed" three call frames higher. Now the validator
  // reports the intended weak-keystore error in both cases.
  //
  // explicitly reject odd-length hex strings
  // before decoding. `Buffer.from('aa…', 'hex')` silently drops the
  // dangling nibble, so a 33-character salt would advertise 16.5 bytes
  // (>= SCRYPT_KDF_POLICY.minSaltBytes under integer division) and slip through the
  // length floor while actually deriving from a 16-byte salt with the
  // last nibble silently lost. We catch that here so the caller sees
  // the same "weak keystore" error class as other malformed values.
  const saltHex = typeof kdfparams.salt === 'string' ? kdfparams.salt : '';
  const saltHexLooksWellFormed =
    typeof kdfparams.salt === 'string'
    && /^[0-9a-f]*$/i.test(saltHex)
    && saltHex.length % 2 === 0;
  if (
    !saltHexLooksWellFormed
    || saltHex.length / 2 < SCRYPT_KDF_POLICY.minSaltBytes
  ) {
    const advertisedBytes = Math.floor(saltHex.length / 2);
    throw new Error(
      `Refusing to load weak keystore: salt too short or malformed (${advertisedBytes} bytes < ${SCRYPT_KDF_POLICY.minSaltBytes}). weak keystore.`,
    );
  }

  const salt = Buffer.from(kdfparams.salt, 'hex');
  // Derive with the params actually advertised by the file (now that
  // we've gated them above). The previous code ignored kdfparams and
  // always used the module-global N, which was both a correctness bug
  // (any keystore whose advertised N differed would fail to decrypt even with
  // the right passphrase) and the reason a weak-N keystore returned
  // "Decryption failed" instead of "weak keystore".
  const key = deriveKey(passphrase, salt, {
    N: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    dklen: kdfparams.dklen,
  });

  const iv = Buffer.from(keystore.crypto.iv, 'hex');
  const tag = Buffer.from(keystore.crypto.tag, 'hex');
  const ciphertext = Buffer.from(keystore.crypto.ciphertext, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('hex');
  } catch {
    throw new Error('Decryption failed — wrong passphrase or corrupted keystore');
  }
}

export function isEncryptedKeystore(obj: unknown): obj is EncryptedKeystore {
  if (!obj || typeof obj !== 'object') return false;
  const ks = obj as Record<string, unknown>;
  return ks.version === 1 && typeof ks.crypto === 'object' && ks.crypto !== null;
}
