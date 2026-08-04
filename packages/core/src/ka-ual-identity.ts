/**
 * The single owner of the legacy/rootless Knowledge Asset UAL rule.
 *
 * V10 rootless KA ids pack the author address into the high 160 bits and the
 * per-author KA number into the low 96 bits, so their canonical identity is
 * author/number. Legacy sequential ids have no author bits and keep the older
 * storage-contract/id form. Which branch applies is decided by `kaId >> 96n`.
 *
 * This lives in `core` because it is the lowest package that every consumer can
 * reach: `agent → chain → core`. An earlier revision restated the rule inside
 * `vm-update-convergence.ts` and guarded the copy with a cross-package parity
 * test. That test does detect drift — but only after it exists, and it left two
 * production implementations of one identity rule to keep in step. The rule now
 * has one home and `buildReconciledKnowledgeAssetUal` delegates to it.
 */
import { parseCanonicalDecimalU256 } from './sync-wire-scalars.js';

/** `(1 << 96) - 1` — the rootless KA-number field width. */
export const MAX_ROOTLESS_KA_NUMBER_V1 = (1n << 96n) - 1n;
/** Upper bound of the on-chain id domain. */
export const MAX_KA_ID_V1 = (1n << 256n) - 1n;

const EVM_ADDRESS_ANY_CASE = /^0x[0-9a-fA-F]{40}$/;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export class KaUalIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KaUalIdentityError';
  }
}

/**
 * A canonical UAL chain id: optional lowercase namespace, canonical decimal tail.
 *
 * NOT the numeric EVM chain id. `ChainAdapter.chainId` is namespaced —
 * `base:84532`, `otp:20430`, `evm:31337` — and its own doc comment says it is
 * "not directly parseable with `BigInt()`".
 */
export function assertCanonicalUalChainIdV1(value: unknown, label = 'chainId'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new KaUalIdentityError(`${label} must be a nonempty string`);
  }
  const separator = value.lastIndexOf(':');
  const namespace = separator === -1 ? '' : value.slice(0, separator);
  const decimal = separator === -1 ? value : value.slice(separator + 1);
  if (separator !== -1 && !/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/.test(namespace)) {
    throw new KaUalIdentityError(`${label} namespace must be lowercase alphanumeric`);
  }
  if (!CANONICAL_UNSIGNED_DECIMAL.test(decimal)) {
    throw new KaUalIdentityError(`${label} must end in a canonical decimal chain number`);
  }
  try {
    parseCanonicalDecimalU256(decimal, label);
  } catch (cause) {
    throw new KaUalIdentityError(`${label} is not a canonical u256 chain number`, { cause });
  }
  return value;
}

/**
 * Build the canonical UAL for a resolved on-chain KA id.
 *
 * The address is **normalized to lowercase**, not rejected for case. That is
 * deliberate and is what a builder should do: the output is canonical either
 * way, and the sole production caller passes an address straight from
 * `getDKGKnowledgeAssetsAddress()`, which returns the checksummed form. The
 * strictness belongs on the PARSE side — accepting a mixed-case address when
 * turning a UAL back into candidates would make two spellings denote one KA —
 * and that is enforced separately in `vm-update-convergence.ts`.
 *
 * Genuinely invalid input still fails: a non-address string, a negative id, an
 * id above uint256, or a noncanonical chain id.
 */
export function buildKnowledgeAssetUalFromOnChainIdV1(
  chainId: string,
  legacyStorageAddress: string,
  kaId: bigint,
): string {
  const canonicalChain = assertCanonicalUalChainIdV1(chainId, 'ual chainId');
  if (typeof legacyStorageAddress !== 'string' || !EVM_ADDRESS_ANY_CASE.test(legacyStorageAddress)) {
    throw new KaUalIdentityError('ual storage address must be a 20-byte 0x EVM address');
  }
  if (typeof kaId !== 'bigint') throw new KaUalIdentityError('kaId must be a bigint');
  if (kaId < 0n) throw new KaUalIdentityError('kaId must not be negative');
  if (kaId > MAX_KA_ID_V1) throw new KaUalIdentityError('kaId exceeds uint256');

  if (kaId >> 96n === 0n) {
    return `did:dkg:${canonicalChain}/${legacyStorageAddress.toLowerCase()}/${kaId.toString()}`;
  }
  const authorAddress = `0x${(kaId >> 96n).toString(16).padStart(40, '0')}`;
  const kaNumber = kaId & MAX_ROOTLESS_KA_NUMBER_V1;
  return `did:dkg:${canonicalChain}/${authorAddress}/${kaNumber.toString()}`;
}
