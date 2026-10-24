import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ExactAssetEncodedExportLease } from './exact-asset-export-cache.js';

/** Own validation, one-time publication, and response fencing through physical I/O. */
export function createEncodedResponseLease(
  value: Omit<ExactAssetEncodedExportLease, 'assertCurrent' | 'release'>,
  ownership: { assertCurrent(): Promise<void>; release(): void; publish?(): Promise<void> | void },
  errors: { changed(): Error; invalid(): Error },
): ExactAssetEncodedExportLease {
  const metadataDigest = bytesToHex(sha256(value.metadata)), bodyDigest = bytesToHex(sha256(value.body));
  let released = false, ownerReleased = false, activeFences = 0;
  let publication: Promise<void> | undefined, publicationStarted = false;
  const releaseOwner = () => {
    if (released && activeFences === 0 && !ownerReleased) {
      ownerReleased = true; ownership.release();
    }
  };
  const checkBytes = () => {
    if (released) throw errors.changed();
    if (bytesToHex(sha256(value.metadata)) !== metadataDigest || bytesToHex(sha256(value.body)) !== bodyDigest) throw errors.invalid();
  };
  const validate = async () => {
    if (released) throw errors.changed();
    await ownership.assertCurrent(); checkBytes();
  };
  return Object.freeze({ ...value,
    async assertCurrent() {
      activeFences++;
      try {
        await validate();
        if (!ownership.publish) return;
        checkBytes();
        if (!publicationStarted) {
          publicationStarted = true;
          // Invoke synchronously so the publisher copies verified bytes before yielding.
          try { publication = ownership.publish() || undefined; }
          catch (error) { publication = Promise.reject(error); }
        }
        // Only asynchronous persistence adds a physical I/O boundary.
        if (publication) { await publication; await validate(); }
        checkBytes();
      } finally { activeFences--; releaseOwner(); }
    },
    release() { released = true; releaseOwner(); },
  });
}
