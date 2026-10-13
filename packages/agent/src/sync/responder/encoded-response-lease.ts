import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ExactAssetEncodedExportLease } from './exact-asset-export-cache.js';

/** Response ownership and final fencing are independent of cache retention. */
export function createEncodedResponseLease(
  value: Omit<ExactAssetEncodedExportLease, 'assertCurrent' | 'release'>,
  ownership: { assertCurrent(): Promise<void>; release(): void },
  errors: { changed(): Error; invalid(): Error },
): ExactAssetEncodedExportLease {
  const metadataDigest = bytesToHex(sha256(value.metadata)), bodyDigest = bytesToHex(sha256(value.body));
  let released = false;
  const checkBytes = () => {
    if (bytesToHex(sha256(value.metadata)) !== metadataDigest || bytesToHex(sha256(value.body)) !== bodyDigest) throw errors.invalid();
  };
  return Object.freeze({ ...value,
    async assertCurrent() {
      if (released) throw errors.changed();
      await ownership.assertCurrent(); checkBytes();
    },
    release() { if (!released) { released = true; ownership.release(); } },
  });
}
