import { isAbsolute, resolve } from 'node:path';

interface Rfc64PersistenceOwnerCapabilityStateV1 {
  readonly rfc64RootPath: string;
  readonly isLive: () => boolean;
}

const CAPABILITY_STATE = new WeakMap<object, Rfc64PersistenceOwnerCapabilityStateV1>();
declare const RFC64_PERSISTENCE_OWNER_CAPABILITY_BRAND: unique symbol;

/** Opaque runtime proof owned by the aggregate RFC-64 persistence lifecycle. */
export interface Rfc64PersistenceOwnerCapabilityV1 {
  readonly [RFC64_PERSISTENCE_OWNER_CAPABILITY_BRAND]: true;
}

/** @internal Mint only after the inventory foundation owns its DK6L lease. */
export function createRfc64PersistenceOwnerCapabilityV1(
  rfc64RootPathInput: string,
  isLive: () => boolean,
): Rfc64PersistenceOwnerCapabilityV1 {
  if (
    typeof rfc64RootPathInput !== 'string'
    || rfc64RootPathInput.length === 0
    || !isAbsolute(rfc64RootPathInput)
  ) {
    throw new TypeError('RFC-64 persistence owner root must be an absolute path');
  }
  if (typeof isLive !== 'function') {
    throw new TypeError('RFC-64 persistence owner liveness probe must be a function');
  }
  const capability = Object.freeze({}) as Rfc64PersistenceOwnerCapabilityV1;
  CAPABILITY_STATE.set(capability, Object.freeze({
    rfc64RootPath: resolve(rfc64RootPathInput),
    isLive,
  }));
  return capability;
}

/** @internal Validate the unforgeable capability and return its canonical root. */
export function readLiveRfc64PersistenceOwnerRootV1(
  capability: Rfc64PersistenceOwnerCapabilityV1,
): string {
  if (capability === null || typeof capability !== 'object') {
    throw new TypeError('RFC-64 persistence owner capability is missing');
  }
  const state = CAPABILITY_STATE.get(capability as object);
  if (state === undefined) {
    throw new TypeError('RFC-64 persistence owner capability was not minted locally');
  }
  if (!state.isLive()) {
    throw new TypeError('RFC-64 persistence owner capability is no longer live');
  }
  return state.rfc64RootPath;
}
